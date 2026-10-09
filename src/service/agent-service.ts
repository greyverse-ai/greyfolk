/**
 * The service: the OpenAI Responses API for one agent (spec §2, §3, §4, §5), with one engine as
 * its strategy. It runs the turn state machine (one turn at a time; a turn is a chain of
 * responses), steer, cancel, permission requests and the idle gates for export and reset. It knows no engine; the engine writes its output into the turn.
 */
import type { AgentStatus, CreateParams, AgentResponse, HistoryMessage, McpTool, PermissionDecision, ResponseSteerInput, ResponsesApi, SteerOutcome, SteerResult, StreamListener } from "../api/types.js";
import { ApiError } from "../api/errors.js";
import { normaliseInput, parseCreateRequest, type InputMessage } from "../api/input.js";
import { PermissionBridge } from "../common/permission-bridge.js";
import { newId, ResponseLog, type ResponseRecord } from "../common/response-log.js";
import { SessionRecord } from "../common/session-record.js";
import { Turn, type TurnEnd } from "../common/turn.js";
import type { McpAttachment } from "../mcp/translate.js";
import type { Engine } from "../engine/engine.js";

export type ModelPolicy = "fixed" | "request";

export interface AgentServiceOptions {
  /** Builds the engine (again after a reset). */
  createEngine: () => Engine;
  agentDir: string;
  modelPolicy: ModelPolicy;
  /** Where a reset archives the old session (outside the agent folder). */
  resetArchiveDir: string;
  /** The starter's subagent profile name (shown in status). */
  subagentProfileName?: string | null;
  /** Turns a request's MCP tools into transports the engine attaches (spec §4). */
  attachTools: (tools: McpTool[]) => McpAttachment[];
}

const STEER_TOO_LATE = { type: "invalid_request_error", code: "response_not_active", message: "The response ended before the input could be taken in; start a new turn." } as const;

export class AgentService implements ResponsesApi {
  private readonly opts: AgentServiceOptions;
  private readonly log = new ResponseLog();
  private readonly record: SessionRecord;
  private readonly permissions = new PermissionBridge();
  private engineImpl: Engine;
  private turn: Turn | null = null;
  private finished: Promise<void> = Promise.resolve();
  private closed = false;
  /** A reset or export is running; no turn may start meanwhile. */
  private maintenance: string | null = null;
  /** The newest response before this process started (`.greyfolk/latest`). */
  private persistedLatest: string | null = null;

  constructor(opts: AgentServiceOptions) {
    this.opts = opts;
    this.record = new SessionRecord(opts.agentDir);
    this.engineImpl = opts.createEngine();
  }

  get engine(): string {
    return this.engineImpl.name;
  }

  async init(): Promise<void> {
    await this.record.init();
    await this.engineImpl.start(await this.record.readSessionId());
    this.persistedLatest = await this.record.readLatest();
    const inflight = await this.record.readInflight();
    if (inflight) {
      this.log.registerFailed(inflight, "The instance stopped while this response was running; the session resumed without it.");
      await this.record.writeInflight(null);
    }
  }

  // ---- create -------------------------------------------------------------

  async create(params: CreateParams): Promise<AgentResponse> {
    if (this.closed) throw new ApiError(503, "server_error", "greyfolk is shutting down.");
    const req = parseCreateRequest(params);
    if (this.turn) throw ApiError.busy("A turn is in progress; steer it or wait for it to end.");
    if (this.maintenance) throw ApiError.busy(`A ${this.maintenance} is running; try again when it is done.`, "not_idle");
    if (req.previous_response_id !== null && req.previous_response_id !== (this.log.latestResponseId() ?? this.persistedLatest)) {
      throw ApiError.invalid("previous_response_id must name the latest response; this session has one thread and no branches.", "previous_response_not_latest", "previous_response_id");
    }
    if (req.input.length === 0) {
      throw ApiError.invalid("No new input: the input holds nothing after the conversation's last assistant message.", "no_new_input", "input");
    }
    req.tools.forEach((t, i) => {
      if (t.require_approval !== "never" && !this.engineImpl.canAskApproval) {
        throw ApiError.invalid(`The ${this.engine} engine cannot ask before an MCP tool runs; set require_approval to "never".`, "unsupported_tool", `tools[${i}].require_approval`);
      }
    });
    const mcp = this.opts.attachTools(req.tools);
    const model = this.resolveModel(req.model);

    const turn = new Turn(
      { log: this.log, record: this.record, permissions: this.permissions, nativeToolLabel: `greyfolk.${this.engine}` },
      { instructions: req.instructions, model, tools: req.tools.map(withoutCredentials), background: req.background, metadata: req.metadata },
    );
    // Everything up to `this.finished` is synchronous, so a cancel that arrives right after
    // create always finds this turn and waits for it.
    this.turn = turn;
    turn.open();
    const snapshot = turn.current.snapshot();
    this.finished = this.runTurn(turn, {
      input: req.input,
      instructions: req.instructions,
      model: this.opts.modelPolicy === "request" ? req.model : null,
      mcp,
    });
    return snapshot;
  }

