/**
 * Request validation and input handling (spec §2 "Input handling", "Errors", "Tools").
 *
 * - Only text message items are taken; anything the engine cannot take → 400 invalid_request_error.
 * - New input is chosen by position, never by content (the same text may be sent twice):
 *   with `previous_response_id` the input holds only new items (the standard); without it the
 *   input is the whole conversation and only the items after its last assistant message are new.
 * - Only MCP tools; other tool types → 400.
 */
import { ApiError } from "./errors.js";
import type { CreateParams, EasyInputMessage, McpTool } from "./types.js";

/** A text message an engine receives: the SDK's `EasyInputMessage` with plain text content. */
export type InputMessage = EasyInputMessage & { role: "user" | "system" | "developer"; content: string };

/** A create request after validation. */
export interface ParsedRequest {
  model: string | null;
  /** The new input items, in order (assistant items are never among them). */
  input: InputMessage[];
  instructions: string | null;
  previous_response_id: string | null;
  tools: McpTool[];
  stream: boolean;
  background: boolean;
  metadata: Record<string, string>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseCreateRequest(body: CreateParams | unknown): ParsedRequest {
  const b = asRecord(body);
  if (!b) throw ApiError.invalid("Request body must be a JSON object.");
  if (b.input === undefined) throw ApiError.invalid("Missing required parameter: 'input'.", "missing_required_parameter", "input");

  const model = b.model === undefined || b.model === null ? null : String(b.model);
  const instructions = b.instructions === undefined || b.instructions === null ? null : String(b.instructions);
  const previous = b.previous_response_id === undefined || b.previous_response_id === null ? null : String(b.previous_response_id);

  const tools: McpTool[] = [];
  if (b.tools !== undefined && b.tools !== null) {
    if (!Array.isArray(b.tools)) throw ApiError.invalid("'tools' must be an array.", null, "tools");
    b.tools.forEach((t, i) => tools.push(parseTool(t, i)));
  }

  const metadata: Record<string, string> = {};
  const md = asRecord(b.metadata);
  if (md) for (const [k, v] of Object.entries(md)) metadata[k] = String(v);

  return {
    model,
    input: selectNewItems(normaliseInput(b.input), previous !== null),
    instructions,
    previous_response_id: previous,
    tools,
    stream: b.stream === true,
    background: b.background === true,
    metadata,
  };
}

function parseTool(t: unknown, index: number): McpTool {
  const r = asRecord(t);
  const param = `tools[${index}]`;
  if (!r) throw ApiError.invalid("Each tool must be an object.", null, param);
  if (r.type !== "mcp") {
    throw ApiError.invalid(`Tool type '${String(r.type)}' is not supported; only 'mcp' tools are.`, "unsupported_tool", param);
  }
  if (typeof r.server_label !== "string" || !r.server_label) throw ApiError.invalid("MCP tool needs 'server_label'.", null, `${param}.server_label`);
  if (typeof r.server_url !== "string" || !r.server_url) throw ApiError.invalid("MCP tool needs 'server_url'.", null, `${param}.server_url`);
  if (!/^[A-Za-z0-9_-]+$/.test(r.server_label)) throw ApiError.invalid("'server_label' may only contain letters, digits, '_' and '-'.", null, `${param}.server_label`);
  let headers: Record<string, string> | null = null;
  if (r.headers !== undefined && r.headers !== null) {
    const h = asRecord(r.headers);
    if (!h) throw ApiError.invalid("'headers' must be an object.", null, `${param}.headers`);
    headers = {};
    for (const [k, v] of Object.entries(h)) headers[k] = String(v);
  }
  let requireApproval: "never" | "always" | null = null;
  if (r.require_approval !== undefined && r.require_approval !== null) {
    if (r.require_approval !== "never" && r.require_approval !== "always") {
      throw ApiError.invalid("'require_approval' must be 'never' or 'always' (per-tool approval filters are not supported).", "unsupported_tool", `${param}.require_approval`);
    }
    requireApproval = r.require_approval;
  }
  let allowedTools: string[] | null = null;
  if (r.allowed_tools !== undefined && r.allowed_tools !== null) {
    const at = r.allowed_tools;
    const filter = asRecord(at);
    const names: unknown = Array.isArray(at) ? at : filter && filter.read_only === undefined ? filter.tool_names : undefined;
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string" || !n)) {
      throw ApiError.invalid("'allowed_tools' must be a list of tool names or {tool_names: [...]} (the read_only filter is not supported).", "unsupported_tool", `${param}.allowed_tools`);
    }
    allowedTools = names as string[];
  }
  // Fields greyfolk cannot honour are refused rather than dropped, so nothing fails open.
  for (const f of ["authorization", "connector_id", "allowed_callers", "tunnel_id"]) {
    if (r[f] !== undefined && r[f] !== null) throw ApiError.invalid(`MCP tool field '${f}' is not supported.`, "unsupported_tool", `${param}.${f}`);
  }
  return { type: "mcp", server_label: r.server_label, server_url: r.server_url, headers, require_approval: requireApproval, allowed_tools: allowedTools };
}

