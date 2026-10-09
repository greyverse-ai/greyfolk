/**
 * Request validation and input handling (spec §2 "Input handling", "Errors", "Tools").
 *
 * - Only text input items are taken; anything the harness cannot take → 400 invalid_request_error.
 * - Items the session already holds are not fed again (clients that resend history).
 * - Only MCP tools; other tool types → 400.
 */
import { createHash } from "node:crypto";
import { ApiError } from "./errors.js";
import type { CreateRequest, McpToolParam } from "./types.js";
import type { HarnessInputItem } from "../harness/types.js";

type Role = "user" | "system" | "developer" | "assistant";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseCreateRequest(body: unknown): CreateRequest {
  const b = asRecord(body);
  if (!b) throw ApiError.invalid("Request body must be a JSON object.");
  if (b.input === undefined) throw ApiError.invalid("Missing required parameter: 'input'.", "missing_required_parameter", "input");

  const model = b.model === undefined || b.model === null ? null : String(b.model);
  const instructions = b.instructions === undefined || b.instructions === null ? null : String(b.instructions);
  const previous = b.previous_response_id === undefined || b.previous_response_id === null ? null : String(b.previous_response_id);

  const tools: McpToolParam[] = [];
  if (b.tools !== undefined && b.tools !== null) {
    if (!Array.isArray(b.tools)) throw ApiError.invalid("'tools' must be an array.", null, "tools");
    b.tools.forEach((t, i) => tools.push(parseTool(t, i)));
  }

  const metadata: Record<string, string> = {};
  const md = asRecord(b.metadata);
  if (md) for (const [k, v] of Object.entries(md)) metadata[k] = String(v);

  const deliverHeld: string[] = [];
  const dh = b["greyfolk.deliver_held"];
  if (dh !== undefined && dh !== null) {
    if (!Array.isArray(dh) || dh.some((t) => typeof t !== "string" || !t)) {
      throw ApiError.invalid("'greyfolk.deliver_held' must be an array of turn ids.", null, "greyfolk.deliver_held");
    }
    for (const t of dh as string[]) if (!deliverHeld.includes(t)) deliverHeld.push(t);
  }

  return {
    model,
    input: b.input,
    instructions,
    previous_response_id: previous,
    tools,
    stream: b.stream === true,
    background: b.background === true,
    metadata,
    deliver_held: deliverHeld,
  };
}

function parseTool(t: unknown, index: number): McpToolParam {
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
      throw ApiError.invalid("'require_approval' must be 'never' or 'always'.", null, `${param}.require_approval`);
    }
    requireApproval = r.require_approval;
  }
  return { type: "mcp", server_label: r.server_label, server_url: r.server_url, headers, require_approval: requireApproval };
}

/** One normalised conversation item, used both for feeding the harness and for de-duplication. */
export interface ConversationItem {
  role: Role;
  text: string;
}

const UNSUPPORTED_CONTENT = new Set(["input_image", "input_file", "input_audio"]);

/** Flattens `input` (string or item array) into role+text items; refuses what the harness cannot take. */
export function normaliseInput(input: unknown): ConversationItem[] {
  if (typeof input === "string") return [{ role: "user", text: input }];
  if (!Array.isArray(input)) throw ApiError.invalid("'input' must be a string or an array of input items.", null, "input");
  return input.map((item, i) => normaliseItem(item, `input[${i}]`));
}

function normaliseItem(item: unknown, param: string): ConversationItem {
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
      throw ApiError.invalid(`Content part '${ptype}' cannot be taken by this harness.`, "unsupported_input", ppath);
    }
    throw ApiError.invalid(`Unknown content part type '${ptype}'.`, "unsupported_input", ppath);
  });
  return { role, text: texts.join("\n") };
}

export function itemHash(item: ConversationItem): string {
  return createHash("sha256").update(`${item.role}\n${item.text}`).digest("hex");
}

/**
 * Keeps only the items newer than those the session already holds.
 * A leading run of items already known is dropped; the first unknown item and everything after it is new.
 * An assistant item among the new ones cannot be fed to a harness → 400.
 */
export function selectNewItems(items: ConversationItem[], known: (hash: string) => boolean): HarnessInputItem[] {
  let i = 0;
  while (i < items.length && known(itemHash(items[i]!))) i++;
  const fresh = items.slice(i);
  const out: HarnessInputItem[] = [];
  fresh.forEach((it, j) => {
    if (it.role === "assistant") {
      throw ApiError.invalid("An assistant message the session does not hold cannot be added as input.", "unsupported_input", `input[${i + j}]`);
    }
    out.push({ role: it.role, text: it.text });
  });
  return out;
}
