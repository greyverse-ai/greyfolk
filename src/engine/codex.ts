/**
 * Codex engine: Codex's own long-running interface, `codex app-server`, behind the Responses
 * protocol (intent: one engine process kept across turns, never one per request).
 *
 * - One app-server process for the agent, started with the engine's own options (after `--`) as
 *   they are, e.g. `-c sandbox_mode="workspace-write"`, `--enable F`. The agent folder is Codex's
 *   home (`CODEX_HOME`) and working folder: its own `config.toml` and AGENTS.md (the soul) there are
 *   read by Codex as usual, under Codex's own base instructions.
 * - A conversation is a Codex thread; the session, compaction and Codex's own subagents stay
 *   Codex's. Turns, steer (`turn/steer`) and cancel (`turn/interrupt`) are calls into the process.
 * - A turn's MCP servers are the thread's config, sent over the process's stdin (never argv, the
 *   environment or a file; Codex keeps them off disk). When a turn names other servers or
 *   credentials, the thread is unloaded and loaded again with them: the process stays.
 * - `require_approval` maps to the server's own approval mode; Codex then asks through an MCP
 *   elicitation, which becomes the standard `mcp_approval_request`. Whether Codex may ask at all
 *   is the agent's own approval policy. Codex's own approval prompts (commands, file changes)
 *   have no standard shape and nobody to ask, so they are declined.
 */
import type { LimitWindow, Limits } from "../api/limits.js";
import type { GetAccountRateLimitsResponse } from "./codex-protocol/v2/GetAccountRateLimitsResponse.js";
import type { RateLimitResetCreditsSummary } from "./codex-protocol/v2/RateLimitResetCreditsSummary.js";
import type { RateLimitSnapshot } from "./codex-protocol/v2/RateLimitSnapshot.js";
import type { RateLimitWindow } from "./codex-protocol/v2/RateLimitWindow.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { InputMessage } from "../api/input.js";
import type { ResponseUsage } from "../api/types.js";
import type { McpAttachment } from "../mcp/translate.js";
import { applyPatchCall, customToolCall, shellCall, toolOutput, webSearchCall, type ToolCallItem } from "../api/items.js";
import { usage, type Turn, type TurnEnd } from "../service/turn.js";
import type { ThreadItem } from "./codex-protocol/v2/ThreadItem.js";
import type { ThreadStartResponse } from "./codex-protocol/v2/ThreadStartResponse.js";
import type { ThreadResumeResponse } from "./codex-protocol/v2/ThreadResumeResponse.js";
import type { TurnStartResponse } from "./codex-protocol/v2/TurnStartResponse.js";
import type { ThreadItemsListResponse } from "./codex-protocol/v2/ThreadItemsListResponse.js";
import type { ServerNotification } from "./codex-protocol/ServerNotification.js";
import type { McpServerElicitationRequestParams } from "./codex-protocol/v2/McpServerElicitationRequestParams.js";
import type { McpServerElicitationRequestResponse } from "./codex-protocol/v2/McpServerElicitationRequestResponse.js";
import type { TokenUsageBreakdown } from "./codex-protocol/v2/TokenUsageBreakdown.js";
import { codexBinary } from "./codex-binary.js";
import { AppServerRpc, RpcError } from "./codex-rpc.js";
import type { ConversationMessage, Engine, EngineOptions, EngineState, EngineTurn } from "./engine.js";
import { checkExecPrefix, killGroup, spawnGroup } from "./process.js";
import { foldInput } from "./prompt.js";
import { registerEngine } from "./registry.js";

type Notification<M extends ServerNotification["method"]> = Extract<ServerNotification, { method: M }>["params"];

/** app-server options greyfolk owns: it talks to the process over stdio. */
const TRANSPORT_FLAGS = /^--(listen|stdio|ws-[a-z-]+)(=|$)/;

export function checkCodexArgs(args: string[]): void {
  for (const a of args) if (TRANSPORT_FLAGS.test(a)) throw new Error(`codex engine option ${a.split("=")[0]} is greyfolk's own (it talks to codex app-server over stdio)`);
}

