/**
 * One running turn: a chain of responses (spec §2). The engine writes its output here in
 * Responses vocabulary; the turn puts the matching standard stream events on the live response.
 * A turn goes on in a successor response after a steer (`incomplete`, reason `steered`) or after
 * an approval request is answered (the response ends with an `mcp_approval_request` item and the
 * caller's `mcp_approval_response` opens the next one) — both the standard's own shapes.
 */
import type { ToolCallItem } from "../api/items.js";
import type { ResponseOutputItem, ResponseOutputMessage, ResponseReasoningItem, ResponseUsage } from "../api/types.js";
import { newId, newResponse, type ResponseLog, type ResponseRecord } from "./response-log.js";

type McpCallItem = Extract<ResponseOutputItem, { type: "mcp_call" }>;

type ApprovalItem = Extract<ResponseOutputItem, { type: "mcp_approval_request" }>;
type ToolItem = McpCallItem | ToolCallItem;
interface OpenCall {
  item: ToolItem;
  index: number;
}
interface Carried {
  callId: string;
  item: ToolItem;
}

export interface TurnEnd {
  status: "completed" | "cancelled" | "failed";
  error: string | null;
  usage: ResponseUsage | null;
}

export interface TurnSettings {
  instructions: string | null;
  model: string;
  tools: ResponseRecord["response"]["tools"];
  background: boolean;
  metadata: Record<string, string>;
  conversation: string | null;
}

/** Usage in the SDK shape from plain token counts. */
export function usage(input: number, output: number, detail: { cached?: number; cacheWrite?: number; reasoning?: number; total?: number } = {}): ResponseUsage {
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: detail.cached ?? 0, cache_write_tokens: detail.cacheWrite ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: detail.reasoning ?? 0 },
    total_tokens: detail.total ?? input + output,
  };
}

export class Turn {
  readonly id = newId("turn");
  current: ResponseRecord;
  cancelRequested = false;
  /** Steers handed to the engine and not yet taken in. */
  readonly steers = new Map<string, (r: "taken_in" | "response_ended") => void>();
  /** Approval requests waiting for the caller: request id → resolve. */
  readonly approvals = new Map<string, (approve: boolean) => void>();
  private message: { item: ResponseOutputMessage; index: number } | null = null;
  /** Tool calls still running: the engine's call id → the item on the live response. */
  private readonly calls = new Map<string, OpenCall>();
  /** Calls carried over a response boundary, started again in the successor. */
  private carried: Carried[] = [];
  /** Approval requests asked after the response that asks had already ended: they open the next one. */
  private laterApprovals: ApprovalItem[] = [];
  /** Approval requests on the live response that is about to stop for them (the stop runs on the next tick). */
  private stopping: ApprovalItem[] = [];

  constructor(
    private readonly log: ResponseLog,
    private readonly settings: TurnSettings,
  ) {
    this.current = log.create(this.newResponse(null), this.id);
  }

  private newResponse(previous: string | null) {
    const s = this.settings;
    const r = newResponse({ instructions: s.instructions, model: s.model, tools: s.tools, metadata: s.metadata, background: s.background, previous_response_id: previous });
    if (s.conversation) r.conversation = { id: s.conversation };
    return r;
  }

  open(): void {
    this.current.emit({ type: "response.created", response: this.current.snapshot() });
    this.current.emit({ type: "response.in_progress", response: this.current.snapshot() });
  }

  /** The engine named its session: it is the conversation's id (the standard `conversation`). */
  conversationStarted(id: string): void {
    this.settings.conversation = id;
    this.current.response.conversation = { id };
  }

  textDelta(text: string): void {
    const m = this.openMessage();
    const part = m.item.content[0] as { text: string };
    part.text += text;
    this.current.response.output_text += text;
    this.current.emit({ type: "response.output_text.delta", item_id: m.item.id, output_index: m.index, content_index: 0, delta: text, logprobs: [] });
  }

  /** The assistant message is complete with `text` (any part not yet streamed goes out as a last delta). */
  textDone(text: string): void {
    const m = this.openMessage();
    const part = m.item.content[0] as { text: string };
    if (part.text !== text) {
      const delta = text.startsWith(part.text) ? text.slice(part.text.length) : text;
      if (delta) this.textDelta(delta);
      part.text = text;
    }
    this.closeMessage("completed");
  }

  /** The model's reasoning: its full text, or (where the engine gives only that) a summary. */
  reasoning(text: string, form: "text" | "summary"): void {
    this.closeMessage("completed");
    const item: ResponseReasoningItem =
      form === "text"
        ? { id: newId("rs"), type: "reasoning", status: "completed", summary: [], content: [{ type: "reasoning_text", text }] }
        : { id: newId("rs"), type: "reasoning", status: "completed", summary: [{ type: "summary_text", text }] };
    const index = this.current.response.output.push(item) - 1;
    this.current.emit({ type: "response.output_item.added", output_index: index, item: structuredClone(item) });
    this.current.emit({ type: "response.output_item.done", output_index: index, item: structuredClone(item) });
  }

