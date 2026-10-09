/**
 * Claude Agent SDK harness (spec §1, §3, §4, §5).
 *
 * - Everything loads from the agent folder: `cwd` = `CLAUDE_CONFIG_DIR` = agent folder, setting
 *   sources limited to the folder's own `settings.json` (`CLAUDE_SETTING_SOURCES`; no project/local
 *   settings, no `CLAUDE.md` auto-load), MCP only from the request (`strictMcpConfig`), auto-memory
 *   off, the soul as the whole system prompt.
 * - One Claude Code process per turn (streaming input mode, so steer and interrupt work), started
 *   through the `--harness-exec` launcher so its process group can be killed on cancel.
 * - The session id the CLI reports is handed back (`onSessionId`); the next turn resumes it.
 * - Subagents: `SubagentStart`/`SubagentStop` hooks and `task_*` system messages. A result that is
 *   still pending when the turn ends keeps the process alive until it arrives and is then reported
 *   late (`onLateSubagentResult`) so greyfolk holds it (§5).
 */
import { promises as fs } from "node:fs";
import { loadSubagentProfile, profileDenial, profilePrompt, PROFILE_TOOLS, type SubagentProfile } from "./subagent-profile.js";
import * as path from "node:path";
import { query, type CanUseTool, type HookCallback, type McpServerConfig, type Options, type Query, type SDKMessage, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { ChildProcess } from "node:child_process";
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

/** Pinned engine package; resume-from-copy is tested per version (spec §3). */
export const CLAUDE_SDK_VERSION = "0.3.292";

export interface ClaudeHarnessOptions extends HarnessStartOptions {
  /** Injected `query` for tests; defaults to the SDK's. */
  queryFn?: typeof query;
  /** Extra environment for the CLI process (never credentials from greyfolk itself). */
  env?: Record<string, string>;
}

/** Push-driven async iterable: the SDK's streaming prompt. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined, done: true });
    this.waiters = [];
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/**
 * Setting sources Claude Code may read (spec §3): only `user`, which with `CLAUDE_CONFIG_DIR` = the agent
 * folder is that folder's own `settings.json` (tool permissions etc.). `project`/`local` stay off, so no
 * `.claude/settings.json`, `.mcp.json` or `CLAUDE.md` is loaded on its own; the soul goes in explicitly.
 */
export const CLAUDE_SETTING_SOURCES: SettingSource[] = ["user"];

export interface LiveTurn {
  query: Query;
  input: InputQueue;
  abort: AbortController;
  child: ChildProcess | null;
  /** Steers pushed but not yet seen by a model step. */
  pendingSteers: string[];
  resultSeen: boolean;
  /** Events raised by hooks between SDK messages. */
  pendingEvents: HarnessEvent[];
}

export function userMessage(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null } as SDKUserMessage;
}

/** Folds greyfolk input items into one prompt: developer/system items become tagged blocks ahead of the user text. */
export function foldInput(items: HarnessInputItem[], instructions: string | null): string {
  const parts: string[] = [];
  if (instructions) parts.push(`<instructions>\n${instructions}\n</instructions>`);
  for (const it of items) {
    if (it.role === "user") parts.push(it.text);
    else parts.push(`<${it.role}>\n${it.text}\n</${it.role}>`);
  }
  return parts.join("\n\n");
}

export function toMcpServers(mcp: McpAttachment[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const m of mcp) {
    if (m.kind === "http") out[m.label] = { type: "http", url: m.url, headers: m.headers };
    else out[m.label] = { type: "stdio", command: m.command, args: m.args, env: m.env };
  }
  return out;
}