/** A turn's MCP servers as Codex thread config (`mcp_servers`), credentials included. */
export function mcpConfig(mcp: McpAttachment[]): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  for (const m of mcp) {
    const entry: Record<string, unknown> = { url: m.url, http_headers: m.headers };
    entry.default_tools_approval_mode = m.requireApproval === "always" ? "prompt" : "approve";
    if (m.allowedTools) entry.enabled_tools = m.allowedTools;
    servers[m.label] = entry;
  }
  return { mcp_servers: servers };
}

export interface CodexEngineOptions extends EngineOptions {
  /** The codex binary (default: the pinned `@openai/codex` package's). */
  codexPath?: string;
  env?: Record<string, string>;
}

interface Held {
  kind: "held";
  server: string;
  tool: string;
  arguments: unknown;
}

interface Loaded {
  id: string;
  /** The MCP config the thread was loaded with. */
  mcpKey: string;
}

interface Active {
  turn: Turn;
  thread: string;
  turnId: string | null;
  mcp: Map<string, McpAttachment>;
  /** Steers sent and not yet taken in: client message id → steer id. */
  steers: Map<string, string>;
  /** Tool calls: shown as MCP or as Codex's own, held until approved, or not shown. */
  calls: Map<string, { kind: "mcp" | "skip" } | { kind: "builtin"; item: ToolCallItem } | Held>;
  end: (e: TurnEnd) => void;
  /** Settles when the turn has ended. */
  done: Promise<void>;
  cancelled: boolean;
  error: string | null;
  /** The thread's token totals when the turn began, and now (Codex reports running totals). */
  tokens: { base: TokenUsageBreakdown | null; now: TokenUsageBreakdown | null };
}

export class CodexEngine implements Engine {
  readonly name = "codex";
  readonly modelFamily = /^(gpt-|o[1-9]|codex)/i;
  readonly canAskApproval = true;
  readonly canSteer = true;
  private rpc: AppServerRpc | null = null;
  private lastLimits: Limits | null = null;
  private loaded: Loaded | null = null;
  private active: Active | null = null;
  private model: string | null = null;
  /** Other threads of this process (Codex's subagents) that are running. */
  private readonly busyThreads = new Set<string>();

  constructor(private readonly opts: CodexEngineOptions) {}

  async start(): Promise<void> {
    const st = await fs.stat(this.opts.agentDir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`agent folder not found: ${this.opts.agentDir}`);
    checkExecPrefix(this.opts.exec);
    checkCodexArgs(this.opts.engineArgs);
    await this.server();
  }

