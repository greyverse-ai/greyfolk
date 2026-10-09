import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexEngine, HOST_FEATURES, NON_HOST_FEATURES, buildArgs, mcpProfileToml, profileName, redacted, tomlValue } from "../src/engine/codex.js";
import { TOOL_KINDS } from "../src/options.js";
import { AgentService } from "../src/service/agent-service.js";
import { defaultToolAttacher } from "../src/mcp/translate.js";
import { collectChain, req, sleep } from "./helpers.js";

/** A stand-in `codex` binary: lists features, or prints the argv it got and a scripted JSONL event stream. */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "features") {
  const known = (process.env.FAKE_CODEX_FEATURES || "").split(",").filter(Boolean);
  process.stdout.write(known.map((f) => f.replace(/^!/, "") + "  stable  " + (f.startsWith("!") ? "false" : "true")).join("\\n") + "\\n");
  process.exit(0);
}
const prompt = fs.readFileSync(0, "utf8");
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

async function setup(opts: { noHostTools?: boolean; features?: string[] } = {}) {
  const disabledTools = new Set(opts.noHostTools ? TOOL_KINDS : []);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-codex-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  const bin = path.join(root, "codex");
  await fs.writeFile(bin, FAKE_CODEX, { mode: 0o755 });
  const env = { FAKE_CODEX_FEATURES: (opts.features ?? [...HOST_FEATURES, ...NON_HOST_FEATURES]).join(",") };
  const agent = new AgentService({
    createEngine: () => new CodexEngine({ agentDir, soul: "You are a test soul.", disabledTools, exec: [], values: new Map(), subagentProfile: null, codexPath: bin, env }),
    agentDir,
    modelPolicy: "fixed",
    resetArchiveDir: path.join(root, "archive"),
    attachTools: defaultToolAttacher(),
  });
  return { agent, agentDir, root };
}

const argvOf = async (agentDir: string) => JSON.parse(await fs.readFile(path.join(agentDir, "argv.json"), "utf8")) as { args: string[]; prompt: string; home: string; profile: { text: string; mode: number } | null };
const zone = (headers: Record<string, string> = {}) => [{ type: "mcp", server_label: "zone", server_url: "http://h/mcp", headers, require_approval: "never" }];