/** One message of the request's input, with its role and text. */
type AnyMessage = { role: "user" | "system" | "developer" | "assistant"; text: string };

const UNSUPPORTED_CONTENT = new Set(["input_image", "input_file", "input_audio"]);

/** Flattens `input` (string or item array) into role+text messages; refuses what an engine cannot take. */
export function normaliseInput(input: unknown): AnyMessage[] {
  if (typeof input === "string") return [{ role: "user", text: input }];
  if (!Array.isArray(input)) throw ApiError.invalid("'input' must be a string or an array of input items.", null, "input");
  return input.map((item, i) => normaliseItem(item, `input[${i}]`));
}

function normaliseItem(item: unknown, param: string): AnyMessage {
  const r = asRecord(item);
  if (!r) throw ApiError.invalid("Each input item must be an object.", null, param);
  const type = r.type === undefined ? "message" : String(r.type);
  if (type !== "message") {
    throw ApiError.invalid(`Input item type '${type}' is not supported.`, "unsupported_input", param);
  }
  const role = String(r.role ?? "user");
  if (role !== "user" && role !== "system" && role !== "developer" && role !== "assistant") {
    throw ApiError.invalid(`Unknown message role '${role}'.`, null, `${param}.role`);
  }
  const content = r.content;
  if (typeof content === "string") return { role, text: content };
  if (!Array.isArray(content)) throw ApiError.invalid("Message 'content' must be a string or an array of parts.", null, `${param}.content`);
  const texts: string[] = [];
  content.forEach((part, j) => {
    const p = asRecord(part);
    const ppath = `${param}.content[${j}]`;
    if (!p) throw ApiError.invalid("Each content part must be an object.", null, ppath);
    const ptype = String(p.type);
    if (ptype === "input_text" || ptype === "output_text" || ptype === "text") {
      if (typeof p.text !== "string") throw ApiError.invalid("Text part needs 'text'.", null, ppath);
      texts.push(p.text);
      return;
    }
    if (UNSUPPORTED_CONTENT.has(ptype)) {
      throw ApiError.invalid(`Content part '${ptype}' cannot be taken by this engine.`, "unsupported_input", ppath);
    }
    throw ApiError.invalid(`Unknown content part type '${ptype}'.`, "unsupported_input", ppath);
  });
  return { role, text: texts.join("\n") };
}

/**
 * Picks the new items by position. With `previous_response_id` everything in the input is new.
 * Without it the input is read as the whole conversation: the items after its last assistant
 * message are new (none there → all of it). An assistant message among the new items cannot be
 * fed to an engine → 400.
 */
export function selectNewItems(items: AnyMessage[], hasPrevious: boolean): InputMessage[] {
  let start = 0;
  if (!hasPrevious) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.role === "assistant") {
        start = i + 1;
        break;
      }
    }
  }
  return items.slice(start).map((it, j) => {
    if (it.role === "assistant") {
      throw ApiError.invalid("An assistant message cannot be added as new input; send it as history without previous_response_id, or leave it out.", "unsupported_input", `input[${start + j}]`);
    }
    return { type: "message", role: it.role, content: it.text };
  });
}
