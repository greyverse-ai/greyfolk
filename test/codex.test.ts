import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodexEngine, checkCodexArgs, mcpConfig } from "../src/engine/codex.js";
import { AgentService } from "../src/service/agent.js";
import type { AgentResponse } from "../src/api/types.js";
import { collectChain, req, sleep, textOf } from "./helpers.js";
import { mcpCall, message, mockMcp, mockModel, shellCall } from "./codex-mocks.js";

let model: Awaited<ReturnType<typeof mockModel>>;
let mcp: Awaited<ReturnType<typeof mockMcp>>;
const agents: AgentService[] = [];

beforeAll(async () => {
  model = await mockModel(({ input, instructions, lastUser, freshToolOutput }) => {
    if (freshToolOutput) return { items: [message("tool done")] };
    if (lastUser.includes("[soul?]")) {
      const seen = JSON.stringify(input);
      return { items: [message(`folder=${seen.includes("SOUL-MARKER")} added=${seen.includes("ADDED-MARKER")} own=${instructions.length > 1000}`)] };
    }
    if (lastUser.includes("[mcp]")) return { items: [mcpCall("zone", "send", { text: "hi" })] };
    if (lastUser.includes("[shell]")) return { items: [shellCall("echo hello; exit 3")] };
    if (lastUser.includes("[slow]")) return { items: [message("one"), message("two"), message("three")], delayMs: 400 };
    return { items: [message(`echo ${lastUser}`)] };
  });
  mcp = await mockMcp();
});
afterAll(async () => {
  for (const a of agents) await a.close();
  model.close();
  mcp.close();
});

/** A codex agent on the real pinned binary, its model the mock (no login anywhere). */
async function codexAgent(extra: string[] = [], extraInstructions: string | null = null) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-codex-"));
  await fs.writeFile(path.join(agentDir, "AGENTS.md"), "You are SOUL-MARKER.\n");
  const engineArgs = ["-c", 'model_provider="mock"', "-c", `model_providers.mock={name="mock",base_url="${model.url}",wire_api="responses"}`, "-c", 'model="gpt-mock"', "-c", 'sandbox_mode="read-only"', ...extra];
  const engine = new CodexEngine({ agentDir, extraInstructions, engineArgs, exec: [], values: new Map(), env: { HOME: agentDir } });
  const agent = new AgentService({ engine, modelPolicy: "fixed" });
  await agent.init();
  agents.push(agent);
  return { agent, engine, agentDir };
}
const zone = (token: string, requireApproval: "never" | "always" = "never") => [{ type: "mcp", server_label: "zone", server_url: mcp.url, headers: { Authorization: `Bearer ${token}` }, require_approval: requireApproval }];
const itemTypes = (r: AgentResponse) => r.output.map((o) => o.type);

