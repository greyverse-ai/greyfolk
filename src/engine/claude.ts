/**
 * Claude engine: the Claude Agent SDK behind the Responses protocol.
 *
 * - One Claude Code process per conversation, kept across turns (the SDK's streaming input), so
 *   the session, compaction, native subagents and their late results stay Claude Code's own.
 *   The process runs in its own process group (through `--engine-exec` when given).
 * - The agent folder is Claude Code's config home (`cwd` = `CLAUDE_CONFIG_DIR`): its own settings
 *   files and its CLAUDE.md (the soul) there are read by Claude Code as usual (setting source `user`),
 *   under Claude Code's own system prompt.
 * - The engine's own options (after `--`) go to Claude Code's command line as they are (SDK
 *   `extraArgs`), e.g. `--tools Agent,TodoWrite`.
 * - A turn's MCP servers go over the SDK's control channel (`setMcpServers`), never argv.
 * - The request's `allowed_tools` and `require_approval` are applied in a `PreToolUse` hook (it
 *   runs before Claude Code's own permission rules); an approval becomes the standard
 *   `mcp_approval_request`.
 * - Every user message greyfolk sends carries a uuid, and Claude Code stamps each step with the
 *   uuids it answers: that is how a step is told to be the turn's (or a steer's) rather than one
 *   Claude Code runs on its own between turns. A steer is taken in when a step carries its uuid.
 */
import type { LimitWindow, Limits } from "../api/limits.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { getSessionMessages, query, type HookCallback, type McpServerConfig, type Options, type Query, type SDKMessage, type SDKRateLimitInfo, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { InputMessage } from "../api/input.js";
import type { McpAttachment } from "../mcp/translate.js";
import { applyPatchCall, customToolCall, shellCall, toolOutput, webSearchCall, type ToolCallItem } from "../api/items.js";
import { usage, type Turn, type TurnEnd } from "../service/turn.js";
import type { ConversationMessage, Engine, EngineOptions, EngineState, EngineTurn } from "./engine.js";
import { checkExecPrefix, killGroup, spawnGroup } from "./process.js";
import { foldInput, textOf } from "./prompt.js";
import { registerEngine } from "./registry.js";

/** `--flag value` / `--flag=value` / `--flag` → the SDK's `extraArgs` (passed to Claude Code as they are). */
export function toExtraArgs(args: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) throw new Error(`claude engine option '${a}' must start with --`);
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) out[a.slice(2)] = args[++i]!;
    else out[a.slice(2)] = null;
  }
  return out;
}

export interface ClaudeEngineOptions extends EngineOptions {
  queryFn?: typeof query;
  env?: Record<string, string>;
}

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
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
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

export interface Proc {
  query: Query;
  input: InputQueue;
  abort: AbortController;
  child: ChildProcess | null;
  /** The session this process carries (null until Claude Code names it). */
  session: string | null;
  /** Background tasks (subagents and the like) still running in this process. */
  tasks: number;
}

interface Active {
  turn: Turn;
  /** The process the turn runs on. */
  proc: Proc;
  /** The uuids of the user messages this turn sent (its input, then each steer). */
  uuids: Set<string>;
  /** The step Claude Code is running now answers this turn (its frames carry one of `uuids`). */
  mine: boolean;
  mcp: Map<string, McpAttachment>;
  /** Steers pushed and not yet taken in: uuid → steer id. */
  steers: Map<string, string>;
  end: (e: TurnEnd) => void;
  cancelled: boolean;
  error: string | null;
  /** Tool calls of the turn: shown as MCP or as Claude Code's own, or not shown (refused or awaiting approval). */
  calls: Map<string, "mcp" | "skip" | ToolCallItem>;
}

export function userMessage(text: string, uuid: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid } as SDKUserMessage;
}

export function toMcpServers(mcp: McpAttachment[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const m of mcp) out[m.label] = { type: "http", url: m.url, headers: m.headers };
  return out;
}