  /** The app-server process, started (and initialized) when there is none. */
  private async server(): Promise<AppServerRpc> {
    if (this.rpc) return this.rpc;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const child = spawnGroup(this.opts.exec, this.opts.codexPath ?? codexBinary(), ["app-server", ...this.opts.engineArgs], {
      cwd: this.opts.agentDir,
      env: { ...env, ...this.opts.env, CODEX_HOME: this.opts.agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[codex] ${d.toString()}`));
    const rpc = new AppServerRpc(child, { notification: (m, p) => this.notification(m, p), request: (m, p) => this.serverRequest(m, p) });
    this.rpc = rpc;
    void rpc.closed.then((why) => {
      if (this.rpc === rpc) {
        this.rpc = null;
        this.loaded = null;
        this.busyThreads.clear();
      }
      const a = this.active;
      if (a) this.finish(a, { status: a.cancelled ? "cancelled" : "failed", error: `codex app-server ${why}`, usage: turnUsage(a) });
    });
    try {
      await rpc.call("initialize", { clientInfo: { name: "greyfolk", title: null, version: "0.1.0" } });
      rpc.notify("initialized");
    } catch (err) {
      killGroup(child);
      throw new Error(`codex app-server did not start: ${err instanceof Error ? err.message : String(err)}`);
    }
    return rpc;
  }


  /** Loads the turn's thread with the turn's MCP servers (a new one when `conversation` is null). */
  private async thread(rpc: AppServerRpc, req: EngineTurn): Promise<string> {
    const config = mcpConfig(req.mcp);
    const mcpKey = JSON.stringify(config);
    const l = this.loaded;
    if (l && req.conversation === l.id && l.mcpKey === mcpKey) return l.id;
    if (l) {
      this.loaded = null;
      await rpc.call("thread/unsubscribe", { threadId: l.id }).catch(() => {});
    }
    const common = { cwd: this.opts.agentDir, config, ...(req.model ? { model: req.model } : {}) };
    const r = req.conversation
      ? await rpc.call<ThreadResumeResponse>("thread/resume", { threadId: req.conversation, excludeTurns: true, ...common })
      : await rpc.call<ThreadStartResponse>("thread/start", common);
    this.model = r.model ?? this.model;
    this.loaded = { id: r.thread.id, mcpKey };
    return r.thread.id;
  }

  async run(turn: Turn, req: EngineTurn): Promise<TurnEnd> {
    if (this.active) throw new Error("codex engine: a turn is already running");
    if (turn.cancelRequested) return { status: "cancelled", error: null, usage: null };
    const rpc = await this.server();
    const thread = await this.thread(rpc, req);
    turn.conversationStarted(thread);
    let active!: Active;
    const ended = new Promise<TurnEnd>((resolve) => {
      active = { turn, thread, turnId: null, mcp: new Map(req.mcp.map((m) => [m.label, m])), steers: new Map(), calls: new Map(), end: resolve, done: null as unknown as Promise<void>, cancelled: false, error: null, tokens: { base: null, now: null } };
    });
    active.done = ended.then(() => {});
    this.active = active;
    if (turn.cancelRequested) {
      this.finish(active, { status: "cancelled", error: null, usage: null });
      return ended;
    }
    try {
      const r = await rpc.call<TurnStartResponse>("turn/start", { threadId: thread, input: [{ type: "text", text: foldInput(req.input, req.instructions), text_elements: [] }], ...(req.model ? { model: req.model } : {}), ...(req.effort ? { effort: req.effort } : {}) });
      active.turnId ??= r.turn.id;
      if (active.cancelled) void this.interrupt(active);
    } catch (err) {
      this.finish(active, { status: "failed", error: `codex could not start the turn: ${err instanceof Error ? err.message : String(err)}`, usage: null });
    }
    return ended;
  }

  private finish(a: Active, end: TurnEnd): void {
    if (this.active !== a) return;
    this.active = null;
    a.end(end);
  }

  private notification(method: string, params: unknown): void {
    const p = params as { threadId?: string };
    if (method === "account/rateLimits/updated") {
      this.limitsSeen((params as { rateLimits: RateLimitSnapshot }).rateLimits, undefined);
      return;
    }
    if (method === "thread/status/changed") {
      const { threadId, status } = params as Notification<"thread/status/changed">;
      if (threadId !== this.loaded?.id) {
        if (status.type === "active") this.busyThreads.add(threadId);
        else this.busyThreads.delete(threadId);
      }
      return;
    }
    if (method === "thread/closed") {
      this.busyThreads.delete((params as Notification<"thread/closed">).threadId);
      return;
    }
    const a = this.active;
    if (!a || p.threadId !== a.thread) return;
    switch (method) {
      case "turn/started":
        a.turnId ??= (params as Notification<"turn/started">).turn.id;
        return;
      case "item/agentMessage/delta":
        a.turn.textDelta((params as Notification<"item/agentMessage/delta">).delta);
        return;
      case "item/started":
        return this.itemStarted(a, (params as Notification<"item/started">).item);
      case "item/completed":
        return this.itemCompleted(a, (params as Notification<"item/completed">).item);
      case "thread/tokenUsage/updated": {
        const { total, last } = (params as Notification<"thread/tokenUsage/updated">).tokenUsage;
        a.tokens.base ??= minus(total, last);
        a.tokens.now = total;
        return;
      }
      case "error":
        a.error = (params as Notification<"error">).error.message;
        return;
      case "turn/completed": {
        const t = (params as Notification<"turn/completed">).turn;
        const u = turnUsage(a);
        if (t.status === "interrupted" || a.cancelled) return this.finish(a, { status: "cancelled", error: null, usage: u });
        if (t.status === "completed") return this.finish(a, { status: "completed", error: null, usage: u });
        return this.finish(a, { status: "failed", error: t.error?.message ?? a.error ?? `codex ended the turn ${t.status}`, usage: u });
      }
      default:
        return;
    }
  }

  private itemStarted(a: Active, item: ThreadItem): void {
    switch (item.type) {
      case "userMessage": {
        const steerId = item.clientId ? a.steers.get(item.clientId) : undefined;
        if (!steerId) return;
        a.steers.delete(item.clientId!);
        a.turn.steerTakenIn(steerId);
        return;
      }
      case "mcpToolCall": {
        const server = a.mcp.get(item.server);
        // A call that needs approval shows once it is approved (the elicitation decides).
        if (server?.requireApproval === "always") a.calls.set(item.id, { kind: "held", server: item.server, tool: item.tool, arguments: item.arguments });
        else this.startMcp(a, item.id, item.server, item.tool, item.arguments);
        return;
      }
      case "fileChange":
        item.changes.forEach((c, i) => this.startBuiltin(a, `${item.id}#${i}`, patchCall(`${item.id}#${i}`, c)));
        return;
      default: {
        const call = builtinOf(item);
        if (call) this.startBuiltin(a, item.id, call);
      }
    }
  }

  private itemCompleted(a: Active, item: ThreadItem): void {
    switch (item.type) {
      case "agentMessage":
        a.turn.textDone(item.text);
        return;
      case "reasoning":
        if (item.content.length) a.turn.reasoning(item.content.join("\n"), "text");
        else if (item.summary.length) a.turn.reasoning(item.summary.join("\n"), "summary");
        return;
      case "mcpToolCall": {
        const call = a.calls.get(item.id);
        a.calls.delete(item.id);
        // Held and never asked about (the agent's approval policy lets Codex ask no one): it shows as it ended.
        if (call?.kind === "held") this.startMcp(a, item.id, call.server, call.tool, call.arguments);
        else if (call?.kind !== "mcp") return;
        const output = (item.result?.content ?? []).map((c) => (typeof c === "object" && c && "text" in c ? String(c.text) : JSON.stringify(c))).join("\n");
        a.turn.mcpCallEnded(item.id, output, item.status === "failed" ? (item.error?.message ?? "failed") : null);
        return;
      }
      case "commandExecution":
        if (!a.calls.has(item.id)) this.startBuiltin(a, item.id, shellCall(item.id, item.command));
        return this.endBuiltin(a, item.id, { output: item.aggregatedOutput ?? "", failed: item.status !== "completed", exitCode: item.exitCode });
      case "fileChange":
        item.changes.forEach((c, i) => {
          const id = `${item.id}#${i}`;
          if (!a.calls.has(id)) this.startBuiltin(a, id, patchCall(id, c));
          this.endBuiltin(a, id, { output: item.status, failed: item.status !== "completed" });
        });
        return;
      default: {
        const call = builtinOf(item);
        if (!call) return;
        if (!a.calls.has(item.id)) this.startBuiltin(a, item.id, call);
        this.endBuiltin(a, item.id, resultOf(item));
      }
    }
  }

  private startMcp(a: Active, id: string, server: string, tool: string, args: unknown): void {
    a.turn.mcpCallStarted(id, { server, name: tool, arguments: args });
    a.calls.set(id, { kind: "mcp" });
  }

  private startBuiltin(a: Active, id: string, item: ToolCallItem): void {
    a.turn.toolStarted(id, item);
    a.calls.set(id, { kind: "builtin", item });
  }

  private endBuiltin(a: Active, id: string, result: { output: string; failed: boolean; exitCode?: number | null }): void {
    const call = a.calls.get(id);
    a.calls.delete(id);
    if (call?.kind === "builtin") a.turn.toolEnded(id, result.failed, toolOutput(call.item, id, result));
  }

  /** Requests the app-server sends: MCP tool approvals become the standard approval request. */
  private async serverRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "mcpServer/elicitation/request":
        return this.elicitation(params as McpServerElicitationRequestParams);
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return { decision: "decline" };
      case "execCommandApproval":
      case "applyPatchApproval":
        return { decision: { denied: { rejection: "No one can be asked to approve this." } } };
      default:
        throw new RpcError(`greyfolk does not answer ${method}`, -32601);
    }
  }

