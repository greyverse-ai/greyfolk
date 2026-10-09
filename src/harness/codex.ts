/**
 * Codex harness (spec §1, §3, §4; open items §9.10 / §9.11).
 *
 * - One `codex exec --experimental-json` process per turn, started through the `--harness-exec`
 *   launcher (the Codex SDK spawns the binary itself and cannot take a launcher prefix, so greyfolk
 *   speaks the SDK's JSONL event protocol directly and reuses the SDK's event types).
 * - Everything loads from the agent folder: `CODEX_HOME` = cwd = agent folder; project docs
 *   (`AGENTS.md` in the cwd tree) are off (`project_doc_max_bytes=0`); the soul is handed over as
 *   the model instructions file (replaces Codex's default prompt); MCP servers come only from the
 *   request, written to a per-turn 0600 config layer `<CODEX_HOME>/<name>.config.toml` selected with
 *   `--profile <name>` and deleted after the turn (§9.10: process per turn). Nothing secret (MCP
 *   authorization headers, bridge environment) goes into argv.
 * - Resume: `codex exec resume <thread id>`; the thread id from `thread.started` goes to `onSessionId`.
 * - No mid-turn input (stdin is the prompt and closes), no interactive permission requests
 *   (`approval_policy=never`; §9.11), no observable subagents.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { ChildProcess } from "node:child_process";
import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import { killGroup, spawnThrough } from "./exec.js";
import type {
  Harness,
  HarnessCapabilities,
  HarnessEvent,
  HarnessInputItem,
  HarnessStartOptions,
  HarnessStatus,
  HarnessUsage,
  HistoryMessage,
  McpAttachment,
  SteerResult,
  SubagentResult,
  TurnRequest,
} from "./types.js";

/** Pinned SDK package (its event types are the wire contract); resume-from-copy is tested per version (§3). */
export const CODEX_SDK_VERSION = "0.161.0";

/** Where greyfolk writes the soul for the engine to read (inside the run dir, which exports leave out). */
export const SOUL_FILE = path.join(".greyfolk", "run", "soul.md");

export interface CodexHarnessOptions extends HarnessStartOptions {
  /** The engine binary (default: `codex` on PATH). */
  codexPath?: string;
  /** Extra environment for the engine process (never credentials from greyfolk itself). */
  env?: Record<string, string>;
  /** Sandbox for the engine's own shell tool (default `workspace-write`: the agent folder). */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
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
    out.push("");
  }
  return out.join("\n");
}