describe("codex engine (codex app-server)", () => {
  it("maps a turn's MCP servers to thread config; refuses options greyfolk owns", () => {
    expect(mcpConfig([{ label: "zone", url: "http://h", headers: { Authorization: "Bearer t" }, requireApproval: "always", allowedTools: ["send"] }])).toEqual({
      mcp_servers: { zone: { url: "http://h", http_headers: { Authorization: "Bearer t" }, default_tools_approval_mode: "prompt", enabled_tools: ["send"] } },
    });
    expect(() => checkCodexArgs(["--listen", "ws://x"])).toThrow(/greyfolk's own/);
    expect(() => checkCodexArgs(["-c", "x=1", "--enable", "f"])).not.toThrow();
  });

  it("Codex reads the folder's AGENTS.md itself under its own instructions; --soul adds to them", async () => {
    for (const [extra, want] of [[null, "folder=true added=false own=true"], ["ADDED-MARKER", "folder=true added=true own=true"]] as const) {
      const { agent } = await codexAgent([], extra);
      const r = await agent.create(req("[soul?]"));
      expect(textOf((await collectChain(agent, r.id)).last)).toBe(want);
    }
  });

  it("runs turns in one process: MCP and shell calls as standard items; the next turn's credentials reach the MCP server", async () => {
    const { agent, engine } = await codexAgent();
    const r1 = await agent.create(req("please [mcp]", { tools: zone("TOKEN-ONE") }));
    const { last: a } = await collectChain(agent, r1.id);
    expect(a.status).toBe("completed");
    expect(itemTypes(a)).toEqual(["mcp_call", "message"]);
    expect(a.output[0]).toMatchObject({ type: "mcp_call", server_label: "zone", name: "send", status: "completed" });
    expect(a.usage?.input_tokens).toBeGreaterThan(0);
    const pid = (engine as unknown as { rpc: { child: { pid: number } } }).rpc.child.pid;
    const r2 = await agent.create(req("again [mcp]", { previous_response_id: a.id, tools: zone("TOKEN-TWO") }));
    const { last: b } = await collectChain(agent, r2.id);
    expect(b.conversation?.id).toBe(a.conversation?.id);
    expect(mcp.auth.slice(-2)).toEqual(["Bearer TOKEN-ONE", "Bearer TOKEN-TWO"]);
    const r3 = await agent.create(req("now [shell]", { previous_response_id: b.id, tools: zone("TOKEN-TWO") }));
    const { last: c } = await collectChain(agent, r3.id);
    expect(itemTypes(c)).toEqual(["shell_call", "shell_call_output", "message"]);
    expect(c.output[1]).toMatchObject({ type: "shell_call_output", output: [{ outcome: { type: "exit", exit_code: 3 } }] });
    expect((engine as unknown as { rpc: { child: { pid: number } } }).rpc.child.pid).toBe(pid);
    const items = await agent.conversationItems(a.conversation!.id);
    expect(items.data.map((d) => (d as { role: string }).role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });

  it("approval: the response ends with mcp_approval_request; approve runs the call in the successor, decline never shows it", async () => {
    const { agent } = await codexAgent(["-c", 'approval_policy="on-request"']);
    const r = await agent.create(req("please [mcp]", { tools: zone("TOKEN-A", "always") }));
    const { last: asked } = await collectChain(agent, r.id);
    expect(itemTypes(asked)).toEqual(["mcp_approval_request"]);
    const approval = asked.output[0] as { id: string };
    const next = await agent.create(req([{ type: "mcp_approval_response", approval_request_id: approval.id, approve: true }], { previous_response_id: asked.id, tools: zone("TOKEN-A", "always") }));
    const { last: done } = await collectChain(agent, next.id);
    expect(itemTypes(done)).toEqual(["mcp_call", "message"]);
    expect(done.output[0]).toMatchObject({ status: "completed" });
    const r2 = await agent.create(req("again [mcp]", { previous_response_id: done.id, tools: zone("TOKEN-A", "always") }));
    const { last: asked2 } = await collectChain(agent, r2.id);
    const no = await agent.create(req([{ type: "mcp_approval_response", approval_request_id: (asked2.output[0] as { id: string }).id, approve: false }], { previous_response_id: asked2.id, tools: zone("TOKEN-A", "always") }));
    const { last: declined } = await collectChain(agent, no.id);
    expect(itemTypes(declined)).toEqual(["message"]);
  });

  it("steer is taken into the running turn; cancel interrupts it", async () => {
    const { agent } = await codexAgent();
    const r = await agent.create(req("go [slow]"));
    const chain = collectChain(agent, r.id);
    await sleep(600);
    expect(await (await agent.steer(r.id, "steered words")).result).toBe("taken_in");
    const { last } = await chain;
    expect(agent.retrieve(r.id).incomplete_details).toEqual({ reason: "steered" });
    expect(textOf(last)).toContain("steered words");
    const r2 = await agent.create(req("go [slow] again", { previous_response_id: last.id }));
    const c2 = collectChain(agent, r2.id);
    await sleep(600);
    await agent.cancel(r2.id);
    expect((await c2).last.status).toBe("cancelled");
    expect(agent.state().busy).toBe(false);
  });
});