  /** One of the engine's own tools started, as the standard item the engine wrote (api/items). */
  toolStarted(callId: string, item: ToolCallItem): void {
    this.startCall(callId, item);
  }

  /** One of the engine's own tools ended; its standard output item, if it has one, follows it. */
  toolEnded(callId: string, failed: boolean, output: ResponseOutputItem | null): void {
    const open = this.takeCall(callId);
    if (!open) return;
    const { item } = open;
    if (item.type === "web_search_call") item.status = failed ? "failed" : "completed";
    else if (item.type !== "custom_tool_call" && item.type !== "mcp_call") item.status = "completed";
    this.current.emit({ type: "response.output_item.done", output_index: open.index, item: structuredClone(item) });
    if (!output) return;
    const index = this.current.response.output.push(output) - 1;
    this.current.emit({ type: "response.output_item.added", output_index: index, item: structuredClone(output) });
    this.current.emit({ type: "response.output_item.done", output_index: index, item: structuredClone(output) });
  }

  /** A call to a tool of the request's MCP server `server`. */
  mcpCallStarted(callId: string, call: { server: string; name: string; arguments: unknown }): void {
    const item: McpCallItem = {
      id: newId("mcp"),
      type: "mcp_call",
      status: "in_progress",
      server_label: call.server,
      name: call.name,
      arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
      output: null,
      error: null,
    };
    this.startCall(callId, item);
  }

  mcpCallEnded(callId: string, output: string, error: string | null): void {
    const open = this.takeCall(callId);
    if (!open || open.item.type !== "mcp_call") return;
    const item = open.item;
    item.output = output;
    item.error = error === null ? null : { type: "mcp_tool_execution_error", content: error };
    item.status = error === null ? "completed" : "failed";
    this.current.emit({ type: error === null ? "response.mcp_call.completed" : "response.mcp_call.failed", output_index: open.index, item_id: item.id });
    this.current.emit({ type: "response.output_item.done", output_index: open.index, item: structuredClone(item) });
  }

  private startCall(callId: string, item: ToolItem): void {
    this.closeMessage("completed");
    const index = this.current.response.output.push(item) - 1;
    this.calls.set(callId, { item, index });
    this.current.emit({ type: "response.output_item.added", output_index: index, item: structuredClone(item) });
    if (item.type === "mcp_call") this.current.emit({ type: "response.mcp_call.in_progress", output_index: index, item_id: item.id });
  }

  private takeCall(callId: string): OpenCall | undefined {
    const open = this.calls.get(callId);
    this.calls.delete(callId);
    return open;
  }

  /**
   * A response ends while tool calls still run (steer, approval): each call's item there ends
   * `incomplete`, and the call goes on as a fresh item in the successor, where its result lands.
   */
  private suspendCalls(): Carried[] {
    const carried: Carried[] = [];
    for (const [callId, open] of this.calls) {
      const item = open.item;
      carried.push({ callId, item: structuredClone(item) });
      if (item.type !== "custom_tool_call" && item.type !== "apply_patch_call") item.status = "incomplete";
      this.current.emit({ type: "response.output_item.done", output_index: open.index, item: structuredClone(item) });
    }
    this.calls.clear();
    return carried;
  }

  private resumeCalls(carried: Carried[]): void {
    for (const { callId, item } of carried) {
      item.id = newId(item.type === "mcp_call" ? "mcp" : "call");
      this.startCall(callId, item);
    }
  }

