import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeEngine, builtinCall, toExtraArgs } from "../src/engine/claude.js";
import { AgentService } from "../src/service/agent.js";
import { defaultToolAttacher } from "../src/mcp/translate.js";
import { collectChain, req, textOf } from "./helpers.js";

async function mk(engineArgs: string[] = [], extraInstructions: string | null = null) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-claude-"));
  const e = new ClaudeEngine({ agentDir, extraInstructions, engineArgs, exec: [], values: new Map(), queryFn: () => { throw new Error("not started"); } });
  await e.start();
  return { agentDir, e };
}
const proc = () => ({ abort: new AbortController(), child: null });
type Hook = (input: never, id: string, o: { signal: AbortSignal }) => Promise<unknown>;
const decisionOf = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
const callHook = (e: ClaudeEngine, tool_name: string) => (e.preToolUse as unknown as Hook)({ hook_event_name: "PreToolUse", session_id: "s", transcript_path: "", cwd: "/", tool_name, tool_input: {}, tool_use_id: "t" } as never, "t", { signal: new AbortController().signal });
function activate(e: ClaudeEngine, mcp: { label: string; requireApproval: "never" | "always"; allowedTools: string[] | null }[], asked: string[]) {
  (e as unknown as { active: unknown }).active = {
    turn: { requestApproval: async ({ name }: { name: string }) => (asked.push(name), false) },
    mcp: new Map(mcp.map((m) => [m.label, { url: "http://h", headers: {}, ...m }])),
    steers: new Map(), calls: new Map(), end: () => {}, cancelled: false, error: null, mine: true, uuids: new Set(), proc: null,
  };
}

/** A scripted Claude Code: the test pushes SDK messages; user messages greyfolk sends are recorded. */
class FakeQuery {
  readonly sent: { uuid: string; text: string }[] = [];
  private queue: unknown[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  interrupts = 0;
  constructor(prompt: AsyncIterable<{ uuid: string; message: { content: string } }>) {
    void (async () => {
      for await (const m of prompt) this.sent.push({ uuid: m.uuid, text: m.message.content });
    })();
  }
  push(msg: unknown): void {
    this.queue.push(msg);
    this.wake?.();
  }
  end(): void {
    this.ended = true;
    this.wake?.();
  }
  async setMcpServers() {
    return { added: [], removed: [], errors: {} };
  }
  async setModel() {}
  queued: string[] = [];
  recalled: string[] = [];
  async interrupt() {
    this.interrupts++;
    return { still_queued: this.queued };
  }
  async cancelAsyncMessage(uuid: string) {
    this.recalled.push(uuid);
    return true;
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.queue.length) yield this.queue.shift();
      if (this.ended) {
        await Promise.resolve();
        throw new Error("aborted");
      }
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

async function scripted() {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-claude-"));
  const queries: FakeQuery[] = [];
  const queryFn = (({ prompt, options }: { prompt: never; options: { abortController: AbortController } }) => {
    const q = new FakeQuery(prompt);
    options.abortController.signal.addEventListener("abort", () => q.end());
    queries.push(q);
    return q;
  }) as never;
  const e = new ClaudeEngine({ agentDir, extraInstructions: null, engineArgs: [], exec: [], values: new Map(), queryFn });
  await e.start();
  const agent = new AgentService({ engine: e, modelPolicy: "fixed", attachTools: defaultToolAttacher() });
  return { agent, queries };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const textMsg = (text: string, uuid?: string) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text }] }, ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : {}) });
const result = (uuids: string[]) => ({ type: "result", subtype: "success", is_error: false, result: "", usage: { input_tokens: 1, output_tokens: 1 }, user_message_uuid: uuids.at(-1), user_message_uuids: uuids });
const init = (session: string) => ({ type: "system", subtype: "init", session_id: session, model: "claude-x" });