  private async elicitation(p: McpServerElicitationRequestParams): Promise<McpServerElicitationRequestResponse> {
    const decline: McpServerElicitationRequestResponse = { action: "decline", content: null, _meta: null };
    const a = this.active;
    const kind = (p._meta as { codex_approval_kind?: string } | null)?.codex_approval_kind;
    if (!a || a.cancelled || p.threadId !== a.thread || (p.turnId !== null && p.turnId !== a.turnId) || kind !== "mcp_tool_call") return decline;
    // The request names no call, so it is matched by server, tool and arguments. Calls that match equally
    // are the same request; calls it cannot tell apart are refused rather than guessed.
    const args = JSON.stringify((p._meta as { tool_params?: unknown }).tool_params ?? null);
    const matches = [...a.calls.entries()].filter(
      (e): e is [string, Held] => e[1].kind === "held" && e[1].server === p.serverName && p.message.includes(`"${e[1].tool}"`) && JSON.stringify(e[1].arguments ?? null) === args,
    );
    if (matches.length === 0 || new Set(matches.map(([, c]) => c.tool)).size > 1) return decline;
    const [id, held] = matches[0]!;
    a.calls.set(id, { kind: "skip" });
    const ok = await a.turn.requestApproval({ server: held.server, name: held.tool, arguments: held.arguments });
    if (!ok || this.active !== a || a.cancelled) return decline;
    this.startMcp(a, id, held.server, held.tool, held.arguments);
    return { action: "accept", content: null, _meta: null };
  }

