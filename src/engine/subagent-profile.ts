/**
 * Subagent profile (spec §5, §9.13): set by the starter as a JSON file (`--subagent-profile FILE`):
 *
 *   { "name": "reader", "description": "…",
 *     "mcp_tools": ["files__file_read", "files__file_list"],
 *     "read_only": ["wiki"], "writable": "scratch" }
 *
 * - `mcp_tools`: the MCP tools (`<server_label>__<tool>`, `*` allowed) a subagent may call; none by default.
 * - `read_only` / `writable`: confine the engine's own file tools, when host tools are on.
 * Paths are absolute or relative to the agent folder. Applied as far as each engine allows —
 * mistake prevention, not a boundary.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { escapeRe } from "../common/fsutil.js";

export interface SubagentProfile {
  name: string;
  description: string;
  /** Patterns of MCP tools a subagent may call (`label__tool`, `*` wildcard). */
  mcpTools: string[];
  /** Absolute paths the subagent may read (host tools on only). */
  readOnly: string[];
  /** The one absolute folder the subagent may write into (host tools on only), or null for none. */
  writable: string | null;
}

export async function loadSubagentProfile(file: string, agentDir: string): Promise<SubagentProfile> {
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) throw new Error(`subagent profile not found: ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`subagent profile ${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`subagent profile ${file} must be a JSON object`);
  const o = raw as Record<string, unknown>;
  const list = (key: string): string[] => {
    const v = o[key] ?? [];
    if (!Array.isArray(v) || v.some((p) => typeof p !== "string" || !p.trim())) throw new Error(`subagent profile ${file}: '${key}' must be a list of strings`);
    return v as string[];
  };
  const mcpTools = list("mcp_tools");
  for (const t of mcpTools) if (!/^[A-Za-z0-9_*-]+__[A-Za-z0-9_*.-]+$/.test(t)) throw new Error(`subagent profile ${file}: '${t}' is not '<server_label>__<tool>'`);
  if (o.writable !== undefined && o.writable !== null && (typeof o.writable !== "string" || !o.writable.trim())) throw new Error(`subagent profile ${file}: 'writable' must name one folder`);
  const abs = (p: string): string => path.resolve(agentDir, p);
  const name = typeof o.name === "string" && /^[A-Za-z0-9_-]+$/.test(o.name) ? o.name : path.basename(file).replace(/\.json$/i, "").replace(/[^A-Za-z0-9_-]/g, "_");
  return {
    name,
    description: typeof o.description === "string" && o.description.trim() ? o.description : `Restricted worker (subagent profile '${name}')`,
    mcpTools,
    readOnly: list("read_only").map(abs),
    writable: typeof o.writable === "string" ? abs(o.writable) : null,
  };
}

/** True when the MCP tool `label__tool` matches one of the profile's patterns. */
export function mcpToolAllowed(p: SubagentProfile, labelAndTool: string): boolean {
  return p.mcpTools.some((pat) => new RegExp(`^${pat.split("*").map(escapeRe).join(".*")}$`).test(labelAndTool));
}
