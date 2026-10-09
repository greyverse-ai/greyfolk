/**
 * The standard items an engine strategy writes for its own tools (code design §8: engines write
 * Responses types directly): a shell command → `shell_call`, a file change → `apply_patch_call`, a
 * web search → `web_search_call`, anything else (e.g. the subagent tool) → `custom_tool_call`; and
 * each one's standard output item. MCP is only for MCP servers.
 */
import { newId } from "../service/response-log.js";
import type { ResponseApplyPatchToolCall, ResponseCustomToolCall, ResponseFunctionShellToolCall, ResponseFunctionWebSearch, ResponseOutputItem } from "./types.js";

export type ToolCallItem = ResponseFunctionShellToolCall | ResponseApplyPatchToolCall | ResponseFunctionWebSearch | ResponseCustomToolCall;

export function shellCall(callId: string, command: string): ResponseFunctionShellToolCall {
  return { id: newId("call"), type: "shell_call", call_id: callId, action: { commands: [command], max_output_length: null, timeout_ms: null }, environment: null, status: "in_progress" };
}

export function applyPatchCall(callId: string, path: string, diff: string, operation: "create_file" | "update_file" | "delete_file" = "update_file"): ResponseApplyPatchToolCall {
  return { id: newId("call"), type: "apply_patch_call", call_id: callId, operation: operation === "delete_file" ? { type: "delete_file", path } : { type: operation, path, diff }, status: "in_progress" };
}

export function webSearchCall(query: string): ResponseFunctionWebSearch {
  return { id: newId("call"), type: "web_search_call", status: "in_progress", action: { type: "search", query } };
}

export function customToolCall(callId: string, name: string, input: unknown): ResponseCustomToolCall {
  return { id: newId("call"), type: "custom_tool_call", call_id: callId, name, input: typeof input === "string" ? input : JSON.stringify(input ?? {}) };
}

/** A call's standard output item (a web search has none). */
export function toolOutput(item: ToolCallItem, callId: string, r: { output: string; failed: boolean; exitCode?: number | null }): ResponseOutputItem | null {
  switch (item.type) {
    case "shell_call":
      return { id: newId("out"), type: "shell_call_output", call_id: callId, max_output_length: null, output: [{ stdout: r.output, stderr: "", outcome: { type: "exit", exit_code: r.exitCode ?? (r.failed ? 1 : 0) } }], status: "completed" };
    case "apply_patch_call":
      return { id: newId("out"), type: "apply_patch_call_output", call_id: callId, status: r.failed ? "failed" : "completed", output: r.output };
    case "custom_tool_call":
      return { id: newId("out"), type: "custom_tool_call_output", call_id: callId, output: r.output, status: "completed" };
    default:
      return null;
  }
}
