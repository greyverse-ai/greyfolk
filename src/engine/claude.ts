/**
 * Claude engine: the Claude Agent SDK (spec §1, §3, §4, §5).
 *
 * - One Claude Code process carries the session across turns (streaming input): each turn is one
 *   user message into it, so native subagents keep running between turns and Claude Code itself
 *   carries a late result into the session, as it does on its own (§5). The process is a child of greyfolk in its own process group (started through
 *   `--engine-exec` when given) and is restarted with `resume` if it dies.
 * - Everything loads from the agent folder: `cwd` = `CLAUDE_CONFIG_DIR` = agent folder, setting
 *   sources limited to the folder's own `settings.json`, auto-memory off, the soul as the whole
 *   system prompt, and no MCP server but the request's (`strictMcpConfig`).
 * - A turn's MCP servers reach the CLI over its control channel (`setMcpServers`), never argv, so
 *   per-turn credentials do not show in the process list.
 * - Before any MCP tool runs, a `PreToolUse` hook enforces the request's `allowed_tools` and
 *   `require_approval` (asking the caller), ahead of any allow rule in the folder's settings.
 * - Tool kinds turned off map to Claude Code's built-in tools (shell, files, web); with every
 *   kind off only the non-host built-ins remain, and the session's `init` tool list must hold
 *   nothing else (an allow-list; anything unknown fails the turn before a tool can run).
 * - Native subagents are Claude Code's own internal tool (`Agent`), which the model calls itself;
 *   greyfolk only reports their start and end (`task_started` / `task_notification`).
 * - Steer = a user message pushed mid-turn with its own uuid; it is taken in at the first frame
 *   Claude stamps with that uuid (`user_message_uuid`). A steer the CLI only reaches after the
 *   turn's result opens the successor response when its stamped reply starts.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { query, type HookCallback, type McpServerConfig, type Options, type Query, type SDKMessage, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { HistoryMessage } from "../api/types.js";
import type { QueuedSteer } from "../common/steer-queue.js";
import { usage, type Turn, type TurnEnd } from "../common/turn.js";
import { exists, isInside } from "../common/fsutil.js";
import type { McpAttachment } from "../mcp/translate.js";
import { TOOL_KINDS, type ToolKind } from "../options.js";
import type { Engine, EngineOptions, EngineState, EngineTurn } from "./engine.js";
import { checkExecPrefix, killGroup, spawnGroup } from "./process.js";
import { foldInput, textOf } from "./prompt.js";
import { registerEngine } from "./registry.js";
import { mcpToolAllowed, type SubagentProfile } from "./subagent-profile.js";

/** Pinned engine package; the tool lists below and resume-from-copy are checked per version (spec §3). */
export const CLAUDE_SDK_VERSION = "0.3.292";

/**
 * Setting sources Claude Code may read (spec §3): only `user`, which with `CLAUDE_CONFIG_DIR` = the
 * agent folder is that folder's own `settings.json`. `project`/`local` stay off.
 */
export const CLAUDE_SETTING_SOURCES: SettingSource[] = ["user"];

/** Claude Code's built-in tools per tool kind (kinds with none are simply nothing to turn off). */
export const TOOLS_BY_KIND: Record<ToolKind, string[]> = {
  shell: ["Bash", "BashOutput", "KillShell", "Monitor", "PowerShell"],
  files: ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS", "LSP"],
  web: ["WebFetch", "WebSearch"],
  browser: [],
  images: [],
  apps: [],
};

/** Built-in tools of every host kind. */
export const HOST_TOOLS = Object.values(TOOLS_BY_KIND).flat();

/** The only built-ins kept with every host kind off: native subagents and the todo list. */
export const NON_HOST_TOOLS = ["Agent", "TodoWrite"];
/** Built-ins that read the request's own MCP resources; allowed with every host kind off. */
const MCP_RESOURCE_TOOLS = ["ListMcpResourcesTool", "ReadMcpResourceTool"];

/** Built-in tools a profiled subagent gets when host tools are on (no shell: it could write anywhere). */
export const PROFILE_HOST_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit"];

const WRITING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function toolsOf(kinds: Iterable<ToolKind>): string[] {
  return [...kinds].flatMap((k) => TOOLS_BY_KIND[k]);
}

