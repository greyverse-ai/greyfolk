/**
 * The agent: one harness served through the OpenAI Responses profile (spec §2, §3, §4, §5).
 *
 * Owns the turn state machine (one turn at a time; a turn is a chain of responses), maps
 * harness events to Responses stream events, carries steer / cancel / permission requests,
 * and gates export and reset on being fully idle.
 */
import type { Harness, HarnessEvent, HarnessInputItem, PermissionDecision, PermissionRequestHandler, SubagentResult, TurnRequest } from "../harness/types.js";
import { SessionStore, type HeldResult } from "../session/store.js";
import { translateMcpTools, bridgeScriptPath } from "../mcp/translate.js";
import { ApiError } from "./errors.js";
import { itemHash, normaliseInput, selectNewItems } from "./input.js";
import { ResponseRecord, ResponseStore, newId } from "./responses.js";
import type { CreateRequest, McpCallOutputItem, MessageOutputItem, OutputItem, ResponseObject, StreamEvent } from "./types.js";

export type ModelPolicy = "fixed" | "request";

export interface AgentOptions {
  /** Builds a harness for the given session id (null = new session). */
  harnessFactory: (sessionId: string | null) => Harness;
  store: SessionStore;
  modelPolicy: ModelPolicy;
  /** Where a reset archives the old session (outside the agent folder). */
  resetArchiveDir: string;
  nodeExecutable?: string;
  bridgeScript?: string;
}

interface PendingPermission {
  id: string;
  responseId: string;
  resolve: (d: PermissionDecision) => void;
}

interface TurnState {
  turnId: string;
  /** The id of the turn's first response: the caller's name for the turn (spec §2, §5). */
  firstResponseId: string;
  current: ResponseRecord;
  instructions: string | null;
  model: string;
  tools: CreateRequest["tools"];
  background: boolean;
  metadata: Record<string, string>;
  /** Open assistant message item, if text is streaming. */
  message: { item: MessageOutputItem; index: number } | null;
  openCalls: Map<string, { item: McpCallOutputItem; index: number }>;
  pendingSteers: Map<string, { resolve: (r: "taken_in" | "response_ended") => void }>;
  finished: Promise<void>;
  cancelRequested: boolean;
}

export type ChainSubscriber = (record: ResponseRecord, event: StreamEvent) => void;

