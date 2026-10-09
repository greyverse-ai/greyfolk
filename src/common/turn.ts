/**
 * One running turn: a chain of responses (spec §2, §3). An engine writes its output into the
 * turn with Responses vocabulary (text, reasoning, MCP calls, steer taken in, subagents); the
 * turn puts the matching SDK stream events on the live response and keeps the response object.
 * Engine-neutral: it knows no engine's native events, only Responses items.
 */
import type { ResponseOutputMessage, ResponseReasoningItem, ResponseUsage, ResponseOutputItem } from "../api/types.js";
import type { PermissionDecision } from "../api/types.js";
import { newId, newResponse, type ResponseLog, type ResponseRecord } from "./response-log.js";
import type { PermissionBridge } from "./permission-bridge.js";
import type { SessionRecord } from "./session-record.js";
import { SteerQueue } from "./steer-queue.js";

type McpCallItem = Extract<ResponseOutputItem, { type: "mcp_call" }>;

export interface TurnEnd {
  status: "completed" | "cancelled" | "failed";
  error: string | null;
  usage: ResponseUsage | null;
}

export interface TurnHost {
  log: ResponseLog;
  record: SessionRecord;
  permissions: PermissionBridge;
  /** `server_label` for engine-native tool calls that name no MCP server. */
  nativeToolLabel: string;
}

export interface TurnSettings {
  instructions: string | null;
  model: string;
  tools: ResponseRecord["response"]["tools"];
  background: boolean;
  metadata: Record<string, string>;
}