  private resolveModel(requested: string | null): string {
    const own = this.engineImpl.state().model;
    if (this.opts.modelPolicy === "request" && requested) {
      if (!this.engineImpl.modelFamily.test(requested)) {
        throw ApiError.invalid(`Model '${requested}' is not in the ${this.engine} engine's family.`, "model_not_in_family", "model");
      }
      return requested;
    }
    return own ?? requested ?? "default";
  }

  private async runTurn(turn: Turn, req: Parameters<Engine["run"]>[1]): Promise<void> {
    let end: TurnEnd;
    try {
      await this.record.writeInflight(turn.current.id);
      end = turn.cancelRequested ? { status: "cancelled", error: null, usage: null } : await this.engineImpl.run(turn, req);
    } catch (err) {
      end = { status: turn.cancelRequested ? "cancelled" : "failed", error: err instanceof Error ? err.message : String(err), usage: null };
    }
    if (turn.cancelRequested && end.status === "failed") end = { ...end, status: "cancelled" };
    // Settle the turn *before* the terminal event goes out, so a subscriber that sees
    // `response.completed` finds the agent idle and the inflight marker cleared.
    turn.steers.endAll();
    this.permissions.denyTurn(turn.id);
    await this.record.writeInflight(null).catch(() => {});
    await this.record.writeLatest(turn.current.id).catch(() => {});
    this.turn = null;
    turn.end(end);
  }

  // ---- stream / retrieve --------------------------------------------------

  stream(responseId: string, startingAfter: number, listener: StreamListener): () => void {
    const unsub = this.log.subscribeChain(responseId, startingAfter, listener);
    if (!unsub) throw ApiError.notFound(`Response '${responseId}' not found.`, "response_id");
    return unsub;
  }

  retrieve(responseId: string): AgentResponse {
    return this.recordOf(responseId).snapshot();
  }

  private recordOf(responseId: string, param = "response_id"): ResponseRecord {
    const rec = this.log.get(responseId);
    if (!rec) throw ApiError.notFound(`Response '${responseId}' not found.`, param);
    return rec;
  }

  // ---- steer / cancel -----------------------------------------------------

  /**
   * Standard mid-turn steering. `taken_in` when the model step received the input (the
   * successor's `response.created` marks it in stream order), `response_ended` when too late.
   */
  async steer(previousResponseId: string, input: ResponseSteerInput): Promise<SteerOutcome> {
    const items: InputMessage[] = normaliseInput(input).map((it) => {
      if (it.role !== "user") throw ApiError.invalid("Steer input must be user messages.", "invalid_input", "input");
      return { type: "message", role: "user", content: it.text };
    });
    if (items.length === 0 || items.every((i) => !i.content)) throw ApiError.invalid("Steer input must not be empty.", "invalid_input", "input");
    const target = this.recordOf(previousResponseId, "previous_response_id");
    const steerId = newId("steer");
    const turn = this.turn;
    const tooLate = (live: ResponseRecord | null): SteerOutcome => {
      if (live && !live.ended) live.emit({ type: "response.steer.failed", steer: { id: steerId, previous_response_id: previousResponseId, input }, error: STEER_TOO_LATE });
      return { steerId, liveResponseId: live && !live.ended ? live.id : null, result: Promise.resolve("response_ended") };
    };
    // Only the live response of the running turn takes a steer (an earlier, steered response of the same turn does not).
    if (!turn || target !== turn.current || turn.cancelRequested) return tooLate(target.ended ? null : target);

    const live = turn.current;
    live.emit({ type: "response.steer.accepted", steer: { id: steerId, previous_response_id: previousResponseId } });
    const steer = { id: steerId, input: items };
    const settled = turn.steers.push(steer);
    const taken = await this.engineImpl.steer(turn, steer).catch(() => false);
    if (!taken) turn.steers.settle(steerId, "response_ended");
    const result: Promise<SteerResult> = settled.then((r) => {
      if (r === "response_ended") {
        const still = turn.current.ended ? null : turn.current;
        still?.emit({ type: "response.steer.failed", steer: { id: steerId, previous_response_id: previousResponseId, input }, error: STEER_TOO_LATE });
      }
      return r;
    });
    return { steerId, liveResponseId: live.id, result };
  }