export class Agent {
  readonly responses = new ResponseStore();
  private harness: Harness;
  private readonly opts: AgentOptions;
  private turn: TurnState | null = null;
  private readonly permissions = new Map<string, PendingPermission>();
  private closed = false;
  /** Running subagent id → first response id of the turn that spawned it. */
  private readonly spawnedBy = new Map<string, string>();
  /** Held subagent results, keyed by the first response id of the spawning turn (spec §5). */
  private held: Record<string, HeldResult[]> = {};

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.harness = this.attachHarness(opts.harnessFactory(null));
  }

  private attachHarness(h: Harness): Harness {
    h.onLateSubagentResult((result) => this.takeLateSubagentResult(result));
    return h;
  }

  get harnessName(): string {
    return this.harness.name;
  }

  async init(): Promise<void> {
    await this.opts.store.init();
    const sessionId = await this.opts.store.readSessionId();
    this.harness = this.attachHarness(this.opts.harnessFactory(sessionId));
    await this.harness.prepare();
    this.held = await this.opts.store.readHeld();
    const inflight = await this.opts.store.readInflight();
    if (inflight) {
      this.responses.registerFailed(inflight, "The instance stopped while this response was running; the session resumed without it.");
      await this.opts.store.writeInflight(null);
    }
  }

  // ---- create -------------------------------------------------------------

  async create(req: CreateRequest): Promise<ResponseRecord> {
    if (this.closed) throw new ApiError(503, "server_error", "greyfolk is shutting down.");
    if (this.turn) throw ApiError.busy("A turn is in progress; steer it or wait for it to end.");
    if (req.previous_response_id !== null && !this.responses.isInLatestTurn(req.previous_response_id)) {
      throw ApiError.invalid(
        "previous_response_id must name the latest turn; this session has one thread and no branches.",
        "previous_response_not_latest",
        "previous_response_id",
      );
    }
    for (const t of req.deliver_held) {
      if (!this.held[t]) throw ApiError.invalid(`No held subagent results for turn '${t}'.`, "unknown_held_turn", "greyfolk.deliver_held");
    }
    const items = normaliseInput(req.input);
    const fresh = selectNewItems(items, (h) => this.opts.store.hasSeen(h));
    if (fresh.length === 0 && req.deliver_held.length === 0) {
      throw ApiError.invalid("No new input: every input item is already held by the session.", "no_new_input", "input");
    }
    const delivered = req.deliver_held.map((turn) => ({ turn, results: this.held[turn]! }));
    const heldItems = delivered.flatMap(({ turn, results }) => results.map((r) => heldResultItem(turn, r)));
    const mcp = translateMcpTools(req.tools, {
      nodeExecutable: this.opts.nodeExecutable ?? process.execPath,
      bridgeScript: this.opts.bridgeScript ?? bridgeScriptPath(),
    });
    const model = this.resolveModel(req.model);

    const turnId = newId("turn");
    const response = this.newResponse(req, model, null);
    const record = this.responses.create(response, turnId);
    const turn: TurnState = {
      turnId,
      firstResponseId: record.id,
      current: record,
      instructions: req.instructions,
      model,
      tools: req.tools,
      background: req.background,
      metadata: req.metadata,
      message: null,
      openCalls: new Map(),
      pendingSteers: new Map(),
      finished: Promise.resolve(),
      cancelRequested: false,
    };
    this.turn = turn;
    await this.opts.store.writeInflight(record.id);
    await this.opts.store.markSeen(items.map(itemHash));

    if (delivered.length > 0) {
      for (const { turn: t } of delivered) delete this.held[t];
      await this.opts.store.writeHeld(this.held);
    }

    record.emit("response.created", { response: this.snapshot(record) });
    record.emit("response.in_progress", { response: this.snapshot(record) });
    if (delivered.length > 0) record.emit("greyfolk.held_delivered", { response_id: record.id, turns: structuredClone(delivered) });

    const turnRequest: TurnRequest = {
      responseId: record.id,
      input: [...heldItems, ...fresh],
      instructions: req.instructions,
      model: this.opts.modelPolicy === "request" ? req.model : null,
      mcp,
      onPermissionRequest: this.permissionHandler(turn),
    };
    turn.finished = this.runTurn(turn, turnRequest);
    return record;
  }

  private resolveModel(requested: string | null): string {
    const own = this.harness.status().model;
    if (this.opts.modelPolicy === "request" && requested) {
      if (!this.harness.modelFamily.test(requested)) {
        throw ApiError.invalid(`Model '${requested}' is not in the ${this.harness.name} harness's family.`, "model_not_in_family", "model");
      }
      return requested;
    }
    return own ?? requested ?? "default";
  }

  private newResponse(req: Pick<CreateRequest, "instructions" | "tools" | "background" | "metadata">, model: string, previous: string | null): ResponseObject {
    return {
      id: newId("resp"),
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      completed_at: null,
      status: "in_progress",
      error: null,
      incomplete_details: null,
      instructions: req.instructions,
      model,
      output: [],
      previous_response_id: previous,
      tools: req.tools,
      usage: null,
      background: req.background,
      metadata: req.metadata,
    };
  }

  private snapshot(record: ResponseRecord): ResponseObject {
    return structuredClone(record.response);
  }

  // ---- the run loop -------------------------------------------------------

  private async runTurn(turn: TurnState, req: TurnRequest): Promise<void> {
    let final: Extract<HarnessEvent, { type: "done" }> | null = null;
    try {
      for await (const ev of this.harness.startTurn(req)) {
        if (ev.type === "session") {
          await this.opts.store.writeSessionId(ev.sessionId);
          continue;
        }
        if (ev.type === "done") {
          final = ev;
          break;
        }
        this.applyEvent(turn, ev);
      }
      if (!final) final = { type: "done", status: "failed", error: "The harness ended the turn without a result.", usage: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      final = { type: "done", status: turn.cancelRequested ? "cancelled" : "failed", error: message, usage: null };
    }
    // Settle the turn state *before* the terminal event goes out, so a subscriber that sees
    // `response.completed` finds the agent idle and the inflight marker cleared.
    for (const s of turn.pendingSteers.values()) s.resolve("response_ended");
    turn.pendingSteers.clear();
    for (const p of [...this.permissions.values()]) {
      if (this.responses.get(p.responseId)?.turnId === turn.turnId) {
        p.resolve("deny");
        this.permissions.delete(p.id);
      }
    }
    this.turn = null;
    try {
      await this.opts.store.writeInflight(null);
    } catch {
      /* the marker is advisory; the response still ends */
    }
    this.endResponse(turn, final);
  }

  private applyEvent(turn: TurnState, ev: HarnessEvent): void {
    const rec = turn.current;
    switch (ev.type) {
      case "text_delta": {
        const m = this.openMessage(turn);
        m.item.content[0]!.text += ev.text;
        rec.emit("response.output_text.delta", { item_id: m.item.id, output_index: m.index, content_index: 0, delta: ev.text });
        return;
      }
      case "message_done": {
        const m = this.openMessage(turn);
        const part = m.item.content[0]!;
        if (part.text !== ev.text) {
          const delta = ev.text.startsWith(part.text) ? ev.text.slice(part.text.length) : ev.text;
          if (delta) rec.emit("response.output_text.delta", { item_id: m.item.id, output_index: m.index, content_index: 0, delta });
          part.text = ev.text;
        }
        rec.emit("response.output_text.done", { item_id: m.item.id, output_index: m.index, content_index: 0, text: part.text });
        rec.emit("response.content_part.done", { item_id: m.item.id, output_index: m.index, content_index: 0, part: structuredClone(part) });
        m.item.status = "completed";
        rec.emit("response.output_item.done", { output_index: m.index, item: structuredClone(m.item) });
        turn.message = null;
        return;
      }
      case "reasoning": {
        this.closeMessage(turn, "completed");
        const item: OutputItem = { id: newId("rs"), type: "reasoning", status: "completed", summary: [{ type: "summary_text", text: ev.text }] };
        const index = rec.response.output.push(item) - 1;
        rec.emit("response.output_item.added", { output_index: index, item: structuredClone(item) });
        rec.emit("response.output_item.done", { output_index: index, item: structuredClone(item) });
        return;
      }
      case "tool_call": {
        this.closeMessage(turn, "completed");
        const item: McpCallOutputItem = {
          id: newId("mcp"),
          type: "mcp_call",
          status: "in_progress",
          server_label: ev.server ?? `greyfolk.${this.harness.name}`,
          name: ev.name,
          arguments: typeof ev.arguments === "string" ? ev.arguments : JSON.stringify(ev.arguments ?? {}),
          output: null,
          error: null,
        };
        const index = rec.response.output.push(item) - 1;
        turn.openCalls.set(ev.id, { item, index });
        rec.emit("response.output_item.added", { output_index: index, item: structuredClone(item) });
        rec.emit("response.mcp_call.in_progress", { output_index: index, item_id: item.id });
        return;
      }
      case "tool_result": {
        const open = turn.openCalls.get(ev.id);
        if (!open) return;
        turn.openCalls.delete(ev.id);
        open.item.output = ev.output;
        open.item.error = ev.error;
        open.item.status = ev.error === null ? "completed" : "failed";
        rec.emit(ev.error === null ? "response.mcp_call.completed" : "response.mcp_call.failed", { output_index: open.index, item_id: open.item.id });
        rec.emit("response.output_item.done", { output_index: open.index, item: structuredClone(open.item) });
        return;
      }
      case "steer_taken_in": {
        this.commitSteer(turn, ev.steerId);
        return;
      }
      case "subagent_started": {
        this.spawnedBy.set(ev.id, turn.firstResponseId);
        rec.emit("greyfolk.subagent_started", { id: ev.id, turn: turn.firstResponseId, description: ev.description });
        return;
      }
      case "subagent_finished": {
        // Inside its turn the engine itself feeds the result to the model; greyfolk only reports it.
        this.spawnedBy.delete(ev.result.id);
        rec.emit("greyfolk.subagent_finished", { id: ev.result.id, turn: turn.firstResponseId, status: ev.result.status });
        return;
      }
    }
  }

  // ---- held subagent results (spec §5) -----------------------------------

  /**
   * A subagent result that arrives when no response is running: no model step may run for it
   * outside a response, so it is held under the turn that spawned it until a request names that turn.
   */
  private takeLateSubagentResult(result: SubagentResult): void {
    const turn = this.spawnedBy.get(result.id) ?? "unknown";
    this.spawnedBy.delete(result.id);
    if (this.turn && this.turn.firstResponseId === turn) {
      // Still the same turn (the harness reported it between model steps): the engine carries it.
      this.applyEvent(this.turn, { type: "subagent_finished", result });
      return;
    }
    const entry: HeldResult = { id: result.id, status: result.status, output: result.output, at: new Date().toISOString() };
    (this.held[turn] ??= []).push(entry);
    this.opts.store.writeHeld(this.held).catch(() => {});
  }

  /** `status.held`: one entry per turn with results waiting (spec §5). */
  heldSummary(): { turn: string; count: number }[] {
    return Object.entries(this.held).map(([turn, results]) => ({ turn, count: results.length }));
  }

  private openMessage(turn: TurnState): { item: MessageOutputItem; index: number } {
    if (turn.message) return turn.message;
    const rec = turn.current;
    const item: MessageOutputItem = { id: newId("msg"), type: "message", role: "assistant", status: "in_progress", content: [{ type: "output_text", text: "", annotations: [] }] };
    const index = rec.response.output.push(item) - 1;
    turn.message = { item, index };
    rec.emit("response.output_item.added", { output_index: index, item: structuredClone(item) });
    rec.emit("response.content_part.added", { item_id: item.id, output_index: index, content_index: 0, part: structuredClone(item.content[0]) });
    return turn.message;
  }

  private closeMessage(turn: TurnState, status: "completed" | "incomplete"): void {
    const m = turn.message;
    if (!m) return;
    const rec = turn.current;
    const part = m.item.content[0]!;
    rec.emit("response.output_text.done", { item_id: m.item.id, output_index: m.index, content_index: 0, text: part.text });
    rec.emit("response.content_part.done", { item_id: m.item.id, output_index: m.index, content_index: 0, part: structuredClone(part) });
    m.item.status = status;
    rec.emit("response.output_item.done", { output_index: m.index, item: structuredClone(m.item) });
    turn.message = null;
  }

  /** The model step that received the steer: the running response ends `incomplete` (steered) and a successor continues the turn. */
  private commitSteer(turn: TurnState, steerId: string): void {
    const prev = turn.current;
    this.closeMessage(turn, "incomplete");
    for (const [, open] of turn.openCalls) {
      open.item.status = "failed";
      open.item.error = "steered";
      prev.emit("response.output_item.done", { output_index: open.index, item: structuredClone(open.item) });
    }
    turn.openCalls.clear();

    const successor = this.responses.create(this.newResponse(turn, turn.model, prev.id), turn.turnId);
    prev.nextResponseId = successor.id;
    this.rememberOutput(prev);
    prev.emit("response.steer.taken_in", { steer: { id: steerId, previous_response_id: prev.id }, next_response_id: successor.id });
    prev.response.status = "incomplete";
    prev.response.incomplete_details = { reason: "steered" };
    prev.response.completed_at = Math.floor(Date.now() / 1000);
    prev.emit("response.incomplete", { response: this.snapshot(prev) });

    turn.current = successor;
    this.opts.store.writeInflight(successor.id).catch(() => {});
    successor.emit("response.created", { response: this.snapshot(successor) });
    successor.emit("response.in_progress", { response: this.snapshot(successor) });
    turn.pendingSteers.get(steerId)?.resolve("taken_in");
    turn.pendingSteers.delete(steerId);
  }

  /** Records the assistant messages of a response as held by the session, so a resent history is not fed again. */
  private rememberOutput(rec: ResponseRecord): void {
    const hashes = rec.response.output
      .filter((o): o is MessageOutputItem => o.type === "message")
      .map((m) => itemHash({ role: "assistant", text: m.content.map((c) => c.text).join("\n") }));
    if (hashes.length) this.opts.store.markSeen(hashes).catch(() => {});
  }

  private endResponse(turn: TurnState, ev: Extract<HarnessEvent, { type: "done" }>): void {
    const rec = turn.current;
    if (rec.ended) return;
    this.rememberOutput(rec);
    this.closeMessage(turn, ev.status === "completed" ? "completed" : "incomplete");
    for (const [, open] of turn.openCalls) {
      open.item.status = "failed";
      open.item.error = ev.status;
      rec.emit("response.output_item.done", { output_index: open.index, item: structuredClone(open.item) });
    }
    turn.openCalls.clear();
    rec.response.completed_at = Math.floor(Date.now() / 1000);
    rec.response.usage = ev.usage;
    if (ev.status === "completed") {
      rec.response.status = "completed";
      rec.emit("response.completed", { response: this.snapshot(rec) });
    } else if (ev.status === "cancelled") {
      rec.response.status = "cancelled";
      rec.emit("response.cancelled", { response: this.snapshot(rec) });
    } else {
      rec.response.status = "failed";
      rec.response.error = { code: "harness_error", message: ev.error ?? "The harness failed." };
      rec.emit("response.failed", { response: this.snapshot(rec) });
    }
  }

  // ---- steer / cancel -----------------------------------------------------

  /**
   * Standard mid-turn steering. Resolves `taken_in` when the model step received the input
   * (the successor's `response.created` marks it in stream order) or `response_ended` when too late.
   */
  async steer(previousResponseId: string, input: unknown): Promise<{ steerId: string; result: Promise<"taken_in" | "response_ended">; record: ResponseRecord | null }> {
    const items = normaliseInput(input).map<HarnessInputItem>((it) => {
      if (it.role === "assistant") throw ApiError.invalid("Steer input must be user input.", "unsupported_input", "input");
      return { role: it.role, text: it.text };
    });
    const steerId = newId("steer");
    const turn = this.turn;
    const rec = this.responses.get(previousResponseId) ?? null;
    if (!rec) throw ApiError.notFound(`Response '${previousResponseId}' not found.`, "previous_response_id");
    const failNow = (live: ResponseRecord | null): { steerId: string; result: Promise<"taken_in" | "response_ended">; record: ResponseRecord | null } => {
      if (live && !live.ended) {
        live.emit("response.steer.failed", {
          steer: { id: steerId, previous_response_id: previousResponseId },
          error: { type: "invalid_request_error", code: "response_ended", message: "The response ended before the input could be taken in; start a new turn." },
        });
      }
      return { steerId, result: Promise.resolve("response_ended"), record: live };
    };
    if (!turn || rec.turnId !== turn.turnId || turn.cancelRequested) return failNow(rec.ended ? null : rec);
    if (!this.harness.capabilities.midTurnInput) return failNow(turn.current);
    const current = turn.current;
    current.emit("response.steer.accepted", { steer: { id: steerId, previous_response_id: previousResponseId } });
    const settled = new Promise<"taken_in" | "response_ended">((resolve) => turn.pendingSteers.set(steerId, { resolve }));
    const result = this.harness
      .steer(steerId, items)
      .then((r) => {
        if (r === "response_ended") {
          turn.pendingSteers.get(steerId)?.resolve("response_ended");
          turn.pendingSteers.delete(steerId);
        }
        return settled;
      })
      .catch(() => {
        turn.pendingSteers.get(steerId)?.resolve("response_ended");
        turn.pendingSteers.delete(steerId);
        return settled;
      });
    result.then((r) => {
      if (r === "response_ended") {
        const target = this.responses.get(previousResponseId) ?? current;
        const live = target.ended ? current : target;
        const emitter = live.ended ? null : live;
        emitter?.emit("response.steer.failed", {
          steer: { id: steerId, previous_response_id: previousResponseId },
          error: { type: "invalid_request_error", code: "response_ended", message: "The response ended before the input could be taken in; start a new turn." },
        });
      }
    });
    return { steerId, result, record: current };
  }

  /** Cancels the response's turn if it is running; returns the (possibly already ended) response. */
  async cancel(responseId: string): Promise<ResponseRecord> {
    const rec = this.responses.get(responseId);
    if (!rec) throw ApiError.notFound(`Response '${responseId}' not found.`, "response_id");
    const turn = this.turn;
    if (!turn || rec.turnId !== turn.turnId) return rec;
    turn.cancelRequested = true;
    for (const p of [...this.permissions.values()]) {
      if (this.responses.get(p.responseId)?.turnId === turn.turnId) {
        p.resolve("deny");
        this.permissions.delete(p.id);
      }
    }
    await this.harness.cancel();
    await turn.finished;
    return this.responses.get(responseId) ?? rec;
  }

  /** Cancels when the creating stream closes and the response is not `background`. */
  async cancelIfForeground(responseId: string): Promise<void> {
    const rec = this.responses.get(responseId);
    if (!rec || rec.response.background || rec.ended) return;
    if (!this.turn || rec.turnId !== this.turn.turnId) return;
    await this.cancel(responseId);
  }

  // ---- permissions --------------------------------------------------------

  private permissionHandler(turn: TurnState): PermissionRequestHandler {
    return ({ tool, operation, signal }) =>
      new Promise<PermissionDecision>((resolve) => {
        const id = newId("perm");
        const responseId = turn.current.id;
        const pending: PendingPermission = { id, responseId, resolve };
        this.permissions.set(id, pending);
        signal.addEventListener("abort", () => {
          if (this.permissions.delete(id)) resolve("deny");
        });
        turn.current.emit("greyfolk.permission_request", { id, response_id: responseId, tool, operation });
      });
  }

  decidePermission(id: string, decision: PermissionDecision): { id: string; decision: PermissionDecision } {
    const pending = this.permissions.get(id);
    if (!pending) throw ApiError.notFound(`Permission request '${id}' is not waiting.`, "id");
    this.permissions.delete(id);
    pending.resolve(decision);
    return { id, decision };
  }

  // ---- status / export / reset / history ---------------------------------

  status(): Record<string, unknown> {
    const h = this.harness.status();
    const busy = this.turn !== null || h.state === "running" || h.subagents.running > 0;
    return {
      state: busy ? "busy" : "idle",
      harness: this.harness.name,
      model: h.model,
      session_id: h.sessionId,
      turn: this.turn ? { id: this.turn.turnId, response_id: this.turn.current.id, responses: this.responses.latestTurn()?.responses ?? [] } : null,
      subagents: { running: h.subagents.running, lost: h.subagents.lost },
      subagent_profile: { name: h.subagentProfile.name, applied: h.subagentProfile.applied },
      held: this.heldSummary(),
      permission_requests: [...this.permissions.values()].map((p) => ({ id: p.id, response_id: p.responseId })),
    };
  }

  private assertIdle(action: string): void {
    const s = this.status();
    if (s.state !== "idle") throw ApiError.busy(`Cannot ${action} while a response or subagents are running.`, "not_idle");
  }

  async export(dest: string): Promise<{ dest: string; excluded: string[] }> {
    this.assertIdle("export");
    const excluded = this.harness.exportExcludes();
    await this.opts.store.export(dest, excluded);
    return { dest, excluded };
  }

  async reset(): Promise<{ archived_to: string }> {
    this.assertIdle("reset");
    await this.harness.close();
    const archivedTo = await this.opts.store.reset(this.harness.sessionPaths(), this.opts.resetArchiveDir);
    this.harness = this.attachHarness(this.opts.harnessFactory(null));
    await this.harness.prepare();
    this.held = {};
    this.spawnedBy.clear();
    return { archived_to: archivedTo };
  }

  history(): ReturnType<Harness["history"]> {
    return this.harness.history();
  }

  /** Streams a response and, after it ends `incomplete` (steered), its successors in the same turn. */
  subscribeChain(responseId: string, startingAfter: number, sub: ChainSubscriber): () => void {
    let unsub: () => void = () => {};
    let active = true;
    const attach = (rec: ResponseRecord, after: number): void => {
      unsub = rec.subscribe(after, (ev) => {
        if (!active) return;
        sub(rec, ev);
        if (ev.type === "response.incomplete" && rec.nextResponseId) {
          const next = this.responses.get(rec.nextResponseId);
          if (next) queueMicrotask(() => active && attach(next, -1));
        }
      });
    };
    const rec = this.responses.get(responseId);
    if (!rec) throw ApiError.notFound(`Response '${responseId}' not found.`, "response_id");
    attach(rec, startingAfter);
    return () => {
      active = false;
      unsub();
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.turn) {
      const id = this.turn.current.id;
      await this.cancel(id).catch(() => {});
    }
    await this.harness.close();
  }
}

/** How a held subagent result reaches the model: one developer item per result, naming its turn. */
function heldResultItem(turn: string, r: HeldResult): HarnessInputItem {
  return {
    role: "developer",
    text: `[subagent result] turn=${turn} subagent=${r.id} status=${r.status} finished_at=${r.at}\n${r.output}`,
  };
}
