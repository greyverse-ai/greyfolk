/**
 * Translates a request's MCP tool entries into the servers an engine attaches for that turn
 * (spec §4): the standard entry, streamable HTTP at an `http(s)://` address. Anything else is
 * refused (400), never dropped.
 */
import { ApiError } from "../api/errors.js";
import type { McpTool } from "../api/types.js";

/** One MCP server a request names, for the engine to attach. */
export interface McpAttachment {
  label: string;
  url: string;
  headers: Record<string, string>;
  requireApproval: "never" | "always";
  /** Tools of this server the model may call (null = all). */
  allowedTools: string[] | null;
}

export function translateMcpTools(tools: McpTool[]): McpAttachment[] {
  const seen = new Set<string>();
  return tools.map((t, i) => {
    if (seen.has(t.server_label)) throw ApiError.invalid(`Duplicate MCP server_label '${t.server_label}'.`, null, `tools[${i}].server_label`);
    seen.add(t.server_label);
    const serverUrl = t.server_url ?? "";
    let parsed: URL;
    try {
      parsed = new URL(serverUrl);
    } catch {
      throw ApiError.invalid(`MCP server_url '${serverUrl}' is not a valid URL.`, null, `tools[${i}].server_url`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw ApiError.invalid(`MCP server_url scheme '${parsed.protocol}' cannot be attached; use http(s)://.`, "unsupported_tool", `tools[${i}].server_url`);
    }
    return {
      label: t.server_label,
      url: serverUrl,
      headers: t.headers ?? {},
      // parseCreateRequest admits only the string forms; anything else stays the safe default.
      requireApproval: t.require_approval === "never" ? "never" : "always",
      allowedTools: Array.isArray(t.allowed_tools) ? t.allowed_tools : null,
    };
  });
}

/** The attacher the service uses. */
export function defaultToolAttacher(): (tools: McpTool[]) => McpAttachment[] {
  return translateMcpTools;
}
