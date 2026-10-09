/**
 * Subagent profile (spec §5): set by the starter as a name, resolved to
 * `<agent folder>/subagent-profiles/<name>.json`:
 *
 *   { "description": "…", "read_only": ["wiki", "/shared/docs"], "writable": "scratch" }
 *
 * Paths are absolute or relative to the agent folder. Applied as far as each harness allows —
 * mistake prevention, not a boundary. Claude applies it (agent definition + a PreToolUse hook that
 * confines subagent writes to the writable folder and refuses MCP tools); Codex records it as not
 * applied (its exec protocol exposes no subagent settings).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface SubagentProfile {
  name: string;
  description: string;
  /** Absolute paths the subagent may read. */
  readOnly: string[];
  /** The one absolute folder the subagent may write into. */
  writable: string;
}

export const PROFILE_DIR = "subagent-profiles";

export async function loadSubagentProfile(agentDir: string, name: string): Promise<SubagentProfile> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`--subagent-profile '${name}' is not a plain name`);
  const file = path.join(agentDir, PROFILE_DIR, `${name}.json`);
  const text = await fs.readFile(file, "utf8").catch(() => null);
  if (text === null) throw new Error(`subagent profile '${name}' not found (expected ${file})`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`subagent profile ${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object") throw new Error(`subagent profile ${file} must be a JSON object`);
  const o = raw as Record<string, unknown>;
  if (typeof o.writable !== "string" || !o.writable.trim()) throw new Error(`subagent profile ${file}: 'writable' must name one folder`);
  const ro = o.read_only ?? [];
  if (!Array.isArray(ro) || ro.some((p) => typeof p !== "string" || !p.trim())) throw new Error(`subagent profile ${file}: 'read_only' must be a list of paths`);
  const abs = (p: string): string => path.resolve(agentDir, p);
  return {
    name,
    description: typeof o.description === "string" && o.description.trim() ? o.description : `Restricted worker (greyfolk subagent profile '${name}')`,
    readOnly: (ro as string[]).map(abs),
    writable: abs(o.writable),
  };
}

/** True when `file` lies inside `dir` (or is `dir`). */
export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Tool names whose input names a file the tool will change (Claude Code built-ins). */
export const WRITING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Built-in tools a profiled subagent gets (no Bash: a shell could write anywhere). */
export const PROFILE_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "WebFetch", "WebSearch"];

export function profilePrompt(p: SubagentProfile): string {
  return [
    p.description,
    "",
    "You work under a restricted profile:",
    `- You may read: ${[p.writable, ...p.readOnly].join(", ")}`,
    `- You may write only inside: ${p.writable}`,
    "- You have no MCP tools and no shell.",
    "Report your result to the agent that spawned you.",
  ].join("\n");
}

/** Decides a subagent's tool call under the profile: null = fine, string = reason to deny. */
export function profileDenial(p: SubagentProfile, toolName: string, input: unknown): string | null {
  if (toolName.startsWith("mcp__")) return `subagent profile '${p.name}': MCP tools are not available to subagents`;
  if (WRITING_TOOLS.has(toolName)) {
    const file = (input as { file_path?: unknown; notebook_path?: unknown } | null)?.file_path ?? (input as { notebook_path?: unknown } | null)?.notebook_path;
    if (typeof file !== "string") return `subagent profile '${p.name}': ${toolName} without a file path`;
    if (!isInside(p.writable, file)) return `subagent profile '${p.name}': ${file} lies outside the writable folder ${p.writable}`;
  }
  return null;
}
