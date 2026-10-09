/**
 * Codex engine (spec §1, §3, §4; open items §9.10 / §9.11).
 *
 * - One `codex exec --experimental-json` process per turn, a child of greyfolk in its own process
 *   group; greyfolk speaks the SDK's JSONL event protocol directly and reuses the SDK's event types.
 * - Everything loads from the agent folder: `CODEX_HOME` = cwd = agent folder; project docs
 *   (`AGENTS.md` in the cwd tree) are off (`project_doc_max_bytes=0`); the soul is the model
 *   instructions file (replaces Codex's default prompt); MCP servers come only from the request,
 *   in a per-turn 0600 config layer `<CODEX_HOME>/<name>.config.toml` selected with `--profile`
 *   and deleted after the turn (§9.10). Nothing secret goes into argv.
 * - Tool kinds turned off (`--disable-tools` / `--no-host-tools`) map to Codex features and settings
 *   (`FEATURES_BY_KIND`; files = read-only sandbox, web = web search off). At start greyfolk checks
 *   that this Codex knows every feature it disables (fail closed). `code_mode_host` stays on: MCP
 *   calls go through it.
 * - MCP calls need no approval prompt (`default_tools_approval_mode = "approve"`): `codex exec`
 *   cannot ask, so `require_approval: "always"` is refused by the service (§9.11).
 * - Resume: `codex exec resume <thread id>`. No mid-turn input, no observable subagents.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { promisify } from "node:util";
import type { ChildProcess } from "node:child_process";
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { HistoryMessage } from "../api/types.js";
import type { QueuedSteer } from "../common/steer-queue.js";
import { usage, type Turn, type TurnEnd } from "../common/turn.js";
import type { McpAttachment } from "../mcp/translate.js";
import type { Engine, EngineOptions, EngineState, EngineTurn } from "./engine.js";
import { checkExecPrefix, killGroup, spawnGroup } from "./process.js";
import { registerEngine } from "./registry.js";
import { foldInput, textOf } from "./prompt.js";
import { TOOL_KINDS, type ToolKind } from "../options.js";

/** Pinned SDK package (its event types are the wire contract); resume-from-copy is tested per version (§3). */
export const CODEX_SDK_VERSION = "0.161.0";

/** Where greyfolk writes the soul for the engine to read (inside the run dir, which exports leave out). */
export const SOUL_FILE = path.join(".greyfolk", "run", "soul.md");

/** Codex features per tool kind (`files` is the read-only sandbox, `web` the web search setting). Verified with codex-cli 0.160.1. */
export const FEATURES_BY_KIND: Record<ToolKind, string[]> = {
  shell: ["shell_tool", "unified_exec", "unified_exec_tty", "shell_snapshot", "write_stdin_approval", "workspace_dependencies"],
  files: ["worktrees"],
  web: [],
  browser: ["browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser", "computer_use", "in_app_local_automation"],
  images: ["view_image", "image_generation"],
  apps: ["apps", "plugins", "remote_plugin", "plugin_sharing", "skill_mcp_dependency_install", "skill_search", "tool_suggest"],
};

/**
 * Features that reach no host resource and may stay on with every tool kind off (an allow-list,
 * verified with codex-cli 0.160.1). `code_mode_host` must stay on: MCP calls go through it.
 * Any other enabled feature refuses the start until this list is updated for the new Codex.
 */
export const NON_HOST_FEATURES = [
  "auth_elicitation", "code_mode_host", "compaction_image_budget", "content_item_kinds", "daemon_auto_start", "enable_request_compression",
  "fast_mode", "goals", "guardian_approval", "guardian_reuse_parent_compaction", "hooks", "in_app_chat", "in_app_dictation", "in_app_updates",
  "mentions_v2", "multi_agent", "realtime_conversation", "sleep_tool", "system_proxy_fallback", "tool_call_mcp_elicitation", "unbounded_connection_retries",
];

/** Every feature turned off when every kind is off. */
export const HOST_FEATURES = Object.values(FEATURES_BY_KIND).flat();

export function featuresOf(kinds: Iterable<ToolKind>): string[] {
  return [...kinds].flatMap((k) => FEATURES_BY_KIND[k]);
}

export interface CodexEngineOptions extends EngineOptions {
  /** The engine binary (default: `codex` on PATH). */
  codexPath?: string;
  /** Extra environment for the engine process (never credentials from greyfolk itself). */
  env?: Record<string, string>;
}