  /** Cancels the response's turn if it is running; returns the (possibly already ended) response. */
  async cancel(responseId: string): Promise<AgentResponse> {
    const rec = this.recordOf(responseId);
    const turn = this.turn;
    if (turn && rec.turnId === turn.id) {
      turn.cancelRequested = true;
      this.permissions.denyTurn(turn.id);
      await this.engineImpl.cancel();
      await this.finished;
    }
    return this.recordOf(responseId).snapshot();
  }

  /** Cancels when the creating stream closes and the response is not `background`. */
  async cancelIfForeground(responseId: string): Promise<void> {
    const rec = this.log.get(responseId);
    const turn = this.turn;
    // The stream that created the turn closed: cancel the turn's live response (after a steer it is a successor).
    if (!rec || !turn || rec.turnId !== turn.id || turn.current.response.background) return;
    await this.cancel(turn.current.id);
  }

  // ---- greyfolk.* extensions ---------------------------------------------

  decidePermission(id: string, decision: PermissionDecision): { id: string; decision: PermissionDecision } {
    return this.permissions.decide(id, decision);
  }

  status(): AgentStatus {
    const e = this.engineImpl.state();
    const busy = this.turn !== null || e.running || e.subagents.running > 0;
    const latest = this.log.latestTurn();
    return {
      state: busy ? "busy" : "idle",
      engine: this.engine,
      model: e.model,
      session_id: e.sessionId,
      turn: this.turn ? { id: this.turn.id, response_id: this.turn.current.id, responses: latest?.responses ?? [] } : null,
      subagents: { running: e.subagents.running, lost: e.subagents.lost },
      subagent_profile: { name: this.opts.subagentProfileName ?? null, applied: e.subagentProfileApplied },
      permission_requests: this.permissions.list(),
    };
  }

  history(): Promise<HistoryMessage[]> {
    return this.engineImpl.history();
  }

  /** Runs a reset or export with no turn able to start meanwhile, and only one at a time. */
  private async maintain<T>(action: string, fn: () => Promise<T>): Promise<T> {
    if (this.maintenance) throw ApiError.busy(`A ${this.maintenance} is running.`, "not_idle");
    if (this.status().state !== "idle") throw ApiError.busy(`Cannot ${action} while a response or subagents are running.`, "not_idle");
    this.maintenance = action;
    try {
      return await fn();
    } finally {
      this.maintenance = null;
    }
  }

  export(dest: string): Promise<{ dest: string; excluded: string[] }> {
    return this.maintain("export", async () => {
      const excluded = this.engineImpl.exportExcludes();
      await this.record.export(dest, excluded);
      return { dest, excluded };
    });
  }

  reset(): Promise<{ archived_to: string }> {
    return this.maintain("reset", async () => {
      await this.engineImpl.stop();
      const archivedTo = await this.record.reset(this.engineImpl.sessionPaths(), this.opts.resetArchiveDir);
      this.persistedLatest = null;
      this.engineImpl = this.opts.createEngine();
      await this.engineImpl.start(null);
      return { archived_to: archivedTo };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.turn) await this.cancel(this.turn.current.id).catch(() => {});
    await this.engineImpl.stop();
  }
}

/** The response object echoes a request's MCP tools without their credentials (spec §2 Tools). */
function withoutCredentials(t: McpTool): McpTool {
  return { ...t, headers: null };
}