/** Profile (config layer) name for one turn: `<CODEX_HOME>/<name>.config.toml`. */
export function profileName(responseId: string): string {
  return `greyfolk-${responseId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Folds greyfolk input items into one prompt (same shape as the Claude harness). */
export function foldInput(items: HarnessInputItem[], instructions: string | null): string {
  const parts: string[] = [];
  if (instructions) parts.push(`<instructions>\n${instructions}\n</instructions>`);
  for (const it of items) {
    if (it.role === "user") parts.push(it.text);
    else parts.push(`<${it.role}>\n${it.text}\n</${it.role}>`);
  }
  return parts.join("\n\n");
}

/** Builds the `codex exec` argv for one turn. */
export function buildArgs(o: { soulFile: string; agentDir: string; profile: string | null; model: string | null; threadId: string | null; sandbox: string }): string[] {
  const args = ["exec", "--experimental-json", "--skip-git-repo-check", "--cd", o.agentDir, "--sandbox", o.sandbox];
  const cfg = [`model_instructions_file=${tomlValue(o.soulFile)}`, "project_doc_max_bytes=0", 'approval_policy="never"'];
  for (const c of cfg) args.push("--config", c);
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

export class CodexHarness implements Harness {
  readonly name = "codex";
  readonly capabilities: HarnessCapabilities = { midTurnInput: false, permissionRequests: false, subagents: false };
  /** OpenAI model names (`gpt-*`, `o*`, `codex*`); `--model request` may choose within this family only. */
  readonly modelFamily = /^(gpt-|o[1-9]|codex)/i;
  private readonly opts: CodexHarnessOptions;
  private sid: string | null;
  private model: string | null;
  private live: LiveTurn | null = null;
  private cancelRequested = false;

  constructor(opts: CodexHarnessOptions) {
    this.opts = opts;
    this.sid = opts.sessionId;
    this.model = opts.model;
  }

  get codexHome(): string {
    return this.opts.agentDir;
  }

  private get soulFile(): string {
    return path.join(this.opts.agentDir, SOUL_FILE);
  }

  async prepare(): Promise<void> {
    const st = await fs.stat(this.opts.agentDir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`agent folder not found: ${this.opts.agentDir}`);
    if (!this.opts.soul.trim()) throw new Error("the soul (agent instruction file) is empty; refusing to start a harness without one");
    await fs.mkdir(path.dirname(this.soulFile), { recursive: true });
    await fs.writeFile(this.soulFile, this.opts.soul, "utf8");
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, this.opts.env ?? {});
    env.CODEX_HOME = this.codexHome;
    env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "greyfolk";
    return env;
  }

  async *startTurn(req: TurnRequest): AsyncIterable<HarnessEvent> {
    if (this.live) throw new Error("codex harness: a turn is already running");
    this.cancelRequested = false;
    // MCP servers (with their authorization headers) go through a private per-turn config layer, never argv.
    const profile = req.mcp.length ? profileName(req.responseId) : null;
    const profileFile = profile ? path.join(this.codexHome, `${profile}.config.toml`) : null;
    if (profileFile) {
      await fs.rm(profileFile, { force: true });
      await fs.writeFile(profileFile, mcpProfileToml(req.mcp), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.chmod(profileFile, 0o600);
    }
    const args = buildArgs({
      soulFile: this.soulFile,
      agentDir: this.opts.agentDir,
      profile,
      model: req.model ?? this.opts.model,
      threadId: this.sid,
      sandbox: this.opts.sandbox ?? "workspace-write",
    });
    const child = spawnThrough(this.opts.harnessExec, this.opts.codexPath ?? "codex", args, {
      cwd: this.opts.agentDir,
      env: this.buildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const turn: LiveTurn = { child, stderr: [] };
    this.live = turn;
    let spawnError: Error | null = null;
    child.once("error", (e) => (spawnError = e));
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      turn.stderr.push(s);
      process.stderr.write(`[codex] ${s}`);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    child.stdin?.on("error", () => {
      /* the engine may exit before reading */
    });
    child.stdin?.end(foldInput(req.input, req.instructions));

    let done: Extract<HarnessEvent, { type: "done" }> | null = null;
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
        for (const out of this.mapEvent(ev, errors)) {
          if (out.type === "done") {
            done = out;
            break;
          }
          yield out;
        }
        if (done) break;
      }
      const { code, signal } = await exited;
      if (spawnError) throw spawnError;
      if (!done) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        done = this.cancelRequested
          ? { type: "done", status: "cancelled", error: null, usage: null }
          : { type: "done", status: "failed", error: `codex exec ended (${detail}) without completing the turn: ${turn.stderr.join("").trim()}`.trim(), usage: null };
      }
    } catch (err) {
      done = { type: "done", status: this.cancelRequested ? "cancelled" : "failed", error: err instanceof Error ? err.message : String(err), usage: null };
    } finally {
      this.live = null;
      killGroup(child);
      if (profileFile) await fs.rm(profileFile, { force: true });
    }
    yield done;
  }

  /** Maps one Codex JSONL event to greyfolk events. */
  private *mapEvent(ev: ThreadEvent, errors: string[]): Iterable<HarnessEvent> {
    switch (ev.type) {
      case "thread.started":
        if (ev.thread_id && ev.thread_id !== this.sid) {
          this.sid = ev.thread_id;
          this.opts.onSessionId(this.sid);
          yield { type: "session", sessionId: this.sid };
        }
        return;
      case "turn.started":
        return;
      case "item.started":
      case "item.updated":
      case "item.completed":
        yield* this.mapItem(ev.type, ev.item, errors);
        return;
      case "turn.completed": {
        const u = ev.usage;
        const usage: HarnessUsage | null = u ? { input_tokens: u.input_tokens, output_tokens: u.output_tokens, total_tokens: u.input_tokens + u.output_tokens } : null;
        yield { type: "done", status: this.cancelRequested ? "cancelled" : "completed", error: null, usage };
        return;
      }
      case "turn.failed":
        yield { type: "done", status: this.cancelRequested ? "cancelled" : "failed", error: ev.error?.message ?? errors.join("\n") ?? "turn failed", usage: null };
        return;
      case "error":
        yield { type: "done", status: this.cancelRequested ? "cancelled" : "failed", error: ev.message, usage: null };
        return;
      default:
        return;
    }
  }

  private *mapItem(phase: "item.started" | "item.updated" | "item.completed", item: ThreadItem, errors: string[]): Iterable<HarnessEvent> {
    switch (item.type) {
      case "agent_message":
        // The JSONL protocol carries whole messages, not deltas.
        if (phase === "item.completed" && item.text) {
          yield { type: "text_delta", text: item.text };
          yield { type: "message_done", text: item.text };
        }
        return;
      case "reasoning":
        if (phase === "item.completed" && item.text) yield { type: "reasoning", text: item.text };
        return;
      case "mcp_tool_call":
        if (phase === "item.started") yield { type: "tool_call", id: item.id, name: item.tool, server: item.server, arguments: item.arguments };
        if (phase === "item.completed") {
          const output = item.result ? item.result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n") : "";
          yield { type: "tool_result", id: item.id, output, error: item.error?.message ?? (item.status === "failed" ? "failed" : null) };
        }
        return;
      case "command_execution":
        if (phase === "item.started") yield { type: "tool_call", id: item.id, name: "shell", server: null, arguments: { command: item.command } };
        if (phase === "item.completed") {
          const failed = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
          yield { type: "tool_result", id: item.id, output: item.aggregated_output, error: failed ? `exit ${item.exit_code ?? "?"}` : null };
        }
        return;
      case "file_change":
        if (phase === "item.completed") {
          yield { type: "tool_call", id: item.id, name: "apply_patch", server: null, arguments: { changes: item.changes } };
          yield { type: "tool_result", id: item.id, output: item.changes.map((c) => `${c.kind} ${c.path}`).join("\n"), error: item.status === "failed" ? "failed" : null };
        }
        return;
      case "web_search":
        if (phase === "item.started") yield { type: "tool_call", id: item.id, name: "web_search", server: null, arguments: { query: item.query } };
        if (phase === "item.completed") yield { type: "tool_result", id: item.id, output: "", error: null };
        return;
      case "error":
        errors.push(item.message);
        return;
      default:
        return;
    }
  }

  onLateSubagentResult(_listener: (result: SubagentResult) => void): void {
    /* Codex runs no subagents greyfolk can observe. */
  }

  async steer(_steerId: string, _input: HarnessInputItem[]): Promise<SteerResult> {
    return "response_ended";
  }

  async cancel(): Promise<void> {
    const turn = this.live;
    if (!turn) return;
    this.cancelRequested = true;
    killGroup(turn.child, "SIGINT");
    setTimeout(() => killGroup(turn.child, "SIGKILL"), 3000).unref();
  }

  status(): HarnessStatus {
    return { state: this.live ? "running" : "idle", sessionId: this.sid, subagents: { running: 0, lost: [] }, model: this.model, subagentProfile: { name: this.opts.subagentProfile, applied: false } };
  }

  sessionId(): string | null {
    return this.sid;
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

  async close(): Promise<void> {
    if (this.live) await this.cancel();
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}