describe("claude engine (Claude Agent SDK)", () => {
  it("uses the agent folder as Claude Code's home, its settings and CLAUDE.md as they are, under Claude Code's own system prompt", async () => {
    const { agentDir, e } = await mk();
    const o = e.buildOptions(proc(), null);
    expect(o.cwd).toBe(agentDir);
    expect(o.env?.CLAUDE_CONFIG_DIR).toBe(agentDir);
    expect(o.settingSources).toEqual(["user"]);
    expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect((await mk([], "Added.")).e.buildOptions(proc(), null).systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "Added." });
    expect(o.mcpServers).toBeUndefined(); // a turn's servers go over the control channel
    expect(o.tools).toBeUndefined(); // greyfolk sets no tools of its own
    expect(e.buildOptions(proc(), "sess-1").resume).toBe("sess-1");
  });

  it("passes the engine's own options to Claude Code as they are", async () => {
    expect(toExtraArgs(["--tools", "Agent,TodoWrite", "--disallowedTools=Bash", "--verbose"])).toEqual({ tools: "Agent,TodoWrite", disallowedTools: "Bash", verbose: null });
    expect(() => toExtraArgs(["tools"])).toThrow(/must start with --/);
    const { e } = await mk(["--tools", "Agent"]);
    expect(e.buildOptions(proc(), null).extraArgs).toEqual({ tools: "Agent" });
  });

  it("applies the request's allowed_tools and require_approval before an MCP tool runs (approval → mcp_approval_request)", async () => {
    const asked: string[] = [];
    const { e } = await mk();
    activate(e, [{ label: "zone", requireApproval: "never", allowedTools: ["file_read"] }, { label: "ext", requireApproval: "always", allowedTools: null }], asked);
    expect(decisionOf(await callHook(e, "mcp__zone__file_read"))).toBe("allow");
    expect(decisionOf(await callHook(e, "mcp__zone__file_write"))).toBe("deny");
    expect(decisionOf(await callHook(e, "mcp__other__x"))).toBe("deny");
    expect(decisionOf(await callHook(e, "mcp__ext__send"))).toBe("deny");
    expect(asked).toEqual(["send"]);
    expect(decisionOf(await callHook(e, "Agent"))).toBeUndefined();
  });

  it("writes Claude Code's own tools as the standard item that means the same", () => {
    expect(builtinCall("Bash", { command: "ls" })).toEqual({ kind: "shell", command: "ls" });
    expect(builtinCall("Write", { file_path: "/a", content: "x" })).toMatchObject({ kind: "apply_patch", path: "/a", operation: "create_file" });
    expect(builtinCall("WebSearch", { query: "q" })).toEqual({ kind: "web_search", query: "q" });
    expect(builtinCall("Agent", { prompt: "p" })).toEqual({ kind: "custom", name: "Agent", input: { prompt: "p" } });
  });

  it("an MCP tool runs only in a step that answers the turn", async () => {
    const { e } = await mk();
    activate(e, [{ label: "zone", requireApproval: "never", allowedTools: null }], []);
    (e as unknown as { active: { mine: boolean } }).active.mine = false;
    expect(decisionOf(await callHook(e, "mcp__zone__send"))).toBe("deny");
  });

  it("a new conversation after a turn starts cleanly (the old process ending does not touch it)", async () => {
    const { agent, queries } = await scripted();
    const r1 = await agent.create(req("one"));
    const c1 = collectChain(agent, r1.id);
    await tick();
    const q1 = queries[0]!;
    q1.push(init("s1"));
    q1.push(textMsg("first", q1.sent[0]!.uuid));
    q1.push(result([q1.sent[0]!.uuid]));
    expect((await c1).last.status).toBe("completed");
    const r2 = await agent.create(req("two"));
    const c2 = collectChain(agent, r2.id);
    await tick();
    await tick();
    const q2 = queries[1]!;
    q2.push(init("s2"));
    q2.push(textMsg("second", q2.sent[0]!.uuid));
    q2.push(result([q2.sent[0]!.uuid]));
    const { last } = await c2;
    expect(last.status).toBe("completed");
    expect(textOf(last)).toBe("second");
    expect(last.conversation?.id).toBe("s2");
  });

  it("a step Claude Code runs on its own does not end the turn; previous_response_id keeps the conversation", async () => {
    const { agent, queries } = await scripted();
    const r1 = await agent.create(req("one"));
    const c1 = collectChain(agent, r1.id);
    await tick();
    const q = queries[0]!;
    q.push(init("s1"));
    q.push(textMsg("late subagent news", "own-uuid"));
    q.push(result(["own-uuid"]));
    await tick();
    expect(agent.retrieve(r1.id).status).toBe("in_progress");
    q.push(textMsg("answer", q.sent[0]!.uuid));
    q.push(result([q.sent[0]!.uuid]));
    const { last } = await c1;
    expect(textOf(last)).toBe("answer");
    const r2 = await agent.create(req("two", { previous_response_id: last.id }));
    expect(r2.conversation?.id).toBe("s1");
    expect(queries.length).toBe(1);
  });

  it("cancel takes the turn's still-queued message back out of Claude Code (its own steps stay)", async () => {
    const { agent, queries } = await scripted();
    const r = await agent.create(req("one"));
    const c = collectChain(agent, r.id);
    await tick();
    const q = queries[0]!;
    q.push(init("s1"));
    q.push(textMsg("late subagent news", "own-uuid")); // Claude Code is busy with a step of its own
    await tick();
    q.queued = [q.sent[0]!.uuid];
    await agent.cancel(r.id);
    expect((await c).last.status).toBe("cancelled");
    expect(q.recalled).toEqual([q.sent[0]!.uuid]);
    expect(q.interrupts).toBe(1);
  });
});