  /**
   * Asks the caller before an MCP tool runs: the response ends with an `mcp_approval_request`
   * item; the caller's next request with an `mcp_approval_response` decides and the turn goes
   * on in its response. Requests asked together end one response; one asked after that response
   * ended opens the next. Resolves false if the turn ends first.
   */
  requestApproval(call: { server: string; name: string; arguments: unknown }): Promise<boolean> {
    const item: ApprovalItem = { id: newId("mcpr"), type: "mcp_approval_request", server_label: call.server, name: call.name, arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}) };
    const answer = new Promise<boolean>((resolve) => this.approvals.set(item.id, resolve));
    if (this.current.ended) this.laterApprovals.push(item);
    else this.askApproval(item);
    return answer;
  }

  private askApproval(item: ApprovalItem): void {
    this.closeMessage("completed");
    const index = this.current.response.output.push(item) - 1;
    this.current.emit({ type: "response.output_item.added", output_index: index, item: structuredClone(item) });
    this.current.emit({ type: "response.output_item.done", output_index: index, item: structuredClone(item) });
    this.stopping.push(item);
    if (this.stopping.length > 1) return;
    // Approvals asked in the same moment (parallel tool calls) end one response together.
    const rec = this.current;
    setImmediate(() => {
      this.stopping = [];
      if (this.current !== rec || rec.ended) return;
      this.carried = this.suspendCalls();
      this.finishCurrent("completed");
    });
  }

  /** The caller answered: the turn goes on in a successor of the response that asked. */
  continueAfterApproval(decisions: { approval_request_id: string; approve: boolean }[]): ResponseRecord {
    this.successor();
    for (const d of decisions) {
      const resolve = this.approvals.get(d.approval_request_id);
      this.approvals.delete(d.approval_request_id);
      resolve?.(d.approve);
    }
    for (const item of this.laterApprovals.splice(0)) this.askApproval(item);
    return this.current;
  }

  /** The model step took a steer in: the running response ends `incomplete` (steered) and a successor continues the turn. */
  steerTakenIn(steerId: string): void {
    const settle = this.steers.get(steerId);
    this.steers.delete(steerId);
    // The response is stopping for approval: that boundary wins (as in the standard, the steer goes on
    // in the response that answers the approval), so this one is not split.
    if (this.stopping.length > 0 || this.current.ended) return settle?.("taken_in");
    const prev = this.current;
    this.closeMessage("incomplete");
    this.carried = this.suspendCalls();
    prev.response.status = "incomplete";
    prev.response.incomplete_details = { reason: "steered" };
    prev.response.completed_at = Math.floor(Date.now() / 1000);
    this.successor(() => prev.emit({ type: "response.incomplete", response: prev.snapshot() }));
    settle?.("taken_in");
  }

  /** Opens the response that continues the turn (`endPrevious` runs once it is linked, so streams can follow it). */
  private successor(endPrevious?: () => void): void {
    const prev = this.current;
    this.current = this.log.create(this.newResponse(prev.id), this.id);
    prev.nextResponseId = this.current.id;
    endPrevious?.();
    this.open();
    this.resumeCalls(this.carried.splice(0));
  }

  /** Every approval still waiting is answered no (the turn is being cancelled). */
  declineApprovals(): void {
    for (const resolve of this.approvals.values()) resolve(false);
    this.approvals.clear();
    this.laterApprovals = [];
  }

  /** Ends the live response with the turn's outcome; a cancelled one ends `incomplete` with status `cancelled`. */
  end(ev: TurnEnd): void {
    for (const settle of this.steers.values()) settle("response_ended");
    this.steers.clear();
    this.declineApprovals();
    this.carried = [];
    const rec = this.current;
    if (rec.ended) return;
    if (ev.usage) rec.response.usage = ev.usage;
    if (ev.status === "failed") rec.response.error = { code: "server_error", message: ev.error ?? "The engine failed." };
    this.finishCurrent(ev.status);
  }

  private finishCurrent(status: "completed" | "cancelled" | "failed"): void {
    const rec = this.current;
    this.closeMessage(status === "completed" ? "completed" : "incomplete");
    this.endCalls(status);
    rec.response.completed_at = Math.floor(Date.now() / 1000);
    rec.response.status = status;
    const type = status === "completed" ? "response.completed" : status === "failed" ? "response.failed" : "response.incomplete";
    rec.emit({ type, response: rec.snapshot() } as never);
  }

  private openMessage(): { item: ResponseOutputMessage; index: number } {
    if (this.message) return this.message;
    const item: ResponseOutputMessage = { id: newId("msg"), type: "message", role: "assistant", status: "in_progress", content: [{ type: "output_text", text: "", annotations: [] }] };
    const index = this.current.response.output.push(item) - 1;
    this.message = { item, index };
    this.current.emit({ type: "response.output_item.added", output_index: index, item: structuredClone(item) });
    this.current.emit({ type: "response.content_part.added", item_id: item.id, output_index: index, content_index: 0, part: structuredClone(item.content[0]!) });
    return this.message;
  }

  private closeMessage(status: "completed" | "incomplete"): void {
    const m = this.message;
    if (!m) return;
    const part = m.item.content[0] as { type: "output_text"; text: string; annotations: [] };
    this.current.emit({ type: "response.output_text.done", item_id: m.item.id, output_index: m.index, content_index: 0, text: part.text, logprobs: [] });
    this.current.emit({ type: "response.content_part.done", item_id: m.item.id, output_index: m.index, content_index: 0, part: structuredClone(part) });
    m.item.status = status;
    this.current.emit({ type: "response.output_item.done", output_index: m.index, item: structuredClone(m.item) });
    this.message = null;
  }

  /** Calls still open when the turn ends end with it. */
  private endCalls(status: "completed" | "cancelled" | "failed"): void {
    for (const [, open] of this.calls) {
      const item = open.item;
      if (item.type === "mcp_call") {
        item.status = status === "failed" ? "failed" : "incomplete";
        if (status === "failed") item.error = { type: "mcp_tool_execution_error", content: "The turn failed before the tool returned." };
        if (status === "failed") this.current.emit({ type: "response.mcp_call.failed", output_index: open.index, item_id: item.id });
      } else if (item.type === "web_search_call") item.status = status === "failed" ? "failed" : "incomplete";
      else if (item.type === "shell_call") item.status = "incomplete";
      this.current.emit({ type: "response.output_item.done", output_index: open.index, item: structuredClone(item) });
    }
    this.calls.clear();
  }
}