  async steer(turn: Turn, id: string, input: InputMessage[]): Promise<boolean> {
    const a = this.active;
    const rpc = this.rpc;
    if (!a || a.turn !== turn || a.cancelled || !a.turnId || !rpc) return false;
    const clientId = randomUUID();
    a.steers.set(clientId, id);
    try {
      await rpc.call("turn/steer", { threadId: a.thread, expectedTurnId: a.turnId, clientUserMessageId: clientId, input: [{ type: "text", text: foldInput(input, null), text_elements: [] }] });
      return true;
    } catch {
      a.steers.delete(clientId);
      return false;
    }
  }

  async cancel(): Promise<void> {
    const a = this.active;
    if (!a) return;
    a.cancelled = true;
    if (a.turnId) await this.interrupt(a);
  }

  private async interrupt(a: Active): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || !a.turnId) return;
    await rpc.call("turn/interrupt", { threadId: a.thread, turnId: a.turnId }).catch(() => {});
    // The process answers with turn/completed (interrupted); if it does not, it is stopped.
    await Promise.race([a.done, new Promise((r) => setTimeout(r, 5000).unref())]);
    if (this.active === a && this.rpc === rpc) killGroup(rpc.child);
  }

  /** Rolling updates are sparse: what they carry replaces what was known (account/rateLimits/updated). */
  private limitsSeen(snap: RateLimitSnapshot, credits: RateLimitResetCreditsSummary | null | undefined): void {
    const prev = this.lastLimits;
    const windows: LimitWindow[] = [];
    const win = (name: string, w: RateLimitWindow | null) => {
      if (w) windows.push({ name: w.windowDurationMins === 10080 ? "weekly" : w.windowDurationMins === 300 ? "five_hour" : name, used_percent: w.usedPercent, resets_at: w.resetsAt, window_minutes: w.windowDurationMins });
    };
    win("primary", snap.primary);
    win("secondary", snap.secondary);
    this.lastLimits = {
      engine: "codex",
      plan: snap.planType ?? prev?.plan ?? null,
      blocked: snap.rateLimitReachedType != null || windows.some((w) => (w.used_percent ?? 0) >= 100),
      windows: windows.length ? windows : prev?.windows ?? [],
      reset_credits: credits === undefined ? prev?.reset_credits ?? null
        : credits ? { count: Number(credits.availableCount), expires_at: (credits.credits ?? []).filter((c) => c.status === "available").map((c) => c.expiresAt) } : null,
      observed_at: Math.floor(Date.now() / 1000),
    };
  }

  /** Asks the account only through an app-server already running for this agent: starting one just to ask could renew its login. */
  async limits(refresh: boolean): Promise<Limits | null> {
    if (refresh && this.rpc) {
      const r = await this.rpc.call<GetAccountRateLimitsResponse>("account/rateLimits/read", {}).catch(() => null);
      if (r) this.limitsSeen(r.rateLimits, r.rateLimitResetCredits);
    }
    return this.lastLimits;
  }

  state(): EngineState {
    return { running: this.active !== null, conversation: this.loaded?.id ?? null, model: this.model, subagents: this.busyThreads.size };
  }

  async conversation(id: string): Promise<ConversationMessage[] | null> {
    const rpc = this.rpc;
    if (!rpc) return null;
    const out: ConversationMessage[] = [];
    let cursor: string | null = null;
    try {
      do {
        const page: ThreadItemsListResponse = await rpc.call<ThreadItemsListResponse>("thread/items/list", { threadId: id, ...(cursor ? { cursor } : {}) });
        for (const { item } of page.data) {
          if (item.type === "userMessage") out.push({ role: "user", text: item.content.map((c) => (c.type === "text" ? c.text : "")).join("") });
          else if (item.type === "agentMessage") out.push({ role: "assistant", text: item.text });
        }
        cursor = page.nextCursor;
      } while (cursor);
    } catch {
      return null;
    }
    return out.filter((m) => m.text);
  }

  async stop(): Promise<void> {
    if (this.active) await this.cancel();
    const rpc = this.rpc;
    this.rpc = null;
    if (rpc) killGroup(rpc.child);
  }
}