/** A TOML literal for one `--config key=value` override. */
export function tomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v && typeof v === "object") {
    return `{ ${Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`)
      .join(", ")} }`;
  }
  throw new Error(`cannot encode ${typeof v} as TOML`);
}

function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

/** The TOML config layer that attaches this turn's MCP servers (Codex config `mcp_servers`). */
export function mcpProfileToml(mcp: McpAttachment[]): string {
  const out: string[] = [];
  for (const m of mcp) {
    out.push(`[mcp_servers.${tomlKey(m.label)}]`);
    if (m.kind === "http") {
      out.push(`url = ${tomlValue(m.url)}`);
      if (Object.keys(m.headers).length) out.push(`http_headers = ${tomlValue(m.headers)}`);
    } else {
      out.push(`command = ${tomlValue(m.command)}`);
      if (m.args.length) out.push(`args = ${tomlValue(m.args)}`);
      if (Object.keys(m.env).length) out.push(`env = ${tomlValue(m.env)}`);
    }
    // `codex exec` cannot ask before a tool runs; the service refuses require_approval "always".
    out.push(`default_tools_approval_mode = "approve"`);
    if (m.allowedTools) out.push(`enabled_tools = ${tomlValue(m.allowedTools)}`);
    out.push("");
  }
  return out.join("\n");
}

/** Profile (config layer) name for one turn: `<CODEX_HOME>/<name>.config.toml`. */
export function profileName(responseId: string): string {
  return `greyfolk-${responseId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/**
 * The tail of the engine's stderr for an error message, cut short and with anything that looks
 * like a credential blanked: the full text stays in greyfolk's own stderr only.
 */
export function redacted(stderr: string): string {
  const text = stderr
    .replace(/\bbearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|token|api[_-]?key|secret|password)(["']?\s*[:=]\s*["']?)(?!Bearer \[redacted\])[^\s"',&]+/gi, "$1$2[redacted]")
    .replace(/([?&])(access_token|token|key|sig)=[^&\s]+/gi, "$1$2=[redacted]")
    .trim();
  if (!text) return "";
  return `: ${text.length > 400 ? `…${text.slice(-400)}` : text}`;
}

/** Builds the `codex exec` argv for one turn. */
export function buildArgs(o: { soulFile: string; agentDir: string; profile: string | null; model: string | null; threadId: string | null; disabled: ReadonlySet<ToolKind> }): string[] {
  const args = ["exec", "--experimental-json", "--skip-git-repo-check", "--cd", o.agentDir, "--sandbox", o.disabled.has("files") ? "read-only" : "workspace-write"];
  const cfg = [`model_instructions_file=${tomlValue(o.soulFile)}`, "project_doc_max_bytes=0", 'approval_policy="never"'];
  if (o.disabled.has("web")) cfg.push('web_search="disabled"');
  for (const c of cfg) args.push("--config", c);
  for (const f of featuresOf(o.disabled)) args.push("--disable", f);
  if (o.profile) args.push("--profile", o.profile);
  if (o.model) args.push("--model", o.model);
  if (o.threadId) args.push("resume", o.threadId);
  // Prompt comes on stdin ("-").
  args.push("-");
  return args;
}

interface LiveTurn {
  child: ChildProcess;
  stderr: string[];
}

export class CodexEngine implements Engine {
  readonly name = "codex";
  /** OpenAI model names (`gpt-*`, `o*`, `codex*`); `--model request` may choose within this family only. */
  readonly modelFamily = /^(gpt-|o[1-9]|codex)/i;
  /** `codex exec` cannot ask before a tool runs (§9.11). */
  readonly canAskApproval = false;
  private readonly opts: CodexEngineOptions;
  private sid: string | null = null;
  private live: LiveTurn | null = null;
  /** Between `run` starting and the process existing (so a cancel then is not lost). */
  private starting = false;
  private cancelRequested = false;

  constructor(opts: CodexEngineOptions) {
    this.opts = opts;
  }

  private get codexHome(): string {
    return this.opts.agentDir;
  }

  private get soulFile(): string {
    return path.join(this.opts.agentDir, SOUL_FILE);
  }

  private get binary(): string {
    const fromOption = this.opts.values.get("codex-bin");
    return this.opts.codexPath ?? (typeof fromOption === "string" ? fromOption : "codex");
  }

  async start(sessionId: string | null): Promise<void> {
    const st = await fs.stat(this.opts.agentDir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`agent folder not found: ${this.opts.agentDir}`);
    if (!this.opts.soul.trim()) throw new Error("the soul (agent instruction file) is empty; refusing to start an engine without one");
    checkExecPrefix(this.opts.exec);
    // MCP servers come only from the request (as Claude's strictMcpConfig): the folder's own config may name none.
    const config = await fs.readFile(path.join(this.codexHome, "config.toml"), "utf8").catch(() => "");
    if (/^\s*\[\s*mcp_servers\b/m.test(config)) throw new Error(`${path.join(this.codexHome, "config.toml")} names MCP servers; greyfolk attaches only the request's (remove the [mcp_servers] tables)`);
    if (featuresOf(this.opts.disabledTools).length) await this.confirmFeatures();
    await fs.mkdir(path.dirname(this.soulFile), { recursive: true });
    await fs.writeFile(this.soulFile, this.opts.soul, "utf8");
    this.sid = sessionId;
  }

  /** Fail closed: every feature greyfolk disables must be one this Codex knows (else it may stay on under another name). */
  private async confirmFeatures(): Promise<void> {
    let out: string;
    try {
      ({ stdout: out } = await promisify(execFile)(this.binary, ["features", "list"], { env: this.buildEnv() }));
    } catch (err) {
      throw new Error(`cannot confirm Codex host tools are off (codex features list failed: ${(err as Error).message})`);
    }
    const rows = out.split("\n").map((l) => l.trim().split(/\s+/)).filter((r) => r[0]);
    const known = new Set(rows.map((r) => r[0]!));
    const off = featuresOf(this.opts.disabledTools);
    const missing = off.filter((f) => !known.has(f));
    if (missing.length) throw new Error(`cannot confirm Codex host tools are off: this Codex does not know ${missing.join(", ")}`);
    if (TOOL_KINDS.every((k) => this.opts.disabledTools.has(k))) {
      // Every kind off: whatever stays enabled must be known to reach no host resource.
      const unknown = rows.filter((r) => r.at(-1) === "true" && r[1] !== "removed" && !off.includes(r[0]!) && !NON_HOST_FEATURES.includes(r[0]!)).map((r) => r[0]!);
      if (unknown.length) throw new Error(`cannot confirm Codex host tools are off: enabled features not yet classified for this Codex version: ${unknown.join(", ")}`);
    }
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, this.opts.env ?? {});
    env.CODEX_HOME = this.codexHome;
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "greyfolk";
    return env;
  }

  async run(turn: Turn, req: EngineTurn): Promise<TurnEnd> {
    if (this.live || this.starting) throw new Error("codex engine: a turn is already running");
    if (turn.cancelRequested) return { status: "cancelled", error: null, usage: null };
    this.cancelRequested = false;
    this.starting = true;
    // MCP servers (with their authorization headers) go through a private per-turn config layer, never argv.
    const profile = req.mcp.length ? profileName(turn.firstResponseId) : null;
    const profileFile = profile ? path.join(this.codexHome, `${profile}.config.toml`) : null;
    try {
      if (profileFile) {
        await fs.rm(profileFile, { force: true });
        await fs.writeFile(profileFile, mcpProfileToml(req.mcp), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await fs.chmod(profileFile, 0o600);
      }
    } finally {
      this.starting = false;
    }
    const args = buildArgs({ soulFile: this.soulFile, agentDir: this.opts.agentDir, profile, model: req.model, threadId: this.sid, disabled: this.opts.disabledTools });
    if (this.cancelRequested || turn.cancelRequested) {
      if (profileFile) await fs.rm(profileFile, { force: true });
      return { status: "cancelled", error: null, usage: null };
    }
    const child = spawnGroup(this.opts.exec, this.binary, args, { cwd: this.opts.agentDir, env: this.buildEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const live: LiveTurn = { child, stderr: [] };
    this.live = live;
    let spawnError: Error | null = null;
    child.once("error", (e) => (spawnError = e));
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      live.stderr.push(s);
      process.stderr.write(`[codex] ${s}`);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.stdin?.on("error", () => {
      /* the engine may exit before reading */
    });
    child.stdin?.end(foldInput(req.input, req.instructions));

    let end: TurnEnd | null = null;
    const errors: string[] = [];
    try {
      if (!child.stdout) throw new Error("codex: no stdout");
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        let ev: ThreadEvent;
        try {
          ev = JSON.parse(line) as ThreadEvent;
        } catch {
          continue;
        }
        end = await this.apply(ev, turn, errors);
        if (end) break;
      }
      const { code, signal } = await exited;
      if (spawnError) throw spawnError;
      if (!end) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        end = this.cancelRequested
          ? { status: "cancelled", error: null, usage: null }
          : { status: "failed", error: `codex exec ended (${detail}) without completing the turn${redacted(live.stderr.join(""))}`, usage: null };
      }
    } catch (err) {
      end = { status: this.cancelRequested ? "cancelled" : "failed", error: err instanceof Error ? err.message : String(err), usage: null };
    } finally {
      this.live = null;
      killGroup(child);
      if (profileFile) await fs.rm(profileFile, { force: true });
    }
    return end;
  }

  /** Writes one Codex JSONL event into the turn; returns the turn's end when it ends. */
  private async apply(ev: ThreadEvent, turn: Turn, errors: string[]): Promise<TurnEnd | null> {
    const stopped = (): "cancelled" | "failed" => (this.cancelRequested ? "cancelled" : "failed");
    switch (ev.type) {
      case "thread.started":
        if (ev.thread_id && ev.thread_id !== this.sid) {
          this.sid = ev.thread_id;
          await turn.sessionStarted(this.sid);
        }
        return null;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.applyItem(ev.type, ev.item, turn, errors);
        return null;
      case "turn.completed":
        return { status: this.cancelRequested ? "cancelled" : "completed", error: null, usage: ev.usage ? usage(ev.usage.input_tokens, ev.usage.output_tokens) : null };
      case "turn.failed":
        return { status: stopped(), error: ev.error?.message ?? (errors.join("\n") || "turn failed"), usage: null };
      case "error":
        return { status: stopped(), error: ev.message, usage: null };
      default:
        return null;
    }
  }

  private applyItem(phase: "item.started" | "item.updated" | "item.completed", item: ThreadItem, turn: Turn, errors: string[]): void {
    switch (item.type) {
      case "agent_message":
        // The JSONL protocol carries whole messages, not deltas.
        if (phase === "item.completed" && item.text) turn.textDone(item.text);
        return;
      case "reasoning":
        if (phase === "item.completed" && item.text) turn.reasoning(item.text);
        return;
      case "mcp_tool_call":
        if (phase === "item.started") turn.mcpCallStarted(item.id, { server: item.server, name: item.tool, arguments: item.arguments });
        if (phase === "item.completed") {
          const output = item.result ? item.result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n") : "";
          turn.mcpCallEnded(item.id, output, item.error?.message ?? (item.status === "failed" ? "failed" : null));
        }
        return;
      case "command_execution":
        if (phase === "item.started") turn.mcpCallStarted(item.id, { server: null, name: "shell", arguments: { command: item.command } });
        if (phase === "item.completed") {
          const failed = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
          turn.mcpCallEnded(item.id, item.aggregated_output, failed ? `exit ${item.exit_code ?? "?"}` : null);
        }
        return;
      case "file_change":
        if (phase === "item.completed") {
          turn.mcpCallStarted(item.id, { server: null, name: "apply_patch", arguments: { changes: item.changes } });
          turn.mcpCallEnded(item.id, item.changes.map((c) => `${c.kind} ${c.path}`).join("\n"), item.status === "failed" ? "failed" : null);
        }
        return;
      case "web_search":
        if (phase === "item.started") turn.mcpCallStarted(item.id, { server: null, name: "web_search", arguments: { query: item.query } });
        if (phase === "item.completed") turn.mcpCallEnded(item.id, "", null);
        return;
      case "error":
        errors.push(item.message);
        return;
      default:
        return;
    }
  }

  async steer(_turn: Turn, _steer: QueuedSteer): Promise<boolean> {
    return false;
  }

  async cancel(): Promise<void> {
    const live = this.live;
    if (this.starting) this.cancelRequested = true;
    if (!live) return;
    this.cancelRequested = true;
    killGroup(live.child, "SIGINT");
    setTimeout(() => killGroup(live.child, "SIGKILL"), 3000).unref();
  }

  state(): EngineState {
    return { running: this.live !== null, sessionId: this.sid, model: null, subagents: { running: 0, lost: [] }, subagentProfileApplied: false };
  }

  /** The rollout JSONL Codex writes under `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<thread id>.jsonl`. */
  async sessionFile(): Promise<string | null> {
    if (!this.sid) return null;
    const root = path.join(this.codexHome, "sessions");
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.endsWith(`${this.sid}.jsonl`)) return p;
      }
    }
    return null;
  }

  async history(): Promise<HistoryMessage[]> {
    const file = await this.sessionFile();
    if (!file) return [];
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const out: HistoryMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec: { timestamp?: string; type?: string; payload?: { type?: string; role?: string; content?: unknown } };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue;
      }
      if (rec.type !== "response_item" || rec.payload?.type !== "message") continue;
      const role = rec.payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = textOf(rec.payload.content);
      // Codex injects context blocks as user messages; they are not conversation.
      if (!text || (role === "user" && /^<(environment_context|user_instructions|turn_aborted|permissions)/.test(text))) continue;
      out.push({ role, text, at: rec.timestamp ?? null });
    }
    return out;
  }

  exportExcludes(): string[] {
    // The session index is rebuilt by the engine; credentials never travel with a copy.
    return ["state_*.sqlite*", "auth.json", "log", "logs", "log_*", "tmp", "cache", "greyfolk-*.config.toml"];
  }

  sessionPaths(): string[] {
    return ["sessions", "archived_sessions", "history.jsonl", "state_db.sqlite", "state_db.sqlite-wal", "state_db.sqlite-shm", "memories", "shell_snapshots"];
  }

  async stop(): Promise<void> {
    if (this.live) await this.cancel();
  }
}

registerEngine({
  name: "codex",
  needsSoul: true,
  options: [{ name: "codex-bin", kind: "string", help: "codex engine: the Codex CLI binary (default: codex on PATH)" }],
  create: (o: EngineOptions) => new CodexEngine(o),
});
