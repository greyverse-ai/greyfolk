import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexEngine, mcpConfig, parseCodexArgs } from "../src/engine/codex.js";
import { AgentService } from "../src/service/agent.js";
import { defaultToolAttacher } from "../src/mcp/translate.js";
import { collectChain, req, sleep } from "./helpers.js";

/** A stand-in `codex` binary for the Codex SDK: lists features, or records what it got and plays a turn. */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "features") {
  const known = (process.env.FAKE_CODEX_FEATURES || "").split(",").filter(Boolean);
  process.stdout.write(known.map((f) => f.replace(/^!/, "") + "  stable  " + (f.startsWith("!") ? "false" : "true")).join("\\n") + "\\n");
  process.exit(0);
}
const prompt = fs.readFileSync(0, "utf8");
const secrets = Object.keys(process.env).filter((k) => k.startsWith("GREYFOLK_MCP_")).reduce((o, k) => ((o[k] = process.env[k]), o), {});
fs.writeFileSync(process.env.CODEX_HOME + "/seen.json", JSON.stringify({ args, prompt, secrets }));
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
  say({ type: "item.started", item: { id: "c2", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" } });
  say({ type: "item.completed", item: { id: "c2", type: "command_execution", command: "ls", aggregated_output: "a", exit_code: 0, status: "completed" } });
  say({ type: "item.completed", item: { id: "a1", type: "agent_message", text: "echo: " + prompt.trim() } });
  say({ type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 4 } });
}
`;

async function setup(engineArgs: string[] = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-codex-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  const bin = path.join(root, "codex");
  await fs.writeFile(bin, FAKE_CODEX, { mode: 0o755 });
  const engine = new CodexEngine({
    agentDir,
    soul: "You are a test soul.",
    engineArgs,
    exec: [],
    values: new Map(),
    codexPath: bin,
  });
  const agent = new AgentService({ engine, modelPolicy: "fixed", attachTools: defaultToolAttacher() });
  return { agent, agentDir };
}
const seen = async (dir: string) => JSON.parse(await fs.readFile(path.join(dir, "seen.json"), "utf8")) as { args: string[]; prompt: string; secrets: Record<string, string> };
const zone = (headers: Record<string, string> = {}) => [{ type: "mcp", server_label: "zone", server_url: "http://h/mcp", headers, require_approval: "never" }];

describe("codex engine (Codex SDK)", () => {
  it("puts MCP credentials only in named environment variables, never in config or argv", () => {
    const { config, env } = mcpConfig([{ kind: "http", label: "zone", url: "http://h/mcp", headers: { Authorization: "Bearer t" }, requireApproval: "never", allowedTools: ["file_read"] }]);
    expect(JSON.stringify(config)).not.toContain("Bearer t");
    expect(config).toEqual({ mcp_servers: { zone: { default_tools_approval_mode: "approve", enabled_tools: ["file_read"], url: "http://h/mcp", env_http_headers: { Authorization: "GREYFOLK_MCP_0_H0" } } } });
    expect(env).toEqual({ GREYFOLK_MCP_0_H0: "Bearer t" });
  });

  it("runs a turn through the SDK, resumes the conversation by id, and writes items as their standard types", async () => {
    const { agent, agentDir } = await setup();
    await agent.init();
    const r = await agent.create(req("hi", { tools: zone({ Authorization: "Bearer s3cret" }) }));
    const { last } = await collectChain(agent, r.id);
    const s = await seen(agentDir);
    expect(s.args.join(" ")).not.toContain("s3cret");
    expect(Object.values(s.secrets)).toContain("Bearer s3cret");
    expect(s.args).toContain('approval_policy="never"');
    expect(last.status, JSON.stringify(last.error)).toBe("completed");
    expect(last.conversation?.id).toBe("thread-1");
    expect(last.output.map((o) => o.type)).toEqual(["mcp_call", "shell_call", "shell_call_output", "message"]);
    const r2 = await agent.create(req("again", { conversation: "thread-1" }));
    await collectChain(agent, r2.id);
    expect((await seen(agentDir)).args.slice(-2)).toEqual(["resume", "thread-1"]);
  });

  it("passes the engine's own options through the SDK as config overrides; refuses what the SDK cannot carry", async () => {
    expect(parseCodexArgs(["--sandbox", "read-only", "-c", 'web_search="disabled"', "--disable", "shell_tool", "--enable=goals", "-m", "gpt-x"])).toEqual({
      thread: { sandboxMode: "read-only", model: "gpt-x" },
      config: ['web_search="disabled"', "features.shell_tool=false", "features.goals=true"],
    });
    expect(() => parseCodexArgs(["--json", "x"])).toThrow(/cannot be passed through the Codex SDK/);
    const { agent, agentDir } = await setup(["--sandbox", "read-only", "--disable", "shell_tool", "-c", 'web_search="disabled"']);
    await agent.init();
    await collectChain(agent, (await agent.create(req("hi"))).id);
    const a = (await seen(agentDir)).args.join(" ");
    expect(a).toContain("features.shell_tool=false");
    expect(a).toContain('web_search="disabled"');
    expect(a).toContain("--sandbox read-only");
  });

  it("refuses require_approval 'always'; cancel aborts the turn", async () => {
    const { agent } = await setup();
    await agent.init();
    await expect(agent.create(req("hi", { tools: [{ ...zone()[0], require_approval: "always" }] }))).rejects.toMatchObject({ code: "unsupported_tool" });
    const r = await agent.create(req("[slow]"));
    const chain = collectChain(agent, r.id);
    await sleep(300);
    await agent.cancel(r.id);
    expect((await chain).last.status).toBe("cancelled");
  });
});
