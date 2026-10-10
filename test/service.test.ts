import { describe, expect, it } from "vitest";
import { collectChain, req, sleep, textOf, tmpAgent } from "./helpers.js";
import { ResponseLog } from "../src/service/response-log.js";
import { Turn } from "../src/service/turn.js";
import { applyPatchCall, customToolCall, shellCall, toolOutput, webSearchCall } from "../src/api/items.js";

describe("service: the Responses API over one engine", () => {
  it("runs a turn, streams standard events and names the conversation (the engine's session)", async () => {
    const { agent } = await tmpAgent();
    const r = await agent.create(req("hello world"));
    const { events, last } = await collectChain(agent, r.id);
    expect(events[0]!.type).toBe("response.created");
    expect(events.at(-1)!.type).toBe("response.completed");
    expect(textOf(last)).toBe("echo: hello world");
    expect(last.conversation?.id).toMatch(/^conv_sample_/);
    expect(events.every((e) => !e.type.startsWith("greyfolk."))).toBe(true);
    expect(agent.state().busy).toBe(false);
  });

  it("continues a conversation by its id; one turn at a time", async () => {
    const { agent, engine } = await tmpAgent();
    const a = await agent.create(req("one"));
    await expect(agent.create(req("two"))).rejects.toMatchObject({ status: 409 });
    const conv = (await collectChain(agent, a.id)).last.conversation!.id;
    const b = await agent.create(req("two", { conversation: conv }));
    await collectChain(agent, b.id);
    expect(engine.turns[1]!.conversation).toBe(conv);
    expect((await agent.conversationItems(conv)).data).toHaveLength(4);
  });

  it("previous_response_id must be the latest response; it continues that conversation", async () => {
    const { agent, engine } = await tmpAgent();
    const a = await agent.create(req("a"));
    await collectChain(agent, a.id);
    const b = await agent.create(req("b", { previous_response_id: a.id }));
    await collectChain(agent, b.id);
    expect(engine.turns[1]!.conversation).toBe(engine.turns[0] ? (await agent.retrieve(a.id)).conversation?.id : null);
    await expect(agent.create(req("c", { previous_response_id: a.id }))).rejects.toMatchObject({ code: "previous_response_not_latest" });
  });

  it("picks new input by position; the same text twice is fed twice", async () => {
    const { agent, engine } = await tmpAgent();
    const a = await agent.create(req("yes"));
    await collectChain(agent, a.id);
    const b = await agent.create(req([{ role: "user", content: "yes" }, { role: "assistant", content: "echo: yes" }, { role: "user", content: "yes" }]));
    await collectChain(agent, b.id);
    expect(engine.turns.map((t) => t.input.map((i) => i.content))).toEqual([["yes"], ["yes"]]);
    await expect(agent.create(req([{ role: "user", content: "x" }, { role: "assistant", content: "y" }]))).rejects.toMatchObject({ code: "no_new_input" });
    await expect(agent.create(req([{ role: "user", content: [{ type: "input_audio", data: "x" }] }]))).rejects.toMatchObject({ code: "unsupported_input" });
  });

  it("never echoes a tool's credentials; refuses MCP fields it cannot apply", async () => {
    const { agent } = await tmpAgent();
    const tool = { type: "mcp", server_label: "gz", server_url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer turn-secret" }, require_approval: "never" };
    const r = await agent.create(req("hi", { tools: [tool] }));
    const { events } = await collectChain(agent, r.id);
    expect(JSON.stringify([r, events, agent.retrieve(r.id)])).not.toContain("turn-secret");
    await expect(agent.create(req("hi", { tools: [{ ...tool, authorization: "t" }] }))).rejects.toMatchObject({ code: "unsupported_tool", param: "tools[0].authorization" });
    await expect(agent.create(req("hi", { tools: [{ ...tool, allowed_tools: { read_only: true } }] }))).rejects.toMatchObject({ param: "tools[0].allowed_tools" });
  });

  it("steer: the live response ends incomplete (steered) and a successor answers; late or impossible steers fail", async () => {
    const { agent } = await tmpAgent({ wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta epsilon zeta"));
    const chain = collectChain(agent, first.id);
    await sleep(30);
    expect(await (await agent.steer(first.id, [])).result).toMatchObject({ code: "invalid_input" });
    expect(await (await agent.steer(first.id, "steered text")).result).toBe("taken_in");
    expect(await (await agent.steer(first.id, "again")).result).toMatchObject({ code: "response_not_active" }); // first is no longer live
    const { events, last } = await chain;
    expect(agent.retrieve(first.id).incomplete_details).toEqual({ reason: "steered" });
    expect(last.previous_response_id).toBe(first.id);
    expect(textOf(last)).toContain("steered text");
    expect(events.some((e) => e.type === "response.steer.accepted")).toBe(true);
    const { agent: noSteer } = await tmpAgent({ midTurnInput: false, wordDelayMs: 15 });
    const r = await noSteer.create(req("alpha beta gamma"));
    const c2 = collectChain(noSteer, r.id);
    await sleep(20);
    expect(await (await noSteer.steer(r.id, "late")).result).toMatchObject({ code: "steering_not_supported" });
    expect((await c2).events.some((e) => e.type === "response.steer.accepted")).toBe(false);
  });

  it("cancel ends the response with status cancelled; right after create, and after a steer via stream close", async () => {
    const { agent } = await tmpAgent({ wordDelayMs: 15 });
    const a = await agent.create(req("alpha beta gamma delta epsilon"));
    const ca = collectChain(agent, a.id);
    await agent.cancel(a.id);
    const ended = await ca;
    expect(ended.last.status).toBe("cancelled");
    expect(ended.events.at(-1)!.type).toBe("response.incomplete");
    const b = await agent.create(req("alpha beta gamma delta epsilon zeta eta theta"));
    const cb = collectChain(agent, b.id);
    await sleep(30);
    expect(await (await agent.steer(b.id, "more words")).result).toBe("taken_in");
    await agent.cancelIfForeground(b.id);
    expect((await cb).last.status).toBe("cancelled");
    expect(agent.state().busy).toBe(false);
  });

  it("approval: the response ends with mcp_approval_request; an mcp_approval_response goes on with the turn", async () => {
    const { agent } = await tmpAgent();
    const a = await agent.create(req("please [approve] this"));
    const { last } = await collectChain(agent, a.id);
    const ask = last.output.find((o) => o.type === "mcp_approval_request");
    expect(ask && ask.type === "mcp_approval_request" ? ask.server_label : "").toBe("ext");
    expect(last.status).toBe("completed");
    expect(agent.state().approvals).toEqual([ask!.id]);
    await expect(agent.create(req("unrelated"))).rejects.toMatchObject({ status: 409 });
    const b = await agent.create(req([{ type: "mcp_approval_response", approval_request_id: ask!.id, approve: true }], { previous_response_id: a.id }));
    expect(b.previous_response_id).toBe(a.id);
    expect(textOf((await collectChain(agent, b.id)).last)).toContain("approval yes");
    expect(agent.state().approvals).toEqual([]);
  });

  it("an engine failure ends the response failed; subagents keep the agent busy", async () => {
    const { agent } = await tmpAgent();
    const f = await agent.create(req("[fail] now"));
    const { last } = await collectChain(agent, f.id);
    expect(last.status).toBe("failed");
    expect(last.error?.message).toBe("scripted failure");
    const s = await agent.create(req("[spawn] help"));
    await collectChain(agent, s.id);
    expect(agent.state()).toMatchObject({ busy: true, subagents: 1 });
    await sleep(60);
    expect(agent.state().busy).toBe(false);
  });

  it("--model request accepts only the engine's family", async () => {
    const { agent } = await tmpAgent({ modelPolicy: "request" });
    await expect(agent.create(req("hi", { model: "claude-x" }))).rejects.toMatchObject({ code: "model_not_in_family" });
    const ok = await agent.create(req("hi", { model: "sample-1" }));
    expect(ok.model).toBe("sample-1");
    await collectChain(agent, ok.id);
  });
});

describe("turn: an engine's own tools are written as the standard item that means the same", () => {
  it("shell → shell_call(+output), file change → apply_patch_call(+output), web search → web_search_call, other → custom_tool_call(+output), MCP → mcp_call", () => {
    const turn = new Turn(new ResponseLog(), { instructions: null, model: "m", tools: [], background: false, metadata: {}, conversation: null });
    const calls = [
      { id: "c1", item: shellCall("c1", "ls"), r: { output: "a\nb", failed: false, exitCode: 0 } },
      { id: "c2", item: applyPatchCall("c2", "/x", "d"), r: { output: "ok", failed: false } },
      { id: "c3", item: webSearchCall("q"), r: { output: "", failed: false } },
      { id: "c4", item: customToolCall("c4", "Agent", { prompt: "p" }), r: { output: "done", failed: false } },
    ];
    for (const c of calls) {
      turn.toolStarted(c.id, c.item);
      turn.toolEnded(c.id, c.r.failed, toolOutput(c.item, c.id, c.r));
    }
    turn.mcpCallStarted("c5", { server: "gz", name: "message_send", arguments: {} });
    turn.mcpCallEnded("c5", "sent", null);
    expect(turn.current.response.output.map((o) => o.type)).toEqual(["shell_call", "shell_call_output", "apply_patch_call", "apply_patch_call_output", "web_search_call", "custom_tool_call", "custom_tool_call_output", "mcp_call"]);
    expect(turn.current.response.output[6]).toMatchObject({ type: "custom_tool_call_output", status: "completed" });
  });

  it("an approval and a steer at the same moment: the approval boundary wins, nothing is shown twice", async () => {
    const turn = new Turn(new ResponseLog(), { instructions: null, model: "m", tools: [], background: false, metadata: {}, conversation: null });
    turn.open();
    const first = turn.current;
    let taken = "";
    turn.steers.set("s1", (r) => (taken = r));
    void turn.requestApproval({ server: "ext", name: "send", arguments: {} });
    turn.steerTakenIn("s1");
    await new Promise((r) => setImmediate(r));
    expect(taken).toBe("taken_in");
    expect(first.response.status).toBe("completed");
    expect(first.response.output.map((o) => o.type)).toEqual(["mcp_approval_request"]);
    expect(first.nextResponseId).toBeNull();
  });
});