/** Claude Code names a project folder by replacing every non-alphanumeric character of the cwd with '-'. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export class ClaudeHarness implements Harness {
  readonly name = "claude";
  readonly capabilities: HarnessCapabilities = { midTurnInput: true, permissionRequests: true, subagents: true };
  /** Anthropic model names; `--model request` may choose within this family only. */
  readonly modelFamily = /^claude-/i;
  private readonly opts: ClaudeHarnessOptions;
  private readonly queryFn: typeof query;
  private sid: string | null;
  private model: string | null;
  private live: LiveTurn | null = null;
  /** A finished turn whose process stays alive for pending subagent results. */
  private lingering: LiveTurn | null = null;
  private readonly runningSubagents = new Map<string, string | null>();
  private readonly lost: string[] = [];
  private lateListener: ((r: SubagentResult) => void) | null = null;
  private cancelRequested = false;
  /** Resolved `--subagent-profile`, loaded in `prepare()`. */
  profile: SubagentProfile | null = null;

  constructor(opts: ClaudeHarnessOptions) {
    this.opts = opts;
    this.queryFn = opts.queryFn ?? query;
    this.sid = opts.sessionId;
    this.model = opts.model;
  }

  get configDir(): string {
    return this.opts.agentDir;
  }

  async prepare(): Promise<void> {
    const st = await fs.stat(this.opts.agentDir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`agent folder not found: ${this.opts.agentDir}`);
    if (!this.opts.soul.trim()) throw new Error("the soul (agent instruction file) is empty; refusing to start a harness without one");
    await fs.mkdir(path.join(this.configDir, "projects"), { recursive: true });
    if (this.opts.subagentProfile) this.profile = await loadSubagentProfile(this.opts.agentDir, this.opts.subagentProfile);
  }

  /** The SDK options one turn runs with (public so tests can check the isolation settings). */
  buildOptions(req: TurnRequest, turn: LiveTurn): Options {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...this.opts.env,
      CLAUDE_CONFIG_DIR: this.configDir,
      // No telemetry / auto-update side channels from inside an agent folder.
      DISABLE_AUTOUPDATER: "1",
    };
    const subagentHooks: HookCallback = async (input) => {
      if (input.hook_event_name === "SubagentStart") {
        this.runningSubagents.set(input.agent_id, input.agent_type);
        turn.pendingEvents.push({ type: "subagent_started", id: input.agent_id, description: input.agent_type });
      } else if (input.hook_event_name === "SubagentStop") {
        this.runningSubagents.delete(input.agent_id);
        turn.pendingEvents.push({ type: "subagent_finished", result: { id: input.agent_id, status: "completed", output: input.last_assistant_message ?? "" } });
      }
      return { continue: true };
    };
    const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
      const decision = await req.onPermissionRequest({ tool: toolName, operation: input, signal });
      return decision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Denied through greyfolk." };
    };
    const profile = this.profile;
    const profileGuard: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse" || !profile) return { continue: true };
      // Only calls from inside a subagent (agent_id present) are confined; the main thread keeps its permissions.
      if (!input.agent_id) return { continue: true };
      const reason = profileDenial(profile, input.tool_name, input.tool_input);
      if (!reason) return { continue: true };
      return { continue: true, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
    };
    const options: Options = {
      cwd: this.opts.agentDir,
      env,
      abortController: turn.abort,
      systemPrompt: this.opts.soul,
      settingSources: CLAUDE_SETTING_SOURCES,
      strictMcpConfig: true,
      mcpServers: toMcpServers(req.mcp),
      managedSettings: { autoMemoryEnabled: false },
      permissionMode: "default",
      canUseTool,
      includePartialMessages: true,
      persistSession: true,
      hooks: { SubagentStart: [{ hooks: [subagentHooks] }], SubagentStop: [{ hooks: [subagentHooks] }], ...(profile ? { PreToolUse: [{ hooks: [profileGuard] }] } : {}) },
      spawnClaudeCodeProcess: (o) => {
        const child = spawnThrough(this.opts.harnessExec, o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
        turn.child = child;
        child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[claude] ${d.toString()}`));
        return {
          stdin: child.stdin!,
          stdout: child.stdout!,
          get killed() {
            return child.killed;
          },
          get exitCode() {
            return child.exitCode;
          },
          get signalCode() {
            return child.signalCode;
          },
          kill: (signal) => {
            killGroup(child, signal);
            return true;
          },
          on: (event: "exit" | "error", listener: (...args: never[]) => void) => void child.on(event, listener as () => void),
          once: (event: "exit" | "error", listener: (...args: never[]) => void) => void child.once(event, listener as () => void),
          off: (event: "exit" | "error", listener: (...args: never[]) => void) => void child.off(event, listener as () => void),
        };
      },
    };
    if (profile) {
      // Spec §5: read-only paths, one writable folder, no MCP tools — as an agent definition (what a
      // profiled subagent is given) plus the PreToolUse guard above (what every subagent may do).
      options.agents = { [profile.name]: { description: profile.description, prompt: profilePrompt(profile), tools: PROFILE_TOOLS, disallowedTools: ["mcp__*"] } };
    }
    const model = req.model ?? this.opts.model;
    if (model) options.model = model;
    if (this.sid) options.resume = this.sid;
    return options;
  }

  async *startTurn(req: TurnRequest): AsyncIterable<HarnessEvent> {
    if (this.live) throw new Error("claude harness: a turn is already running");
    if (this.lingering) this.dropLingering();
    this.cancelRequested = false;
    const input = new InputQueue();
    const turn: LiveTurn = {
      query: null as unknown as Query,
      input,
      abort: new AbortController(),
      child: null,
      pendingSteers: [],
      resultSeen: false,
      pendingEvents: [],
    };
    turn.query = this.queryFn({ prompt: input, options: this.buildOptions(req, turn) });
    this.live = turn;
    input.push(userMessage(foldInput(req.input, req.instructions)));

    let textOpen = "";
    let done: Extract<HarnessEvent, { type: "done" }> | null = null;
    try {
      for await (const msg of turn.query) {
        while (turn.pendingEvents.length) yield turn.pendingEvents.shift()!;
        for (const ev of this.mapMessage(msg, turn)) {
          if (ev.type === "text_delta") textOpen += ev.text;
          if (ev.type === "message_done") textOpen = "";
          if (ev.type === "done") {
            done = ev;
            break;
          }
          yield ev;
        }
        if (done) break;
      }
      while (turn.pendingEvents.length) yield turn.pendingEvents.shift()!;
      if (!done) done = { type: "done", status: this.cancelRequested ? "cancelled" : "failed", error: this.cancelRequested ? null : "Claude Code ended without a result.", usage: null };
    } catch (err) {
      done = { type: "done", status: this.cancelRequested ? "cancelled" : "failed", error: err instanceof Error ? err.message : String(err), usage: null };
    } finally {
      this.live = null;
      turn.resultSeen = true;
      if (this.runningSubagents.size > 0 && !this.cancelRequested && done?.status === "completed") {
        // Background subagents are still inside this process: keep it alive and take their results late.
        this.lingering = turn;
        void this.drainLate(turn);
      } else {
        input.close();
        if (this.runningSubagents.size > 0) {
          for (const id of this.runningSubagents.keys()) this.lost.push(id);
          this.runningSubagents.clear();
        }
        if (turn.child) killGroup(turn.child);
      }
    }
    if (textOpen) yield { type: "message_done", text: textOpen };
    yield done;
  }

  /** Maps one SDK message to greyfolk events. */
  private *mapMessage(msg: SDKMessage, turn: LiveTurn): Iterable<HarnessEvent> {
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          if (msg.session_id && msg.session_id !== this.sid) {
            this.sid = msg.session_id;
            this.opts.onSessionId(this.sid);
            yield { type: "session", sessionId: this.sid };
          }
          if (msg.model) this.model = msg.model;
        } else if (msg.subtype === "task_started") {
          this.runningSubagents.set(msg.task_id, msg.description);
          yield { type: "subagent_started", id: msg.task_id, description: msg.description };
        } else if (msg.subtype === "task_notification") {
          this.runningSubagents.delete(msg.task_id);
          yield { type: "subagent_finished", result: { id: msg.task_id, status: msg.status, output: msg.summary } };
        }
        return;
      }
      case "stream_event": {
        if (msg.parent_tool_use_id) return;
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield { type: "text_delta", text: ev.delta.text };
        return;
      }
      case "assistant": {
        if (msg.parent_tool_use_id) return;
        if (turn.pendingSteers.length) {
          for (const s of turn.pendingSteers) yield { type: "steer_taken_in", steerId: s };
          turn.pendingSteers = [];
        }
        for (const block of msg.message.content) {
          if (block.type === "text") yield { type: "message_done", text: block.text };
          else if (block.type === "thinking") yield { type: "reasoning", text: block.thinking };
          else if (block.type === "tool_use") {
            const server = block.name.startsWith("mcp__") ? block.name.split("__")[1] ?? null : null;
            yield { type: "tool_call", id: block.id, name: block.name, server, arguments: block.input };
          }
        }
        return;
      }
      case "user": {
        if (msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type === "tool_result") {
            const out = typeof block.content === "string" ? block.content : (block.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
            yield { type: "tool_result", id: block.tool_use_id, output: out, error: block.is_error ? out : null };
          }
        }
        return;
      }
      case "result": {
        const usage: HarnessUsage | null = msg.usage
          ? { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens, total_tokens: msg.usage.input_tokens + msg.usage.output_tokens }
          : null;
        if (msg.subtype === "success" && !msg.is_error) yield { type: "done", status: "completed", error: null, usage };
        else {
          const error = msg.subtype === "success" ? msg.result : `Claude Code ended the turn: ${msg.subtype}`;
          yield { type: "done", status: this.cancelRequested ? "cancelled" : "failed", error, usage };
        }
        return;
      }
      default:
        return;
    }
  }

  /** After the turn ended: wait for background subagent results, then let the process go. */
  private async drainLate(turn: LiveTurn): Promise<void> {
    try {
      for await (const msg of turn.query) {
        if (msg.type === "system" && msg.subtype === "task_notification") {
          this.runningSubagents.delete(msg.task_id);
          this.lateListener?.({ id: msg.task_id, status: msg.status, output: msg.summary });
        }
        if (this.runningSubagents.size === 0) break;
      }
    } catch {
      /* the process went away */
    } finally {
      if (this.lingering === turn) this.dropLingering();
    }
  }

  private dropLingering(): void {
    const t = this.lingering;
    if (!t) return;
    this.lingering = null;
    for (const id of this.runningSubagents.keys()) this.lost.push(id);
    this.runningSubagents.clear();
    t.input.close();
    t.abort.abort();
    if (t.child) killGroup(t.child);
  }

  onLateSubagentResult(listener: (result: SubagentResult) => void): void {
    this.lateListener = listener;
  }

  async steer(steerId: string, input: HarnessInputItem[]): Promise<SteerResult> {
    const turn = this.live;
    if (!turn || turn.resultSeen || turn.input.isClosed) return "response_ended";
    turn.pendingSteers.push(steerId);
    turn.input.push(userMessage(foldInput(input, null)));
    return "taken_in";
  }

  async cancel(): Promise<void> {
    const turn = this.live;
    if (!turn) return;
    this.cancelRequested = true;
    try {
      await turn.query.interrupt();
    } catch {
      /* fall through to the hard stop */
    }
    turn.input.close();
    turn.abort.abort();
    if (turn.child) killGroup(turn.child);
  }

  status(): HarnessStatus {
    return { state: this.live ? "running" : "idle", sessionId: this.sid, subagents: { running: this.runningSubagents.size, lost: [...this.lost] }, model: this.model, subagentProfile: { name: this.opts.subagentProfile, applied: this.profile !== null } };
  }

  sessionId(): string | null {
    return this.sid;
  }

  /** The session JSONL Claude Code writes under `<config>/projects/<cwd>/<session id>.jsonl`. */
  async sessionFile(): Promise<string | null> {
    if (!this.sid) return null;
    const direct = path.join(this.configDir, "projects", projectDirName(this.opts.agentDir), `${this.sid}.jsonl`);
    if (await exists(direct)) return direct;
    const projects = path.join(this.configDir, "projects");
    const dirs = await fs.readdir(projects).catch(() => [] as string[]);
    for (const d of dirs) {
      const p = path.join(projects, d, `${this.sid}.jsonl`);
      if (await exists(p)) return p;
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
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if ((rec.type !== "user" && rec.type !== "assistant") || rec.isMeta === true) continue;
      const message = rec.message as { role?: string; content?: unknown } | undefined;
      if (!message) continue;
      const text = textOf(message.content);
      if (!text) continue;
      out.push({ role: rec.type === "user" ? "user" : "assistant", text, at: typeof rec.timestamp === "string" ? rec.timestamp : null });
    }
    return out;
  }

  exportExcludes(): string[] {
    // Credentials never travel with a copy; the rest the CLI rebuilds.
    return [".credentials.json", "statsig", "shell-snapshots", "debug", "cache", "telemetry", "todos", "plugins/cache", "file-history", ".update.lock"];
  }

  sessionPaths(): string[] {
    return ["projects", "todos", "shell-snapshots", "file-history", "history.jsonl", "memory"];
  }

  async close(): Promise<void> {
    if (this.live) await this.cancel();
    if (this.lingering) this.dropLingering();
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
