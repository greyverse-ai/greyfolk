/**
 * The OpenAI Responses subset greyfolk serves (spec §2), as wire shapes.
 * Only what greyfolk produces or reads is typed; unknown fields pass through untouched.
 */

export type ResponseStatus = "in_progress" | "completed" | "incomplete" | "failed" | "cancelled";

export interface McpToolParam {
  type: "mcp";
  server_label: string;
  server_url: string;
  headers?: Record<string, string> | null;
  require_approval?: "never" | "always" | null;
}

export interface OutputTextPart {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

export interface MessageOutputItem {
  id: string;
  type: "message";
  role: "assistant";
  status: "in_progress" | "completed" | "incomplete";
  content: OutputTextPart[];
}

export interface McpCallOutputItem {
  id: string;
  type: "mcp_call";
  status: "in_progress" | "completed" | "failed";
  server_label: string;
  name: string;
  arguments: string;
  output: string | null;
  error: string | null;
}

export interface ReasoningOutputItem {
  id: string;
  type: "reasoning";
  status: "completed";
  summary: { type: "summary_text"; text: string }[];
}

export type OutputItem = MessageOutputItem | McpCallOutputItem | ReasoningOutputItem;

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  completed_at: number | null;
  status: ResponseStatus;
  error: { code: string; message: string } | null;
  incomplete_details: { reason: string } | null;
  instructions: string | null;
  model: string;
  output: OutputItem[];
  previous_response_id: string | null;
  tools: McpToolParam[];
  usage: ResponseUsage | null;
  background: boolean;
  metadata: Record<string, string>;
}

/** A streaming event as sent over SSE or the WebSocket; `sequence_number` is per response. */
export interface StreamEvent {
  type: string;
  sequence_number: number;
  [key: string]: unknown;
}

/** The request body of `response.create` / `POST /v1/responses`, after validation. */
export interface CreateRequest {
  model: string | null;
  input: unknown;
  instructions: string | null;
  previous_response_id: string | null;
  tools: McpToolParam[];
  stream: boolean;
  background: boolean;
  metadata: Record<string, string>;
  /** Extension `greyfolk.deliver_held`: turn ids (first response id of the turn) whose held subagent results this response carries. */
  deliver_held: string[];
}