/** Usage in the SDK shape from plain token counts. */
export function usage(input: number, output: number): ResponseUsage {
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

export class Turn {
  readonly id = newId("turn");
  /** The id of the turn's first response: the caller's name for the turn (spec §2, §5). */
  readonly firstResponseId: string;
  current: ResponseRecord;
  readonly steers = new SteerQueue();
  cancelRequested = false;
  private message: { item: ResponseOutputMessage; index: number } | null = null;
  private readonly openCalls = new Map<string, { item: McpCallItem; index: number }>();

  constructor(
    private readonly host: TurnHost,
    private readonly settings: TurnSettings,
  ) {
    this.current = host.log.create(this.newResponse(null), this.id);
    this.firstResponseId = this.current.id;
  }

  private newResponse(previous: string | null) {
    const s = this.settings;
    return newResponse({ instructions: s.instructions, model: s.model, tools: s.tools, metadata: s.metadata, background: s.background, previous_response_id: previous });
  }

  /** Emits `response.created` + `response.in_progress` for the live response. */
  open(): void {
    this.current.emit({ type: "response.created", response: this.current.snapshot() });
    this.current.emit({ type: "response.in_progress", response: this.current.snapshot() });
  }

  // ---- output an engine writes ---------------------------------------------

  /** The engine named (or renamed) its session. */
  async sessionStarted(sessionId: string): Promise<void> {
    await this.host.record.writeSessionId(sessionId);
  }

  textDelta(text: string): void {
    const m = this.openMessage();
    const part = m.item.content[0] as { text: string };
    part.text += text;
    this.current.response.output_text += text;
    this.current.emit({ type: "response.output_text.delta", item_id: m.item.id, output_index: m.index, content_index: 0, delta: text, logprobs: [] });
  }

  /** The assistant message is complete with `text` (any part not yet streamed is sent as a last delta). */
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

  reasoning(text: string): void {
    this.closeMessage("completed");
    const item: ResponseReasoningItem = { id: newId("rs"), type: "reasoning", status: "completed", summary: [{ type: "summary_text", text }] };
    const index = this.current.response.output.push(item) - 1;
    this.current.emit({ type: "response.output_item.added", output_index: index, item: structuredClone(item) });
    this.current.emit({ type: "response.output_item.done", output_index: index, item: structuredClone(item) });
  }

  /** A tool call started; `callId` is the engine's own id, used to match `mcpCallEnded`. */
  mcpCallStarted(callId: string, call: { server: string | null; name: string; arguments: unknown }): void {
    this.closeMessage("completed");
    const item: McpCallItem = {
      id: newId("mcp"),
      type: "mcp_call",
      status: "in_progress",
      server_label: call.server ?? this.host.nativeToolLabel,
      name: call.name,
      arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
      output: null,
      error: null,
    };
    const index = this.current.response.output.push(item) - 1;
    this.openCalls.set(callId, { item, index });
    this.current.emit({ type: "response.output_item.added", output_index: index, item: structuredClone(item) });
    this.current.emit({ type: "response.mcp_call.in_progress", output_index: index, item_id: item.id });
  }

  mcpCallEnded(callId: string, output: string, error: string | null): void {
    const open = this.openCalls.get(callId);
    if (!open) return;
    this.openCalls.delete(callId);
    open.item.output = output;
    open.item.error = error === null ? null : { type: "mcp_tool_execution_error", content: error };
    open.item.status = error === null ? "completed" : "failed";
    this.current.emit({ type: error === null ? "response.mcp_call.completed" : "response.mcp_call.failed", output_index: open.index, item_id: open.item.id });
    this.current.emit({ type: "response.output_item.done", output_index: open.index, item: structuredClone(open.item) });
  }

  /** Asks the caller a tool permission (`greyfolk.permission_request`); denied if the turn ends first. */
  askPermission(req: { tool: string; operation: unknown; signal?: AbortSignal }): Promise<PermissionDecision> {
    const responseId = this.current.id;
    return this.host.permissions.ask({
      responseId,
      turnId: this.id,
      signal: req.signal,
      announce: (id) => this.current.emit({ type: "greyfolk.permission_request", id, response_id: responseId, tool: req.tool, operation: req.operation }),
    });
  }

  /**
   * The model step took the steer in: the running response ends `incomplete` (steered) and a
   * successor continues the turn (spec §2 steer).
   */
  steerTakenIn(steerId: string): void {
    const prev = this.current;
    this.closeMessage("incomplete");
    this.failOpenCalls("steered");
    const successor = this.host.log.create(this.newResponse(prev.id), this.id);
    prev.nextResponseId = successor.id;
    prev.emit({ type: "greyfolk.steer_taken_in", steer: { id: steerId, previous_response_id: prev.id }, next_response_id: successor.id });
    prev.response.status = "incomplete";
    prev.response.incomplete_details = { reason: "steered" };
    prev.response.completed_at = Math.floor(Date.now() / 1000);
    prev.emit({ type: "response.incomplete", response: prev.snapshot() });

    this.current = successor;
    this.host.record.writeInflight(successor.id).catch(() => {});
    this.open();
    this.steers.settle(steerId, "taken_in");
  }

  // ---- ending ---------------------------------------------------------------

  /** Ends the live response with the turn's outcome. */
  end(ev: TurnEnd): void {
    const rec = this.current;
    if (rec.ended) return;
    this.closeMessage(ev.status === "completed" ? "completed" : "incomplete");
    this.failOpenCalls(ev.status);
    rec.response.completed_at = Math.floor(Date.now() / 1000);
    if (ev.usage) rec.response.usage = ev.usage;
    if (ev.status === "completed") {
      rec.response.status = "completed";
      rec.emit({ type: "response.completed", response: rec.snapshot() });
    } else if (ev.status === "cancelled") {
      rec.response.status = "cancelled";
      rec.emit({ type: "response.cancelled", response: rec.snapshot() });
    } else {
      rec.response.status = "failed";
      rec.response.error = { code: "engine_error", message: ev.error ?? "The engine failed." };
      rec.emit({ type: "response.failed", response: rec.snapshot() });
    }
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

  private failOpenCalls(reason: string): void {
    for (const [, open] of this.openCalls) {
      open.item.status = "failed";
      open.item.error = { type: "mcp_tool_execution_error", content: reason };
      this.current.emit({ type: "response.output_item.done", output_index: open.index, item: structuredClone(open.item) });
    }
    this.openCalls.clear();
  }
}
