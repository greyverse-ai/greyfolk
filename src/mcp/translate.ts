/**
 * Translates a request's MCP tool entries into attachments an engine can take (spec §4, §2 "Extensions").
 *
 * `http://` / `https://` URLs attach as streamable HTTP.
 * `http+unix://<socket path>/<http path>` (greyfolk extension) is bridged through a stdio
 * process that speaks MCP streamable HTTP over the Unix socket, so every engine can reach it.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError } from "../api/errors.js";
import type { McpTool } from "../api/types.js";

/** One MCP server a request names, already translated to a transport an engine can attach. */
export type McpAttachment =
  | {
      kind: "http";
      label: string;
      url: string;
      headers: Record<string, string>;
      requireApproval: "never" | "always";
      /** Tools of this server the model may call (null = all). */
      allowedTools: string[] | null;
    }
  | {
      kind: "stdio";
      label: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      requireApproval: "never" | "always";
      /** Tools of this server the model may call (null = all). */
      allowedTools: string[] | null;
    };

export interface UnixMcpUrl {
  socketPath: string;
  httpPath: string;
}

/** Parses `http+unix://<percent-encoded or plain socket path>/<http path>`. */
export function parseUnixMcpUrl(url: string): UnixMcpUrl | null {
  const prefix = "http+unix://";
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  // The socket path is everything up to the last path segment that follows a ".sock"/".socket"
  // suffix, or, when percent-encoded (`%2F`), the whole encoded host part.
  if (rest.includes("%2F") || rest.includes("%2f")) {
    const slash = rest.indexOf("/");
    const host = slash < 0 ? rest : rest.slice(0, slash);
    const httpPath = slash < 0 ? "/" : rest.slice(slash);
    return { socketPath: decodeURIComponent(host), httpPath: httpPath || "/" };
  }
  const m = /^(\/.*?\.(?:sock|socket))(\/.*)?$/.exec(`/${rest.replace(/^\/+/, "")}`);
  if (!m) return null;
  return { socketPath: m[1]!, httpPath: m[2] || "/" };
}

const HEADERS_ENV = "GREYFOLK_MCP_HEADERS";
const SOCKET_ENV = "GREYFOLK_MCP_SOCKET";
const PATH_ENV = "GREYFOLK_MCP_PATH";

export const BRIDGE_ENV = { HEADERS_ENV, SOCKET_ENV, PATH_ENV } as const;

/** Path of the compiled bridge script, next to this module. */
export function bridgeScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "unix-bridge.js");
}

export function translateMcpTools(tools: McpTool[], opts: { nodeExecutable: string; bridgeScript: string }): McpAttachment[] {
  const seen = new Set<string>();
  return tools.map((t, i) => {
    if (seen.has(t.server_label)) throw ApiError.invalid(`Duplicate MCP server_label '${t.server_label}'.`, null, `tools[${i}].server_label`);
    seen.add(t.server_label);
    const headers = t.headers ?? {};
    // parseCreateRequest admits only the string forms; anything else stays the safe default.
    const requireApproval = t.require_approval === "never" ? "never" : "always";
    const allowedTools = Array.isArray(t.allowed_tools) ? t.allowed_tools : null;
    const serverUrl = t.server_url ?? "";
    const unix = parseUnixMcpUrl(serverUrl);
    if (unix) {
      return {
        kind: "stdio",
        label: t.server_label,
        command: opts.nodeExecutable,
        args: [opts.bridgeScript],
        env: { [SOCKET_ENV]: unix.socketPath, [PATH_ENV]: unix.httpPath, [HEADERS_ENV]: JSON.stringify(headers) },
        requireApproval,
        allowedTools,
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(serverUrl);
    } catch {
      throw ApiError.invalid(`MCP server_url '${serverUrl}' is not a valid URL.`, null, `tools[${i}].server_url`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw ApiError.invalid(`MCP server_url scheme '${parsed.protocol}' cannot be attached; use http(s):// or http+unix://.`, "unsupported_tool", `tools[${i}].server_url`);
    }
    return { kind: "http", label: t.server_label, url: serverUrl, headers, requireApproval, allowedTools };
  });
}

/** The attacher the service uses: `translateMcpTools` with this greyfolk's node and bridge script. */
export function defaultToolAttacher(opts: { nodeExecutable?: string; bridgeScript?: string } = {}): (tools: McpTool[]) => McpAttachment[] {
  const o = { nodeExecutable: opts.nodeExecutable ?? process.execPath, bridgeScript: opts.bridgeScript ?? bridgeScriptPath() };
  return (tools) => translateMcpTools(tools, o);
}
