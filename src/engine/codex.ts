/**
 * Codex engine: the Codex SDK (`@openai/codex-sdk`) behind the Responses protocol.
 *
 * - The SDK runs `codex exec` per turn and resumes the thread (= the conversation) by id; the
 *   session, compaction and Codex's own subagents stay Codex's.
 * - The agent folder is Codex's home (`CODEX_HOME` = working folder): its own `config.toml` there
 *   is read as usual; the soul is the model instructions file.
 * - The engine's own options (after `--`) use codex's own CLI keys, as far as the Codex SDK can
 *   carry them (`parseCodexArgs`); anything else is refused at start.
 * - A turn's MCP servers are SDK config; their credentials travel only in the process
 *   environment (`env_http_headers`, `env_vars`), never in argv or a file.
 * - `codex exec` cannot ask before a tool runs: MCP tools are pre-approved and the service
 *   refuses `require_approval: "always"`. `allowed_tools` = Codex `enabled_tools`.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Codex, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import type { McpAttachment } from "../mcp/translate.js";
import { usage, type Turn, type TurnEnd } from "../service/turn.js";
import type { ConversationMessage, Engine, EngineOptions, EngineState, EngineTurn } from "./engine.js";
import { foldInput } from "./prompt.js";
import { registerEngine } from "./registry.js";

/** Pinned SDK (resume-from-copy is tested per version, spec §3). */
export const CODEX_SDK_VERSION = "0.161.0";

/**
 * The engine's own options, with codex's own CLI keys, as far as the Codex SDK can carry them:
 * `--sandbox/-s`, `--model/-m`, `--add-dir` (SDK thread options), `-c/--config key=value`,
 * `--enable F`, `--disable F` (config overrides). Anything else is refused.
 */
export interface CodexArgs {
  thread: { sandboxMode?: "read-only" | "workspace-write" | "danger-full-access"; model?: string; additionalDirectories?: string[] };
  config: string[];
}

export function parseCodexArgs(args: string[]): CodexArgs {
  const out: CodexArgs = { thread: {}, config: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const value = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (value === undefined) throw new Error(`codex engine option ${flag} needs a value`);
    if (flag === "-c" || flag === "--config") out.config.push(value);
    else if (flag === "--enable") out.config.push(`features.${value}=true`);
    else if (flag === "--disable") out.config.push(`features.${value}=false`);
    else if (flag === "-s" || flag === "--sandbox") {
      if (value !== "read-only" && value !== "workspace-write" && value !== "danger-full-access") throw new Error(`codex engine option --sandbox: '${value}' is not a sandbox mode`);
      out.thread.sandboxMode = value;
    } else if (flag === "-m" || flag === "--model") out.thread.model = value;
    else if (flag === "--add-dir") (out.thread.additionalDirectories ??= []).push(value);
    else throw new Error(`codex engine option '${flag}' cannot be passed through the Codex SDK (it takes --sandbox, --model, --add-dir, -c/--config, --enable, --disable)`);
  }
  return out;
}

export const SOUL_FILE = path.join(".greyfolk", "soul.md");

export interface CodexEngineOptions extends EngineOptions {
  codexPath?: string;
  env?: Record<string, string>;
}

/** A turn's MCP servers as SDK config, with every credential moved into named environment variables. */
export function mcpConfig(mcp: McpAttachment[]): { config: Record<string, unknown>; env: Record<string, string> } {
  const config: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  mcp.forEach((m, i) => {
    const prefix = `GREYFOLK_MCP_${i}`;
    const entry: Record<string, unknown> = { default_tools_approval_mode: "approve" };
    if (m.allowedTools) entry.enabled_tools = m.allowedTools;
    if (m.kind === "http") {
      entry.url = m.url;
      const names: Record<string, string> = {};
      Object.entries(m.headers).forEach(([h, v], j) => {
        names[h] = `${prefix}_H${j}`;
        env[`${prefix}_H${j}`] = v;
      });
      if (Object.keys(names).length) entry.env_http_headers = names;
    } else {
      const { GREYFOLK_MCP_HEADERS: headers, ...plain } = m.env;
      entry.command = m.command;
      entry.args = m.args;
      entry.env = { ...plain, ...(headers ? { GREYFOLK_MCP_HEADERS_VAR: `${prefix}_HDR` } : {}) };
      if (headers) {
        env[`${prefix}_HDR`] = headers;
        entry.env_vars = [`${prefix}_HDR`];
      }
    }
    config[m.label] = entry;
  });
  return { config: Object.keys(config).length ? { mcp_servers: config } : {}, env };
}

export class CodexEngine implements Engine {
  readonly name = "codex";
  readonly modelFamily = /^(gpt-|o[1-9]|codex)/i;
  readonly canAskApproval = false;
  readonly canSteer = false;
  private conv: string | null = null;
  private args: CodexArgs = { thread: {}, config: [] };
  private abort: AbortController | null = null;

  constructor(private readonly opts: CodexEngineOptions) {}

  private get binary(): string {
    const v = this.opts.values.get("codex-bin");
    return this.opts.codexPath ?? (typeof v === "string" ? v : "codex");
  }

