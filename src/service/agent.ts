/**
 * The service: the OpenAI Responses API for one agent, with one engine (its SDK) as the
 * strategy. It keeps the one thing the protocol needs and the SDKs do not: the responses of the
 * current process, for streaming and re-attach. Everything else is the engine's.
 */
import type { Limits } from "../api/limits.js";
import type { AgentResponse, AgentState, ConversationItemList, CreateParams, McpTool, ResponseSteerInput, ResponsesApi, SteerFailure, SteerOutcome, StreamListener } from "../api/types.js";
import { ApiError } from "../api/errors.js";
import { normaliseInput, parseCreateRequest, type InputMessage } from "../api/input.js";
import { translateMcpTools } from "../mcp/translate.js";
import type { Engine, EngineModel } from "../engine/engine.js";
import { newId, ResponseLog, type ResponseRecord } from "./response-log.js";
import { Turn, type TurnEnd } from "./turn.js";

export type ModelPolicy = "fixed" | "request";

export interface AgentServiceOptions {
  engine: Engine;
  modelPolicy: ModelPolicy;
}

const TOO_LATE: SteerFailure = { code: "response_not_active", message: "The response ended before the input could be taken in; start a new turn." };

export class AgentService implements ResponsesApi {
  private readonly log = new ResponseLog();
  private readonly engine: Engine;
  private turn: Turn | null = null;
  private finished: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly opts: AgentServiceOptions) {
    this.engine = opts.engine;
  }

  init(): Promise<void> {
    return this.engine.start();
  }

  async create(params: CreateParams): Promise<AgentResponse> {
    if (this.closed) throw new ApiError(503, "server_error", "greyfolk is shutting down.");
    const req = parseCreateRequest(params);
    const turn = this.turn;
    // The answer to an approval request goes on with the turn that asked (the standard flow).
    if (req.approvals.length > 0) {
      if (!turn || turn.approvals.size === 0) throw ApiError.invalid("No approval request is waiting.", "invalid_input", "input");
      for (const a of req.approvals) if (!turn.approvals.has(a.approval_request_id)) throw ApiError.invalid(`Approval request '${a.approval_request_id}' is not waiting.`, "invalid_input", "input");
      return turn.continueAfterApproval(req.approvals).snapshot();
    }
    if (turn) throw ApiError.busy("A turn is in progress; steer it or wait for it to end.");
    if (req.previous_response_id !== null && req.previous_response_id !== this.log.latestResponseId()) {
      throw ApiError.invalid("previous_response_id must name the latest response of this conversation.", "previous_response_not_latest", "previous_response_id");
    }
    if (req.input.length === 0) throw ApiError.invalid("No new input: the input holds nothing after the conversation's last assistant message.", "no_new_input", "input");
    req.tools.forEach((t, i) => {
      if (t.require_approval !== "never" && !this.engine.canAskApproval) {
        throw ApiError.invalid(`The ${this.engine.name} engine cannot ask before an MCP tool runs; set require_approval to "never".`, "unsupported_tool", `tools[${i}].require_approval`);
      }
    });
    if (this.opts.modelPolicy === "request" && req.model && !this.engine.modelFamily.test(req.model)) {
      throw ApiError.invalid(`Model '${req.model}' is not in the ${this.engine.name} engine's family.`, "model_not_in_family", "model");
    }
    const mcp = translateMcpTools(req.tools);
    const state = this.engine.state();
    // previous_response_id continues the conversation that response belongs to.
    const conversation = req.conversation ?? (req.previous_response_id ? (this.log.get(req.previous_response_id)?.response.conversation?.id ?? null) : null);
    const next = new Turn(this.log, {
      instructions: req.instructions,
      model: (this.opts.modelPolicy === "request" && req.model) || state.model || "default",
      tools: req.tools.map((t) => ({ ...t, headers: null })), // credentials are never echoed
      background: req.background,
      metadata: req.metadata,
      conversation,
    });
    this.turn = next;
    next.open();
    const snapshot = next.current.snapshot();
    this.finished = this.run(next, { conversation, input: req.input, instructions: req.instructions, model: this.opts.modelPolicy === "request" ? req.model : null, effort: req.effort, mcp });
    return snapshot;
  }

  private async run(turn: Turn, req: Parameters<Engine["run"]>[1]): Promise<void> {
    let end: TurnEnd;
    try {
      end = turn.cancelRequested ? { status: "cancelled", error: null, usage: null } : await this.engine.run(turn, req);
    } catch (err) {
      end = { status: turn.cancelRequested ? "cancelled" : "failed", error: err instanceof Error ? err.message : String(err), usage: null };
    }
    if (turn.cancelRequested && end.status === "failed") end = { ...end, status: "cancelled" };
    this.turn = null;
    turn.end(end);
  }

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

  async steer(previousResponseId: string, input: ResponseSteerInput): Promise<SteerOutcome> {
    const refused = (code: SteerFailure["code"], message: string): SteerOutcome => ({ id: null, result: Promise.resolve({ code, message }) });
    let items: InputMessage[];
    try {
      items = normaliseInput(input).map((it) => {
        if (it.role !== "user") throw ApiError.invalid("Steer input must be user messages.");
        return { type: "message", role: "user", content: it.text };
      });
    } catch (err) {
      return refused("invalid_input", ApiError.from(err).message);
    }
    if (items.length === 0 || items.every((i) => !i.content)) return refused("invalid_input", "Steer input must not be empty.");
    const target = this.log.get(previousResponseId);
    if (!target) return refused("response_not_found", `Response '${previousResponseId}' not found.`);
    if (target.ended) return refused(target.response.status === "completed" ? "response_already_completed" : "response_not_active", "The response is no longer accepting steering input.");
    const turn = this.turn;
    if (!turn || target !== turn.current || turn.cancelRequested) return refused("response_not_active", "The response is no longer accepting steering input.");
    if (!this.engine.canSteer) return refused("steering_not_supported", `The ${this.engine.name} engine takes no input into a turn in progress.`);
    const id = newId("steer");
    target.emit({ type: "response.steer.accepted", steer: { id, previous_response_id: previousResponseId } });
    const result = new Promise<"taken_in" | SteerFailure>((resolve) => turn.steers.set(id, (r) => resolve(r === "taken_in" ? r : TOO_LATE)));
    if (!(await this.engine.steer(turn, id, items).catch(() => false))) {
      turn.steers.get(id)?.("response_ended");
      turn.steers.delete(id);
    }
    return { id, result };
  }

  async cancel(responseId: string): Promise<AgentResponse> {
    const rec = this.recordOf(responseId);
    const turn = this.turn;
    if (turn && rec.turnId === turn.id) {
      turn.cancelRequested = true;
      // An approval still waiting is answered no first, so the engine's step can stop.
      turn.declineApprovals();
      await this.engine.cancel();
      await this.finished;
    }
    return this.recordOf(responseId).snapshot();
  }

  async cancelIfForeground(responseId: string): Promise<void> {
    const rec = this.log.get(responseId);
    const turn = this.turn;
    if (!rec || !turn || rec.turnId !== turn.id || turn.current.response.background) return;
    await this.cancel(turn.current.id);
  }

  async conversationItems(conversationId: string): Promise<ConversationItemList> {
    const messages = await this.engine.conversation(conversationId);
    if (!messages) throw ApiError.notFound(`Conversation '${conversationId}' not found.`, "conversation_id");
    const data = messages.map((m, i) => ({
      id: `msg_${conversationId}_${i}`,
      type: "message" as const,
      role: m.role,
      status: "completed" as const,
      content: [m.role === "user" ? { type: "input_text" as const, text: m.text } : { type: "output_text" as const, text: m.text, annotations: [] }],
    }));
    return { object: "list", data, first_id: data[0]?.id ?? "", last_id: data.at(-1)?.id ?? "", has_more: false } as unknown as ConversationItemList;
  }

  async models(): Promise<EngineModel[] | null> {
    return this.engine.models ? this.engine.models() : null;
  }

  /** The engine account's limits as last reported; asked again (briefly) when that is over a minute old. */
  async limits(): Promise<Limits | null> {
    if (!this.engine.limits) return null;
    const known = await this.engine.limits(false);
    if (known && Date.now() / 1000 - known.observed_at < 60) return known;
    const fresh = await Promise.race([this.engine.limits(true), new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    return fresh ?? known;
  }

  state(): AgentState {
    const e = this.engine.state();
    const turn = this.turn;
    return {
      busy: turn !== null || e.running || e.subagents > 0,
      engine: this.engine.name,
      model: e.model,
      conversation: e.conversation,
      response_id: turn?.current.id ?? null,
      subagents: e.subagents,
      approvals: turn ? [...turn.approvals.keys()] : [],
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.turn) await this.cancel(this.turn.current.id).catch(() => {});
    await this.engine.stop();
  }
}