/** `mcp__<label>__<tool>` → `{label, tool}`, or null for a built-in tool. */
export function splitMcpToolName(name: string): { label: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const i = rest.indexOf("__");
  return i < 0 ? null : { label: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/** Claude Code's own tool as the standard item that means the same. */
export function builtinCall(id: string, name: string, input: unknown): ToolCallItem {
  const i = (input ?? {}) as Record<string, unknown>;
  if ((name === "Bash" || name === "PowerShell") && typeof i.command === "string") return shellCall(id, i.command);
  const file = i.file_path ?? i.notebook_path;
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name) && typeof file === "string") {
    return applyPatchCall(id, file, patchOf(name, i), name === "Write" ? "create_file" : "update_file");
  }
  if (name === "WebSearch" && typeof i.query === "string") return webSearchCall(i.query);
  return customToolCall(id, name, input);
}

const lines = (text: unknown, sign: "+" | "-"): string[] => (typeof text === "string" && text !== "" ? text.split("\n").map((l) => sign + l) : []);

/** The change a file tool makes, as the standard's diff (`+`/`-` lines; a hunk per edit). */
export function patchOf(name: string, i: Record<string, unknown>): string {
  if (name === "Write") return lines(i.content, "+").join("\n");
  if (name === "NotebookEdit") return ["@@", ...lines(i.new_source, "+")].join("\n");
  const edits = name === "MultiEdit" && Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : [i];
  return edits.flatMap((e) => ["@@", ...lines(e.old_string, "-"), ...lines(e.new_string, "+")]).join("\n");
}

const stampsOf = (msg: SDKMessage): string[] => {
  const m = msg as { user_message_uuid?: string; user_message_uuids?: string[] };
  return m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
};
const hook = (decision: "allow" | "deny", reason?: string) => ({ continue: true, hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: decision, ...(reason ? { permissionDecisionReason: reason } : {}) } });
const admits = (server: McpAttachment, tool: string): boolean => !server.allowedTools || server.allowedTools.includes(tool);

export class ClaudeEngine implements Engine {
  readonly name = "claude";
  readonly modelFamily = /^claude-/i;
  readonly canAskApproval = true;
  readonly canSteer = true;
  private readonly queryFn: typeof query;
  private readonly extraArgs: Record<string, string | null>;
  private model: string | null = null;
  private requestedEffort: string | null = null;
  private proc: Proc | null = null;
  private active: Active | null = null;
  private requestedModel: string | null = null;
  /** Steers of a cancelled turn that Claude Code still had queued: interrupted as soon as they start. */
  private readonly stopWhenStarted = new Set<string>();

  constructor(private readonly opts: ClaudeEngineOptions) {
    this.queryFn = opts.queryFn ?? query;
    this.extraArgs = toExtraArgs(opts.engineArgs);
  }

  async start(): Promise<void> {
    const st = await fs.stat(this.opts.agentDir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`agent folder not found: ${this.opts.agentDir}`);
    checkExecPrefix(this.opts.exec);
    // The SDK's session readers find this agent's sessions through the same config home.
    process.env.CLAUDE_CONFIG_DIR = this.opts.agentDir;
  }