  private baseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    return { ...env, ...this.opts.env, CODEX_HOME: this.opts.agentDir };
  }

  async start(): Promise<void> {
    const st = await fs.stat(this.opts.agentDir).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`agent folder not found: ${this.opts.agentDir}`);
    if (!this.opts.soul.trim()) throw new Error("the soul (agent instruction file) is empty");
    if (this.opts.exec.length) throw new Error("--engine-exec is not supported by the codex engine (the Codex SDK starts the binary itself)");
    this.args = parseCodexArgs(this.opts.engineArgs);
    await fs.mkdir(path.dirname(path.join(this.opts.agentDir, SOUL_FILE)), { recursive: true });
    await fs.writeFile(path.join(this.opts.agentDir, SOUL_FILE), this.opts.soul, "utf8");
  }

  async run(turn: Turn, req: EngineTurn): Promise<TurnEnd> {
    if (this.abort) throw new Error("codex engine: a turn is already running");
    if (turn.cancelRequested) return { status: "cancelled", error: null, usage: null };
    const mcp = mcpConfig(req.mcp);
    const codex = new Codex({
      codexPathOverride: this.binary,
      env: { ...this.baseEnv(), ...mcp.env },
      config: { model_instructions_file: path.join(this.opts.agentDir, SOUL_FILE), ...mcp.config } as never,
      configOverrides: this.args.config,
    });
    // codex exec cannot ask before a tool runs; the service refuses require_approval "always".
    const threadOptions = { ...this.args.thread, workingDirectory: this.opts.agentDir, skipGitRepoCheck: true, approvalPolicy: "never" as const, ...(req.model ? { model: req.model } : {}) };
    const thread = req.conversation ? codex.resumeThread(req.conversation, threadOptions) : codex.startThread(threadOptions);
    this.abort = new AbortController();
    try {
      const { events } = await thread.runStreamed(foldInput(req.input, req.instructions), { signal: this.abort.signal });
      for await (const ev of events) {
        const end = this.apply(ev, turn);
        if (end) return end;
      }
      return { status: turn.cancelRequested ? "cancelled" : "failed", error: "codex ended without completing the turn", usage: null };
    } catch (err) {
      return { status: turn.cancelRequested ? "cancelled" : "failed", error: err instanceof Error ? err.message : String(err), usage: null };
    } finally {
      this.abort = null;
    }
  }

  private apply(ev: ThreadEvent, turn: Turn): TurnEnd | null {
    switch (ev.type) {
      case "thread.started":
        this.conv = ev.thread_id;
        turn.conversationStarted(ev.thread_id);
        return null;
      case "item.started":
      case "item.updated":
      case "item.completed":
        this.applyItem(ev.type, ev.item, turn);
        return null;
      case "turn.completed":
        return { status: "completed", error: null, usage: ev.usage ? usage(ev.usage.input_tokens, ev.usage.output_tokens) : null };
      case "turn.failed":
        return { status: "failed", error: ev.error?.message ?? "turn failed", usage: null };
      case "error":
        return { status: "failed", error: ev.message, usage: null };
      default:
        return null;
    }
  }

  private applyItem(phase: string, item: ThreadItem, turn: Turn): void {
    if (item.type === "agent_message" && phase === "item.completed" && item.text) turn.textDone(item.text);
    else if (item.type === "reasoning" && phase === "item.completed" && item.text) turn.reasoning(item.text, "summary");
    else if (item.type === "mcp_tool_call") {
      if (phase === "item.started") turn.mcpCallStarted(item.id, { server: item.server, name: item.tool, arguments: item.arguments });
      if (phase === "item.completed") turn.mcpCallEnded(item.id, item.result ? item.result.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n") : "", item.error?.message ?? (item.status === "failed" ? "failed" : null));
    } else if (item.type === "command_execution") {
      if (phase === "item.started") turn.builtinStarted(item.id, { kind: "shell", command: item.command });
      if (phase === "item.completed") turn.builtinEnded(item.id, { output: item.aggregated_output, failed: item.status === "failed" || (item.exit_code ?? 0) !== 0, exitCode: item.exit_code ?? null });
    } else if (item.type === "file_change" && phase === "item.completed") {
      for (const [i, c] of item.changes.entries()) {
        const id = `${item.id}_${i}`;
        turn.builtinStarted(id, { kind: "apply_patch", path: c.path, diff: "", operation: c.kind === "add" ? "create_file" : c.kind === "delete" ? "delete_file" : "update_file" });
        turn.builtinEnded(id, { output: `${c.kind} ${c.path}`, failed: item.status === "failed" });
      }
    } else if (item.type === "web_search") {
      if (phase === "item.started") turn.builtinStarted(item.id, { kind: "web_search", query: item.query });
      if (phase === "item.completed") turn.builtinEnded(item.id, { output: "", failed: false });
    }
  }

  async steer(): Promise<boolean> {
    return false; // codex exec takes no input mid-turn
  }

  async cancel(): Promise<void> {
    this.abort?.abort();
  }

  state(): EngineState {
    return { running: this.abort !== null, conversation: this.conv, model: null, subagents: 0 };
  }

  async conversation(): Promise<ConversationMessage[] | null> {
    return null; // the Codex SDK has no reader for a thread's past
  }

  async stop(): Promise<void> {
    await this.cancel();
  }
}

registerEngine({
  name: "codex",
  needsSoul: true,
  options: [{ name: "codex-bin", kind: "string", help: "codex engine: the Codex CLI binary (default: codex on PATH)" }],
  create: (o: EngineOptions) => new CodexEngine(o),
});