export interface ClaudeEngineOptions extends EngineOptions {
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

/** The one Claude Code process. */
export interface Proc {
  query: Query;
  input: InputQueue;
  abort: AbortController;
  child: ChildProcess | null;
  /** The `init` tool list was checked. */
  checked: boolean;
}

/** The turn being served. */
interface Active {
  turn: Turn;
  mcp: Map<string, McpAttachment>;
  /** Steers pushed and not yet taken in: uuid → steer id. */
  steers: Map<string, string>;
  end: (e: TurnEnd) => void;
  cancelled: boolean;
  error: string | null;
  /** The turn's message is in; frames before that belong to a step Claude Code ran on its own. */
  sent: boolean;
}

export function userMessage(text: string, uuid?: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, ...(uuid ? { uuid } : {}) } as SDKUserMessage;
}

export function toMcpServers(mcp: McpAttachment[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const m of mcp) {
    if (m.kind === "http") out[m.label] = { type: "http", url: m.url, headers: m.headers };
    else out[m.label] = { type: "stdio", command: m.command, args: m.args, env: m.env };
  }
  return out;
}

/** `mcp__<label>__<tool>` → `{label, tool}`, or null for a built-in tool. */
export function splitMcpToolName(name: string): { label: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const i = rest.indexOf("__");
  return i < 0 ? null : { label: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/** Claude Code names a project folder by replacing every non-alphanumeric character of the cwd with '-'. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Decides a subagent's tool call under the profile: null = fine, string = reason to deny. */
export function profileDenial(p: SubagentProfile, toolName: string, input: unknown): string | null {
  const mcp = splitMcpToolName(toolName);
  if (mcp) return mcpToolAllowed(p, `${mcp.label}__${mcp.tool}`) ? null : `subagent profile '${p.name}': ${toolName} is not among its MCP tools`;
  if (WRITING_TOOLS.has(toolName)) {
    const file = (input as { file_path?: unknown; notebook_path?: unknown } | null)?.file_path ?? (input as { notebook_path?: unknown } | null)?.notebook_path;
    if (typeof file !== "string") return `subagent profile '${p.name}': ${toolName} without a file path`;
    if (!p.writable || !isInside(p.writable, file)) return `subagent profile '${p.name}': ${file} lies outside its writable folder`;
  }
  return null;
}

/** The uuids of user messages a frame answers (Claude stamps replies with them). */
function stampsOf(msg: SDKMessage): string[] {
  const m = msg as { user_message_uuid?: string; user_message_uuids?: string[] };
  return [...(m.user_message_uuid ? [m.user_message_uuid] : []), ...(m.user_message_uuids ?? [])];
}

const denyHook = (reason: string) => ({ continue: true, hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } });
const allowHook = () => ({ continue: true, hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const } });

export class ClaudeEngine implements Engine {
  readonly name = "claude";
  /** Anthropic model names; `--model request` may choose within this family only. */
  readonly modelFamily = /^claude-/i;
  readonly canAskApproval = true;
  private readonly opts: ClaudeEngineOptions;
  private readonly queryFn: typeof query;
  private readonly offTools: string[];
  private readonly noHostTools: boolean;
  private sid: string | null = null;
  private model: string | null = null;
  private proc: Proc | null = null;
  private active: Active | null = null;
  /** Native subagents still running (the agent stays busy while any run). */
  private readonly subagents = new Set<string>();
  /**
   * Claude Code is running a step of its own between greyfolk's turns (it carries a late subagent
   * result into the session that way); the next turn's message waits until that step ends.
   */
  private ownStep = false;
  private ownStepDone: (() => void)[] = [];
  private readonly lost: string[] = [];
  /** The model the last turn's request chose, if any. */
  private requestedModel: string | null = null;

  constructor(opts: ClaudeEngineOptions) {
    this.opts = opts;
    this.queryFn = opts.queryFn ?? query;
    this.offTools = toolsOf(opts.disabledTools);
    this.noHostTools = TOOL_KINDS.every((k) => opts.disabledTools.has(k));
  }