describe("codex engine", () => {
  it("encodes MCP attachments as a TOML config layer that approves its tools, never as argv", () => {
    expect(tomlValue({ a: "x", "b c": [1, true] })).toBe('{ a = "x", "b c" = [1, true] }');
    const toml = mcpProfileToml([
      { kind: "http", label: "zone", url: "http://h/mcp", headers: { Authorization: "Bearer t" }, requireApproval: "never", allowedTools: ["file_read"] },
      { kind: "stdio", label: "br", command: "node", args: ["x.js"], env: { A: "1" }, requireApproval: "never", allowedTools: null },
    ]);
    expect(toml).toBe(['[mcp_servers.zone]', 'url = "http://h/mcp"', 'http_headers = { Authorization = "Bearer t" }', 'default_tools_approval_mode = "approve"', 'enabled_tools = ["file_read"]', '', '[mcp_servers.br]', 'command = "node"', 'args = ["x.js"]', 'env = { A = "1" }', 'default_tools_approval_mode = "approve"', ''].join("\n"));
    const args = buildArgs({ soulFile: "/a/.greyfolk/run/soul.md", agentDir: "/a", profile: profileName("resp_1/x"), model: "gpt-x", threadId: "t1", disabled: new Set() });
    expect(args.slice(0, 2)).toEqual(["exec", "--experimental-json"]);
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(args[args.indexOf("--profile") + 1]).toBe("greyfolk-resp_1_x");
    expect(args.slice(-3)).toEqual(["resume", "t1", "-"]);
    expect(args).toContain('approval_policy="never"');
    expect(args.join(" ")).not.toContain("mcp_servers");
  });

  it("with host tools off: read-only sandbox, every host feature disabled, web search off", () => {
    const args = buildArgs({ soulFile: "/a/s.md", agentDir: "/a", profile: null, model: null, threadId: null, disabled: new Set(TOOL_KINDS) });
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    for (const f of HOST_FEATURES) expect(args.join(" ")).toContain(`--disable ${f}`);
    expect(args).toContain('web_search="disabled"');
  });

  it("refuses to start with host tools off when this Codex does not know a feature it must disable (fail closed)", async () => {
    const { agent } = await setup({ noHostTools: true, features: [...HOST_FEATURES.slice(1), ...NON_HOST_FEATURES] });
    await expect(agent.init()).rejects.toThrow(/cannot confirm Codex host tools are off.*shell_tool/);
    const ok = await setup({ noHostTools: true });
    await ok.agent.init();
  });

  it("with host tools off, refuses a Codex that has an enabled feature not yet classified (allow-list)", async () => {
    const { agent } = await setup({ noHostTools: true, features: [...HOST_FEATURES, ...NON_HOST_FEATURES, "new_shiny_tool", "!old_off_tool"] });
    await expect(agent.init()).rejects.toThrow(/not yet classified.*new_shiny_tool/);
  });

  it("redacts and shortens engine stderr before it reaches an error message", () => {
    expect(redacted("")).toBe("");
    const r = redacted("error: Authorization: Bearer sk-live-123 at https://h/x?token=abc&y=1");
    expect(r).not.toContain("sk-live-123");
    expect(r).not.toContain("abc");
    expect(redacted("x".repeat(2000)).length).toBeLessThan(420);
  });

  it("refuses require_approval 'always': codex exec cannot ask before a tool runs", async () => {
    const { agent } = await setup();
    await agent.init();
    await expect(agent.create(req("hi", { tools: [{ ...zone()[0], require_approval: "always" }] }))).rejects.toMatchObject({ status: 400, code: "unsupported_tool", param: "tools[0].require_approval" });
  });

  it("hands MCP headers over in a private per-turn 0600 config layer that is deleted after the turn", async () => {
    const { agent, agentDir } = await setup();
    await agent.init();
    const r = await agent.create(req("secret test", { tools: zone({ Authorization: "Bearer s3cret-token" }) }));
    const { last, events } = await collectChain(agent, r.id);
    expect(last.status).toBe("completed");
    expect(JSON.stringify(events)).not.toContain("s3cret-token");
    const argv = await argvOf(agentDir);
    expect(argv.args.join(" ")).not.toContain("s3cret-token");
    expect(argv.profile!.text).toContain('Authorization = "Bearer s3cret-token"');
    expect(argv.profile!.mode).toBe(0o600);
    expect((await fs.readdir(agentDir)).filter((f) => f.endsWith(".config.toml"))).toEqual([]);
  });

  it("runs a process per turn with CODEX_HOME = agent folder and writes the JSONL stream as Responses events", async () => {
    const { agent, agentDir } = await setup();
    await agent.init();
    const r = await agent.create(req("hi", { tools: zone() }));
    const { events, last } = await collectChain(agent, r.id);
    const argv = await argvOf(agentDir);
    expect(argv.home).toBe(agentDir);
    expect(argv.prompt).toBe("hi");
    expect(argv.args).toContain(`model_instructions_file=${JSON.stringify(path.join(agentDir, ".greyfolk", "run", "soul.md"))}`);
    expect(await fs.readFile(path.join(agentDir, ".greyfolk", "run", "soul.md"), "utf8")).toBe("You are a test soul.");
    expect(agent.status().session_id).toBe("thread-1");
    expect(await fs.readFile(path.join(agentDir, ".greyfolk", "session"), "utf8")).toBe("thread-1\n");
    expect(events.map((e) => e.type)).toContain("response.mcp_call.completed");
    expect(last.output.map((o) => o.type)).toEqual(["mcp_call", "message"]);
    expect(last.usage).toMatchObject({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    const r2 = await agent.create(req("again"));
    await collectChain(agent, r2.id);
    expect((await argvOf(agentDir)).args.slice(-3)).toEqual(["resume", "thread-1", "-"]);
  });

  it("cancel kills the process and ends the turn cancelled; steer is refused", async () => {
    const { agent } = await setup();
    await agent.init();
    const r = await agent.create(req("[slow]"));
    const chain = collectChain(agent, r.id);
    await sleep(300);
    expect(await (await agent.steer(r.id, "x")).result).toBe("response_ended");
    await agent.cancel(r.id);
    expect((await chain).last.status).toBe("cancelled");
  });

  it("reads history back from the rollout file", async () => {
    const { agent, agentDir } = await setup();
    await fs.mkdir(path.join(agentDir, ".greyfolk"), { recursive: true });
    await fs.writeFile(path.join(agentDir, ".greyfolk", "session"), "thread-9\n");
    await agent.init();
    const dir = path.join(agentDir, "sessions", "2026", "10", "08");
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      { timestamp: "t0", type: "session_meta", payload: { id: "thread-9" } },
      { timestamp: "t1", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
      { timestamp: "t2", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
      { timestamp: "t3", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] } },
    ];
    await fs.writeFile(path.join(dir, "rollout-2026-10-08T00-00-00-thread-9.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(await agent.history()).toEqual([
      { role: "user", text: "hello", at: "t2" },
      { role: "assistant", text: "hi there", at: "t3" },
    ]);
  });
});
