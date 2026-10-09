import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexHarness, buildArgs, mcpProfileToml, profileName, tomlValue } from "../src/harness/codex.js";
import type { McpAttachment } from "../src/harness/types.js";
import type { HarnessEvent } from "../src/harness/types.js";

/** A stand-in `codex` binary: prints the argv it got, then a scripted JSONL event stream. */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
const args = process.argv.slice(2);
const dir = process.env.CODEX_HOME;
const pi = args.indexOf("--profile");
const profileFile = pi >= 0 ? dir + "/" + args[pi + 1] + ".config.toml" : null;
const profile = profileFile ? { text: fs.readFileSync(profileFile, "utf8"), mode: fs.statSync(profileFile).mode & 0o777 } : null;
fs.writeFileSync(dir + "/argv.json", JSON.stringify({ args, prompt, home: dir, profile }));
const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const resumed = args.includes("resume") ? args[args.indexOf("resume") + 1] : null;
say({ type: "thread.started", thread_id: resumed ?? "thread-1" });
say({ type: "turn.started" });
if (prompt.includes("[slow]")) {
  say({ type: "item.started", item: { id: "c1", type: "command_execution", command: "sleep 30", aggregated_output: "", status: "in_progress" } });
  setTimeout(() => {}, 30000);
} else {
  say({ type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "zone", tool: "ping", arguments: { x: 1 }, status: "in_progress" } });
  say({ type: "item.completed", item: { id: "m1", type: "mcp_tool_call", server: "zone", tool: "ping", arguments: { x: 1 }, status: "completed", result: { content: [{ type: "text", text: "pong" }], structured_content: null } } });
  say({ type: "item.completed", item: { id: "a1", type: "agent_message", text: "echo: " + prompt.trim() } });
  say({ type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 } });
}
`;

async function setup(sessionId: string | null = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-codex-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  const bin = path.join(root, "codex");
  await fs.writeFile(bin, FAKE_CODEX, { mode: 0o755 });
  const ids: string[] = [];
  const h = new CodexHarness({ agentDir, soul: "You are a test soul.", sessionId, harnessExec: [], model: null, subagentProfile: null, onSessionId: (id) => ids.push(id), codexPath: bin });
  await h.prepare();
  return { h, agentDir, ids };
}

async function run(h: CodexHarness, text: string, mcp: McpAttachment[] = []): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const ev of h.startTurn({ responseId: "r1", input: [{ role: "user", text }], instructions: null, model: null, mcp, onPermissionRequest: async () => "deny" })) out.push(ev);
  return out;
}

describe("codex harness", () => {
  it("encodes MCP attachments as a TOML config layer, never as argv", () => {
    expect(tomlValue({ a: "x", "b c": [1, true] })).toBe('{ a = "x", "b c" = [1, true] }');
    const toml = mcpProfileToml([
      { kind: "http", label: "zone", url: "http://h/mcp", headers: { Authorization: "Bearer t" }, requireApproval: "never" },
      { kind: "stdio", label: "br", command: "node", args: ["x.js"], env: { A: "1" }, requireApproval: "never" },
    ]);
    expect(toml).toBe(['[mcp_servers.zone]', 'url = "http://h/mcp"', 'http_headers = { Authorization = "Bearer t" }', '', '[mcp_servers.br]', 'command = "node"', 'args = ["x.js"]', 'env = { A = "1" }', ''].join("\n"));
    const args = buildArgs({ soulFile: "/a/.greyfolk/run/soul.md", agentDir: "/a", profile: profileName("resp_1/x"), model: "gpt-x", threadId: "t1", sandbox: "read-only" });
    expect(args.slice(0, 2)).toEqual(["exec", "--experimental-json"]);
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--profile");
    expect(args[args.indexOf("--profile") + 1]).toBe("greyfolk-resp_1_x");
    expect(args.slice(-3)).toEqual(["resume", "t1", "-"]);
    expect(args).toContain('approval_policy="never"');
    expect(args.join(" ")).not.toContain("mcp_servers");
  });

  it("hands MCP headers over in a private per-turn 0600 config layer that is deleted after the turn", async () => {
    const { h, agentDir } = await setup();
    const events = await run(h, "secret test", [{ kind: "http", label: "zone", url: "http://h/mcp", headers: { Authorization: "Bearer s3cret-token" }, requireApproval: "never" }]);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "completed" });
    const argv = JSON.parse(await fs.readFile(path.join(agentDir, "argv.json"), "utf8")) as { args: string[]; profile: { text: string; mode: number } | null };
    expect(argv.args.join(" ")).not.toContain("s3cret-token");
    expect(argv.args.join(" ")).not.toContain("mcp_servers");
    expect(argv.args).toContain("--profile");
    expect(argv.profile).not.toBeNull();
    expect(argv.profile!.text).toContain("[mcp_servers.zone]");
    expect(argv.profile!.text).toContain('Authorization = "Bearer s3cret-token"');
    expect(argv.profile!.mode).toBe(0o600);
    const left = (await fs.readdir(agentDir)).filter((f) => f.endsWith(".config.toml"));
    expect(left).toEqual([]);
  });

  it("runs a process per turn with CODEX_HOME = agent folder and maps the JSONL stream", async () => {
    const { h, agentDir, ids } = await setup();
    const events = await run(h, "hi", [{ kind: "http", label: "zone", url: "http://h/mcp", headers: {}, requireApproval: "never" }]);
    const argv = JSON.parse(await fs.readFile(path.join(agentDir, "argv.json"), "utf8")) as { args: string[]; prompt: string; home: string; profile: { text: string } | null };
    expect(argv.home).toBe(agentDir);
    expect(argv.prompt).toBe("hi");
    expect(argv.args.join(" ")).not.toContain("mcp_servers");
    expect(argv.profile!.text).toContain('url = "http://h/mcp"');
    expect(argv.args).toContain(`model_instructions_file=${JSON.stringify(path.join(agentDir, ".greyfolk", "run", "soul.md"))}`);
    expect(await fs.readFile(path.join(agentDir, ".greyfolk", "run", "soul.md"), "utf8")).toBe("You are a test soul.");
    expect(ids).toEqual(["thread-1"]);
    expect(h.sessionId()).toBe("thread-1");
    expect(events.map((e) => e.type)).toEqual(["session", "tool_call", "tool_result", "text_delta", "message_done", "done"]);
    const done = events.at(-1) as Extract<HarnessEvent, { type: "done" }>;
    expect(done.status).toBe("completed");
    expect(done.usage).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    expect(h.status().state).toBe("idle");
    // Second turn resumes the thread.
    await run(h, "again");
    const argv2 = JSON.parse(await fs.readFile(path.join(agentDir, "argv.json"), "utf8")) as { args: string[] };
    expect(argv2.args.slice(-3)).toEqual(["resume", "thread-1", "-"]);
    expect(ids).toEqual(["thread-1"]);
  });

  it("cancel kills the process and ends the turn cancelled; steer is refused", async () => {
    const { h } = await setup();
    const it = h.startTurn({ responseId: "r2", input: [{ role: "user", text: "[slow]" }], instructions: null, model: null, mcp: [], onPermissionRequest: async () => "deny" });
    const events: HarnessEvent[] = [];
    const consume = (async () => {
      for await (const ev of it) events.push(ev);
    })();
    while (!events.some((e) => e.type === "tool_call")) await new Promise((r) => setTimeout(r, 10));
    expect(await h.steer("s1", [{ role: "user", text: "x" }])).toBe("response_ended");
    await h.cancel();
    await consume;
    expect(events.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
  });

  it("reads history back from the rollout file", async () => {
    const { h, agentDir } = await setup("thread-9");
    const dir = path.join(agentDir, "sessions", "2026", "10", "08");
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      { timestamp: "t0", type: "session_meta", payload: { id: "thread-9" } },
      { timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
      { timestamp: "t2", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { timestamp: "t3", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] } },
    ];
    await fs.writeFile(path.join(dir, "rollout-2026-10-08T00-00-00-thread-9.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(await h.history()).toEqual([
      { role: "user", text: "hello", at: "t2" },
      { role: "assistant", text: "hi there", at: "t3" },
    ]);
  });
});