  async start(sessionId: string | null): Promise<void> {
    const st = await fs.stat(this.opts.agentDir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`agent folder not found: ${this.opts.agentDir}`);
    if (!this.opts.soul.trim()) throw new Error("the soul (agent instruction file) is empty; refusing to start an engine without one");
    checkExecPrefix(this.opts.exec);
    await fs.mkdir(path.join(this.opts.agentDir, "projects"), { recursive: true });
    this.sid = sessionId;
  }

  /** The hook that runs before every tool call, ahead of Claude Code's own permission rules. */
  readonly preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const profile = this.opts.subagentProfile;
    if (profile && input.agent_id) {
      const reason = profileDenial(profile, input.tool_name, input.tool_input);
      if (reason) return denyHook(reason);
    }
    const mcp = splitMcpToolName(input.tool_name);
    if (!mcp) return { continue: true };
    const active = this.active;
    const server = active?.mcp.get(mcp.label);
    if (!active || !server) return denyHook(`MCP server '${mcp.label}' is not attached to this turn`);
    if (server.allowedTools && !server.allowedTools.includes(mcp.tool)) return denyHook(`${mcp.tool} is not among the allowed tools of '${mcp.label}'`);
    if (server.requireApproval === "never") return allowHook();
    const decision = await active.turn.askPermission({ tool: input.tool_name, operation: input.tool_input });
    return decision === "allow" ? allowHook() : denyHook("Denied through greyfolk.");
  };

  /** The SDK options the process starts with (public so tests can check the isolation settings). */
  buildOptions(proc: Pick<Proc, "abort" | "child">): Options {
    const env: Record<string, string | undefined> = { ...process.env, ...this.opts.env, CLAUDE_CONFIG_DIR: this.opts.agentDir, DISABLE_AUTOUPDATER: "1" };
    const profile = this.opts.subagentProfile;
    const options: Options = {
      cwd: this.opts.agentDir,
      env,
      abortController: proc.abort,
      systemPrompt: this.opts.soul,
      settingSources: CLAUDE_SETTING_SOURCES,
      strictMcpConfig: true,
      managedSettings: { autoMemoryEnabled: false },
      permissionMode: "default",
      canUseTool: async (toolName, input, { signal }) => {
        if (NON_HOST_TOOLS.includes(toolName) || splitMcpToolName(toolName)) return { behavior: "allow", updatedInput: input };
        const active = this.active;
        const decision = active ? await active.turn.askPermission({ tool: toolName, operation: input, signal }) : "deny";
        return decision === "allow" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Denied through greyfolk." };
      },
      includePartialMessages: true,
      persistSession: true,
      hooks: { PreToolUse: [{ hooks: [this.preToolUse] }] },
      spawnClaudeCodeProcess: (o) => {
        const child = spawnGroup(this.opts.exec, o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"] });
        proc.child = child;
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
    if (this.noHostTools) options.tools = NON_HOST_TOOLS;
    if (this.offTools.length) options.disallowedTools = this.offTools;
    if (profile) {
      options.agents = {
        [profile.name]: {
          description: profile.description,
          prompt: `${profile.description}\n\nYou work under a restricted profile. Report your result to the agent that spawned you.`,
          tools: [...(this.noHostTools ? [] : PROFILE_HOST_TOOLS.filter((t) => !this.offTools.includes(t))), "mcp__*"],
        },
      };
    }
    if (this.sid) options.resume = this.sid;
    return options;
  }

  private ensureProc(): Proc {
    if (this.proc) return this.proc;
    const proc: Proc = { abort: new AbortController(), child: null, input: new InputQueue(), query: null as unknown as Query, checked: false };
    proc.query = this.queryFn({ prompt: proc.input, options: this.buildOptions(proc) });
    this.proc = proc;
    void this.pump(proc);
    return proc;
  }

  /** Reads the process's messages for its whole life and routes them to the active turn. */
  private async pump(proc: Proc): Promise<void> {
    let error: string | null = null;
    try {
      for await (const msg of proc.query) await this.route(msg, proc);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    // The process is gone: anything still running in it is lost.
    if (this.proc === proc) this.proc = null;
    this.ownStep = false;
    for (const done of this.ownStepDone.splice(0)) done();
    for (const id of this.subagents) this.lost.push(id);
    this.subagents.clear();
    const a = this.active;
    if (a) this.finish(a, { status: a.cancelled ? "cancelled" : "failed", error: a.error ?? error ?? "Claude Code ended without a result.", usage: null });
  }

  private finish(a: Active, end: TurnEnd): void {
    if (this.active !== a) return;
    this.active = null;
    a.end(end);
  }

  /** Fails the turn and stops the process: used when the process breaks a rule greyfolk relies on. */
  private refuse(proc: Proc, reason: string): void {
    if (this.active) this.active.error = reason;
    this.kill(proc);
  }

  private async route(msg: SDKMessage, proc: Proc): Promise<void> {
    const a = this.active;
    if (msg.type === "system" && msg.subtype === "init") {
      if (!proc.checked) {
        const allowed = new Set([...NON_HOST_TOOLS, ...MCP_RESOURCE_TOOLS]);
        const on = msg.tools.filter((t) => !t.startsWith("mcp__") && (this.offTools.includes(t) || (this.noHostTools && !allowed.has(t))));
        if (on.length) return this.refuse(proc, `tools that were turned off are on (${on.join(", ")}); refusing the turn`);
        proc.checked = true;
      }
      if (msg.session_id && msg.session_id !== this.sid) {
        this.sid = msg.session_id;
        if (a) await a.turn.sessionStarted(this.sid);
      }
      if (msg.model) this.model = msg.model;
      return;
    }
    if (msg.type === "system" && msg.subtype === "task_started") {
      // Only native subagents count (not background shell or monitor tasks).
      if (msg.subagent_type) this.subagents.add(msg.task_id);
      return;
    }
    if (msg.type === "system" && msg.subtype === "task_notification") {
      this.subagents.delete(msg.task_id);
      return;
    }
    if (!a || !a.sent) {
      if (msg.type === "stream_event" || msg.type === "assistant" || msg.type === "user") this.ownStep = true;
      if (msg.type === "result") {
        this.ownStep = false;
        for (const done of this.ownStepDone.splice(0)) done();
      }
      return;
    }
    if ((msg.type === "stream_event" || msg.type === "assistant") && !msg.parent_tool_use_id) {
      for (const uuid of stampsOf(msg)) {
        const steerId = a.steers.get(uuid);
        if (!steerId) continue;
        a.steers.delete(uuid);
        a.turn.steerTakenIn(steerId);
      }
    }
    switch (msg.type) {
      case "stream_event": {
        if (msg.parent_tool_use_id) return;
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") a.turn.textDelta(ev.delta.text);
        return;
      }
      case "assistant": {
        if (msg.parent_tool_use_id) return;
        for (const block of msg.message.content) {
          if (block.type === "text") a.turn.textDone(block.text);
          else if (block.type === "thinking") a.turn.reasoning(block.thinking);
          else if (block.type === "tool_use") {
            const mcp = splitMcpToolName(block.name);
            a.turn.mcpCallStarted(block.id, { server: mcp?.label ?? null, name: mcp?.tool ?? block.name, arguments: block.input });
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
            a.turn.mcpCallEnded(block.tool_use_id, out, block.is_error ? out : null);
          }
        }
        return;
      }
      case "result": {
        // A steer the CLI has not reached yet runs right after this result as its own step;
        // the turn goes on until that step (stamped with the steer's uuid) has answered it.
        if (a.steers.size > 0 && !a.cancelled) return;
        const u = msg.usage ? usage(msg.usage.input_tokens, msg.usage.output_tokens) : null;
        if (a.cancelled) return this.finish(a, { status: "cancelled", error: null, usage: u });
        if (msg.subtype === "success" && !msg.is_error) return this.finish(a, { status: "completed", error: null, usage: u });
        return this.finish(a, { status: "failed", error: msg.subtype === "success" ? msg.result : `Claude Code ended the turn: ${msg.subtype}`, usage: u });
      }
      default:
        return;
    }
  }

  async run(turn: Turn, req: EngineTurn): Promise<TurnEnd> {
    if (this.active) throw new Error("claude engine: a turn is already running");
    if (turn.cancelRequested) return { status: "cancelled", error: null, usage: null };
    const proc = this.ensureProc();
    let active!: Active;
    const ended = new Promise<TurnEnd>((resolve) => {
      active = { turn, mcp: new Map(req.mcp.map((m) => [m.label, m])), steers: new Map(), end: resolve, cancelled: false, error: null, sent: false };
    });
    this.active = active;
    try {
      // The turn's MCP servers go over the control channel, never argv.
      await proc.query.setMcpServers(toMcpServers(req.mcp));
      // A request's model applies to its turn only (--model request); go back to the agent's own after it.
      if (req.model || this.requestedModel) await proc.query.setModel(req.model ?? undefined);
      this.requestedModel = req.model;
    } catch (err) {
      this.finish(active, { status: "failed", error: `could not prepare the turn: ${err instanceof Error ? err.message : String(err)}`, usage: null });
      return ended;
    }
    if (this.ownStep) await new Promise<void>((r) => this.ownStepDone.push(r));
    if (turn.cancelRequested || active.cancelled) this.finish(active, { status: "cancelled", error: null, usage: null });
    else {
      active.sent = true;
      proc.input.push(userMessage(foldInput(req.input, req.instructions), randomUUID()));
    }
    return ended;
  }

  async steer(turn: Turn, steer: QueuedSteer): Promise<boolean> {
    const a = this.active;
    const proc = this.proc;
    if (!a || a.turn !== turn || a.cancelled || !proc) return false;
    const uuid = randomUUID();
    a.steers.set(uuid, steer.id);
    proc.input.push(userMessage(foldInput(steer.input, null), uuid));
    return true;
  }

  async cancel(): Promise<void> {
    const a = this.active;
    const proc = this.proc;
    if (!a || !proc) return;
    a.cancelled = true;
    if (!a.sent) {
      // run() sees the flag before sending anything; stop it waiting for Claude Code's own step.
      for (const done of this.ownStepDone.splice(0)) done();
      return;
    }
    // Steers already pushed would run as a turn of their own after an interrupt: only stopping the process stops them.
    if (a.steers.size > 0) return this.kill(proc);
    const interrupted = proc.query.interrupt().then(
      () => true,
      () => false,
    );
    const ok = await Promise.race([interrupted, new Promise<boolean>((r) => setTimeout(() => r(false), 5000).unref())]);
    if (!ok && this.active === a) this.kill(proc);
  }

  private kill(proc: Proc): void {
    proc.input.close();
    proc.abort.abort();
    if (proc.child) killGroup(proc.child);
    if (this.proc === proc) this.proc = null;
  }

  state(): EngineState {
    return {
      running: this.active !== null,
      sessionId: this.sid,
      model: this.model,
      subagents: { running: this.subagents.size, lost: [...this.lost] },
      subagentProfileApplied: this.opts.subagentProfile !== null,
    };
  }

  /** The session JSONL Claude Code writes under `<config>/projects/<cwd>/<session id>.jsonl`. */
  async sessionFile(): Promise<string | null> {
    if (!this.sid) return null;
    const projects = path.join(this.opts.agentDir, "projects");
    const direct = path.join(projects, projectDirName(this.opts.agentDir), `${this.sid}.jsonl`);
    if (await exists(direct)) return direct;
    for (const d of await fs.readdir(projects).catch(() => [] as string[])) {
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
      const message = rec.message as { content?: unknown } | undefined;
      const text = message ? textOf(message.content) : "";
      if (!text) continue;
      out.push({ role: rec.type === "user" ? "user" : "assistant", text, at: typeof rec.timestamp === "string" ? rec.timestamp : null });
    }
    return out;
  }

  exportExcludes(): string[] {
    // Login material never travels with a copy; the rest the CLI rebuilds.
    return [".credentials.json", ".claude.json", ".claude.json.backup*", "statsig", "shell-snapshots", "debug", "cache", "telemetry", "todos", "plugins/cache", "file-history", ".update.lock"];
  }

  sessionPaths(): string[] {
    return ["projects", "todos", "shell-snapshots", "file-history", "history.jsonl", "memory"];
  }

  async stop(): Promise<void> {
    if (this.active) await this.cancel();
    if (this.proc) this.kill(this.proc);
  }
}

registerEngine({ name: "claude", needsSoul: true, create: (o) => new ClaudeEngine(o) });