const minus = (a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown => ({
  totalTokens: a.totalTokens - b.totalTokens,
  inputTokens: a.inputTokens - b.inputTokens,
  cachedInputTokens: a.cachedInputTokens - b.cachedInputTokens,
  cacheWriteInputTokens: a.cacheWriteInputTokens - b.cacheWriteInputTokens,
  outputTokens: a.outputTokens - b.outputTokens,
  reasoningOutputTokens: a.reasoningOutputTokens - b.reasoningOutputTokens,
});

/** The turn's usage: the thread's totals now less those when the turn began. */
function turnUsage(a: Active): ResponseUsage | null {
  const { base, now } = a.tokens;
  if (!base || !now) return null;
  const d = minus(now, base);
  return usage(d.inputTokens, d.outputTokens, { cached: d.cachedInputTokens, cacheWrite: d.cacheWriteInputTokens, reasoning: d.reasoningOutputTokens, total: d.totalTokens });
}

/** Codex's own tools as the standard item that means the same (MCP and file changes aside). */
function builtinOf(item: ThreadItem): ToolCallItem | null {
  switch (item.type) {
    case "commandExecution":
      return shellCall(item.id, item.command);
    case "webSearch":
      return webSearchCall(item.query);
    case "collabAgentToolCall":
      return customToolCall(item.id, item.tool, { prompt: item.prompt, model: item.model, receiver_thread_ids: item.receiverThreadIds });
    case "dynamicToolCall":
      return customToolCall(item.id, item.namespace ? `${item.namespace}.${item.tool}` : item.tool, item.arguments);
    case "imageView":
      return customToolCall(item.id, "view_image", { path: item.path });
    default:
      return null;
  }
}

/** A Codex file change as the standard `apply_patch_call`. */
function patchCall(id: string, c: { path: string; diff: string; kind: { type: string } }): ToolCallItem {
  return applyPatchCall(id, c.path, c.diff, c.kind.type === "add" ? "create_file" : c.kind.type === "delete" ? "delete_file" : "update_file");
}

function resultOf(item: ThreadItem): { output: string; failed: boolean } {
  switch (item.type) {
    case "collabAgentToolCall":
      return { output: JSON.stringify({ status: item.status, receiver_thread_ids: item.receiverThreadIds }), failed: item.status === "failed" };
    case "dynamicToolCall":
      return { output: JSON.stringify(item.contentItems ?? []), failed: item.success === false };
    default:
      return { output: "", failed: false };
  }
}

registerEngine({ name: "codex", create: (o: EngineOptions) => new CodexEngine(o) });