  /**
   * Runs before every tool call, ahead of Claude Code's own permission rules. An MCP tool runs
   * only in a step that answers the turn whose request named its server; an approval becomes the
   * standard `mcp_approval_request`, and the call shows once it is allowed.
   */
  readonly preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const mcp = splitMcpToolName(input.tool_name);
    if (!mcp) return { continue: true };
    const a = this.active;
    const server = a?.mcp.get(mcp.label);
    if (!a || !a.mine || a.cancelled) return hook("deny", "No turn asked for this step.");
    if (!server) return hook("deny", `MCP server '${mcp.label}' is not attached to this turn`);
    if (!admits(server, mcp.tool)) return hook("deny", `${mcp.tool} is not among the allowed tools of '${mcp.label}'`);
    if (server.requireApproval === "never") return hook("allow");
    a.calls.set(input.tool_use_id, "skip");
    const ok = await a.turn.requestApproval({ server: mcp.label, name: mcp.tool, arguments: input.tool_input });
    if (!ok || this.active !== a || a.cancelled) return hook("deny", "Not approved.");
    a.turn.mcpCallStarted(input.tool_use_id, { server: mcp.label, name: mcp.tool, arguments: input.tool_input });
    a.calls.set(input.tool_use_id, "mcp");
    return hook("allow");
  };

  buildOptions(proc: Pick<Proc, "abort" | "child">, resume: string | null): Options {
    const options: Options = {
      cwd: this.opts.agentDir,
      env: { ...process.env, ...this.opts.env, CLAUDE_CONFIG_DIR: this.opts.agentDir, DISABLE_AUTOUPDATER: "1" },
      abortController: proc.abort,
      // Claude Code's own system prompt; the agent's CLAUDE.md in its config home is read by Claude Code itself.
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user"],
      extraArgs: this.extraArgs,
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
    if (resume) options.resume = resume;
    return options;
  }

  /** The process for `conversation` (a new conversation when null): reused, or started with `resume`. */
  private procFor(conversation: string | null): Proc {
    const p = this.proc;
    if (p && conversation !== null && p.session === conversation) return p;
    if (p) this.kill(p);
    const proc: Proc = { abort: new AbortController(), child: null, input: new InputQueue(), query: null as unknown as Query, session: conversation, tasks: 0 };
    proc.query = this.queryFn({ prompt: proc.input, options: this.buildOptions(proc, conversation) });
    this.proc = proc;
    void this.pump(proc);
    return proc;
  }

  private async pump(proc: Proc): Promise<void> {
    let error: string | null = null;
    try {
      for await (const msg of proc.query) this.route(msg, proc);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    if (this.proc === proc) this.proc = null;
    // Only the turn running on this process ends with it (a newer process carries its own).
    const a = this.active;
    if (a && a.proc === proc) this.finish(a, { status: a.cancelled ? "cancelled" : "failed", error: a.error ?? error ?? "Claude Code ended without a result.", usage: null });
  }

  private finish(a: Active, end: TurnEnd): void {
    if (this.active !== a) return;
    this.active = null;
    a.end(end);
  }

  private route(msg: SDKMessage, proc: Proc): void {
    if (msg.type === "rate_limit_event") return this.limitSeen(msg.rate_limit_info);
    if (msg.type === "system") {
      if (msg.subtype === "init") {
        proc.session = msg.session_id;
        if (this.active?.proc === proc) this.active.turn.conversationStarted(msg.session_id);
        if (msg.model) this.model = msg.model;
      } else if (msg.subtype === "background_tasks_changed") {
        proc.tasks = msg.tasks.filter((t) => !t.ambient).length;
      }
      return;
    }
    // Which step a frame belongs to: the stamps of the user messages it answers.
    const stamps = msg.type === "result" || !("parent_tool_use_id" in msg) || !msg.parent_tool_use_id ? stampsOf(msg) : [];
    if (msg.type !== "result") {
      for (const u of stamps) {
        if (!this.stopWhenStarted.delete(u)) continue;
        void proc.query.interrupt().catch(() => {});
      }
    }
    const a = this.active;
    if (!a || a.proc !== proc) return;
    if (msg.type === "result") return this.stepEnded(a, msg, stamps);
    if (stamps.length > 0) {
      a.mine = stamps.some((u) => a.uuids.has(u));
      if (a.mine) for (const u of stamps) this.takenIn(a, u);
    }
    if (!a.mine) return;
    switch (msg.type) {
      case "stream_event":
        if (!msg.parent_tool_use_id && msg.event.type === "content_block_delta" && msg.event.delta.type === "text_delta") a.turn.textDelta(msg.event.delta.text);
        return;
      case "assistant":
        if (msg.parent_tool_use_id) return;
        for (const block of msg.message.content) {
          if (block.type === "text") a.turn.textDone(block.text);
          else if (block.type === "thinking") a.turn.reasoning(block.thinking, "text");
          else if (block.type === "tool_use") this.toolUse(a, block.id, block.name, block.input);
        }
        return;
      case "user": {
        if (msg.parent_tool_use_id || !Array.isArray(msg.message.content)) return;
        for (const block of msg.message.content) {
          if (block.type !== "tool_result") continue;
          const out = typeof block.content === "string" ? block.content : (block.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
          const kind = a.calls.get(block.tool_use_id);
          a.calls.delete(block.tool_use_id);
          if (kind === "mcp") a.turn.mcpCallEnded(block.tool_use_id, out, block.is_error ? out : null);
          else if (typeof kind === "object") {
            const failed = !!block.is_error;
            a.turn.toolEnded(block.tool_use_id, failed, toolOutput(kind, block.tool_use_id, { output: out, failed, exitCode: failed ? Number(/^Exit code (\d+)/m.exec(out)?.[1] ?? 1) : 0 }));
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private toolUse(a: Active, id: string, name: string, input: unknown): void {
    const mcp = splitMcpToolName(name);
    if (!mcp) {
      const item = builtinCall(id, name, input);
      a.turn.toolStarted(id, item);
      a.calls.set(id, item);
      return;
    }
    const server = a.mcp.get(mcp.label);
    // A call the hook refuses never runs; one that needs approval shows once it is allowed (the hook starts it).
    if (!server || !admits(server, mcp.tool) || server.requireApproval === "always") {
      if (!a.calls.has(id)) a.calls.set(id, "skip");
      return;
    }
    a.turn.mcpCallStarted(id, { server: mcp.label, name: mcp.tool, arguments: input });
    a.calls.set(id, "mcp");
  }

  private takenIn(a: Active, uuid: string): void {
    const steerId = a.steers.get(uuid);
    if (!steerId) return;
    a.steers.delete(uuid);
    a.turn.steerTakenIn(steerId);
  }

  private stepEnded(a: Active, msg: Extract<SDKMessage, { type: "result" }>, stamps: string[]): void {
    const mine = stamps.length > 0 ? stamps.some((u) => a.uuids.has(u)) : a.mine;
    a.mine = false;
    if (!mine) return; // a step Claude Code ran on its own (e.g. a late subagent result)
    const u = msg.usage ? usage(msg.usage.input_tokens, msg.usage.output_tokens) : null;
    if (a.cancelled) return this.finish(a, { status: "cancelled", error: null, usage: u });
    for (const s of stamps) this.takenIn(a, s);
    // A steer still queued runs as the next step; the turn goes on until it is answered.
    if (a.steers.size > 0) return;
    if (msg.subtype === "success" && !msg.is_error) return this.finish(a, { status: "completed", error: null, usage: u });
    return this.finish(a, { status: "failed", error: msg.subtype === "success" ? msg.result : `Claude Code ended the turn: ${msg.subtype}`, usage: u });
  }

  async run(turn: Turn, req: EngineTurn): Promise<TurnEnd> {
    if (this.active) throw new Error("claude engine: a turn is already running");
    if (turn.cancelRequested) return { status: "cancelled", error: null, usage: null };
    const uuid = randomUUID();
    // Prepare on the session to resume; if it is gone (the folder was moved or its owner changed),
    // start the conversation fresh rather than failing the turn.
    const prepare = async (conversation: string | null): Promise<{ proc: Proc; active: Active; ended: Promise<TurnEnd> }> => {
      const proc = this.procFor(conversation);
      let active!: Active;
      const ended = new Promise<TurnEnd>((resolve) => {
        active = { turn, proc, uuids: new Set([uuid]), mine: false, mcp: new Map(req.mcp.map((m) => [m.label, m])), steers: new Map(), end: resolve, cancelled: false, error: null, calls: new Map() };
      });
      this.active = active;
      if (proc.session) turn.conversationStarted(proc.session);
      await proc.query.setMcpServers(toMcpServers(req.mcp));
      if (req.model || this.requestedModel) await proc.query.setModel(req.model ?? undefined);
      this.requestedModel = req.model;
      if (req.effort || this.requestedEffort) { // each turn: a process started again starts at its default
        await proc.query.applyFlagSettings({ effortLevel: (req.effort ?? undefined) as never });
        this.requestedEffort = req.effort;
      }
      return { proc, active, ended };
    };
    const missing = (err: unknown) => /no conversation found|session id/i.test(err instanceof Error ? err.message : String(err));
    let prepared;
    try {
      prepared = await prepare(req.conversation);
    } catch (err) {
      if (req.conversation !== null && missing(err)) {
        if (this.proc) this.kill(this.proc);
        this.active = null;
        try {
          prepared = await prepare(null);
        } catch (err2) {
          const active = this.active;
          if (active) this.finish(active, { status: "failed", error: `could not prepare the turn: ${err2 instanceof Error ? err2.message : String(err2)}`, usage: null });
          return { status: "failed", error: `could not prepare the turn: ${err2 instanceof Error ? err2.message : String(err2)}`, usage: null };
        }
      } else {
        const active = this.active;
        if (active) this.finish(active, { status: "failed", error: `could not prepare the turn: ${err instanceof Error ? err.message : String(err)}`, usage: null });
        return { status: "failed", error: `could not prepare the turn: ${err instanceof Error ? err.message : String(err)}`, usage: null };
      }
    }
    const { proc, active, ended } = prepared;
    if (turn.cancelRequested || active.cancelled) {
      this.finish(active, { status: "cancelled", error: null, usage: null });
      return ended;
    }
    // Claude Code queues it behind any step of its own that is still running.
    proc.input.push(userMessage(foldInput(req.input, req.instructions), uuid));
    return ended;
  }

  async steer(turn: Turn, id: string, input: InputMessage[]): Promise<boolean> {
    const a = this.active;
    if (!a || a.turn !== turn || a.cancelled || this.proc !== a.proc) return false;
    const uuid = randomUUID();
    a.uuids.add(uuid);
    a.steers.set(uuid, id);
    a.proc.input.push(userMessage(foldInput(input, null), uuid));
    return true;
  }

  async cancel(): Promise<void> {
    const a = this.active;
    if (!a) return;
    a.cancelled = true;
    const proc = a.proc;
    const receipt = await Promise.race([proc.query.interrupt().then((r) => r ?? null, () => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000).unref())]);
    if (receipt === undefined) {
      if (this.active === a) this.kill(proc);
      return;
    }
    // Messages of the turn Claude Code still holds (its input, steers) would run on their own after the
    // interrupt: each is taken back out of Claude Code's queue (its own `cancel_async_message`), and one
    // that cannot be is stopped as it starts. Claude Code's own queued work (task notifications) stays.
    const queued = receipt ? receipt.still_queued : [...a.uuids];
    const recall = (proc.query as unknown as { cancelAsyncMessage?: (uuid: string) => Promise<boolean> }).cancelAsyncMessage;
    for (const u of queued) {
      if (!a.uuids.has(u)) continue;
      const taken = recall ? await recall.call(proc.query, u).catch(() => false) : false;
      if (!taken) this.stopWhenStarted.add(u);
    }
    // An interrupt before the turn's step started leaves no result to end it.
    if (!a.mine && this.active === a) this.finish(a, { status: "cancelled", error: null, usage: null });
  }

  private kill(proc: Proc): void {
    proc.input.close();
    proc.abort.abort();
    if (proc.child) killGroup(proc.child);
    if (this.proc === proc) this.proc = null;
  }

  private lastLimits: Limits | null = null;

  /** Each rate_limit_event is about one window (five_hour, seven_day, …): it replaces that window. */
  private limitSeen(info: SDKRateLimitInfo): void {
    const name = info.rateLimitType ?? "plan";
    const prev = this.lastLimits?.windows ?? [];
    const w: LimitWindow = { name, used_percent: info.utilization != null ? Math.round(info.utilization * (info.utilization <= 1 ? 100 : 1)) : null, resets_at: info.resetsAt ?? null };
    const windows = [...prev.filter((x) => x.name !== name), w];
    this.lastLimits = { engine: "claude", plan: null, blocked: info.status === "rejected", windows, reset_credits: null, observed_at: Math.floor(Date.now() / 1000) };
  }

  async limits(): Promise<Limits | null> {
    return this.lastLimits;
  }

  state(): EngineState {
    return { running: this.active !== null, conversation: this.proc?.session ?? null, model: this.model, subagents: this.proc?.tasks ?? 0 };
  }

  async conversation(id: string): Promise<ConversationMessage[] | null> {
    const messages = await getSessionMessages(id, { dir: this.opts.agentDir }).catch(() => []);
    if (messages.length === 0) return null;
    return messages
      .filter((m) => (m.type === "user" || m.type === "assistant") && !m.parent_tool_use_id)
      .map((m) => ({ role: m.type as "user" | "assistant", text: textOf((m.message as { content?: unknown } | null)?.content) }))
      .filter((m) => m.text);
  }

  async stop(): Promise<void> {
    if (this.active) await this.cancel();
    if (this.proc) this.kill(this.proc);
  }
}

registerEngine({ name: "claude", create: (o) => new ClaudeEngine(o) });
