import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ApiError } from "../src/api/errors.js";
import { collectChain, req, sleep, textOf, tmpAgent } from "./helpers.js";

describe("service (Responses API)", () => {
  it("runs one turn and streams Responses events", async () => {
    const { agent } = await tmpAgent();
    const r = await agent.create(req("hello world"));
    expect(r.status).toBe("in_progress");
    const { events, last } = await collectChain(agent, r.id);
    expect(events[0]!.type).toBe("response.created");
    expect(events.at(-1)!.type).toBe("response.completed");
    expect(last.id).toBe(r.id);
    expect(textOf(last)).toBe("echo: hello world");
    expect(last.usage?.total_tokens).toBeGreaterThan(0);
    expect(agent.status().state).toBe("idle");
    expect(agent.status().engine).toBe("fake");
  });

  it("refuses a second turn while one runs (one turn at a time)", async () => {
    const { agent } = await tmpAgent();
    const r = await agent.create(req("first turn here"));
    await expect(agent.create(req("second"))).rejects.toMatchObject({ status: 409, code: "turn_in_progress" });
    await collectChain(agent, r.id);
    const next = await agent.create(req("second"));
    await collectChain(agent, next.id);
  });

  it("refuses previous_response_id that is not the latest turn", async () => {
    const { agent } = await tmpAgent();
    const a = await agent.create(req("a"));
    await collectChain(agent, a.id);
    const b = await agent.create(req("b"));
    await collectChain(agent, b.id);
    await expect(agent.create(req("c", { previous_response_id: a.id }))).rejects.toMatchObject({ status: 400, code: "previous_response_not_latest" });
    const c = await agent.create(req("c", { previous_response_id: b.id }));
    await collectChain(agent, c.id);
  });

  it("picks new input by position: a resent history feeds only what follows its last assistant message", async () => {
    const { agent, engine } = await tmpAgent();
    const a = await agent.create(req([{ role: "user", content: "one" }]));
    await collectChain(agent, a.id);
    const b = await agent.create(req([{ role: "user", content: "one" }, { role: "assistant", content: "echo: one" }, { role: "user", content: "two" }]));
    await collectChain(agent, b.id);
    expect(engine().turns[1]!.input).toEqual([{ type: "message", role: "user", content: "two" }]);
    await expect(agent.create(req([{ role: "user", content: "one" }, { role: "assistant", content: "echo: one" }]))).rejects.toMatchObject({ status: 400, code: "no_new_input" });
  });

  it("the same text sent twice is fed twice (no content dedup)", async () => {
    const { agent, engine } = await tmpAgent();
    const a = await agent.create(req("yes"));
    await collectChain(agent, a.id);
    const b = await agent.create(req("yes", { previous_response_id: a.id }));
    await collectChain(agent, b.id);
    const c = await agent.create(req("yes"));
    await collectChain(agent, c.id);
    expect(engine().turns.map((t) => t.input.map((i) => i.content))).toEqual([["yes"], ["yes"], ["yes"]]);
  });

  it("refuses input the engine cannot take", async () => {
    const { agent } = await tmpAgent();
    await expect(agent.create(req([{ role: "user", content: [{ type: "input_audio", data: "x" }] }]))).rejects.toMatchObject({ status: 400, type: "invalid_request_error", code: "unsupported_input" });
  });

  it("never echoes a tool's credentials (headers) in the response, the stream or retrieve", async () => {
    const { agent } = await tmpAgent();
    const tools = [{ type: "mcp", server_label: "gz", server_url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer turn-secret" }, require_approval: "never" }];
    const r = await agent.create(req("hi", { tools }));
    const { events } = await collectChain(agent, r.id);
    const everything = JSON.stringify([r, events, agent.retrieve(r.id)]);
    expect(everything).not.toContain("turn-secret");
    expect(agent.retrieve(r.id).tools[0]).toMatchObject({ type: "mcp", server_label: "gz", headers: null });
  });

  it("steer: ends the running response incomplete(steered) and continues in a successor", async () => {
    const { agent, engine } = await tmpAgent({ wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta epsilon zeta"));
    const chain = collectChain(agent, first.id);
    await sleep(30);
    const { result, steerId } = await agent.steer(first.id, "steered text");
    expect(await result).toBe("taken_in");
    const { events, last } = await chain;
    const types = events.map((e) => e.type);
    const takenIdx = types.indexOf("greyfolk.steer_taken_in");
    expect(takenIdx).toBeGreaterThan(0);
    expect(types[takenIdx + 1]).toBe("response.incomplete");
    expect(types[takenIdx + 2]).toBe("response.created");
    const prev = agent.retrieve(first.id);
    expect(prev.status).toBe("incomplete");
    expect(prev.incomplete_details).toEqual({ reason: "steered" });
    expect(last.previous_response_id).toBe(first.id);
    expect(last.status).toBe("completed");
    expect(engine().steeredInputs).toEqual([{ type: "message", role: "user", content: "steered text" }]);
    const accepted = events.find((e) => e.type === "response.steer.accepted") as { steer: { id: string } };
    expect(accepted.steer.id).toBe(steerId);
    expect(agent.status().state).toBe("idle");
  });

  it("steer after the turn ended → response_ended", async () => {
    const { agent } = await tmpAgent();
    const first = await agent.create(req("short"));
    await collectChain(agent, first.id);
    const { result, liveResponseId } = await agent.steer(first.id, "late");
    expect(await result).toBe("response_ended");
    expect(liveResponseId).toBeNull();
  });

  it("steer on an engine without mid-turn input → response_ended and a steer.failed event", async () => {
    const { agent } = await tmpAgent({ midTurnInput: false, wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta"));
    const chain = collectChain(agent, first.id);
    await sleep(20);
    const { result } = await agent.steer(first.id, "late");
    expect(await result).toBe("response_ended");
    const { events, last } = await chain;
    const failed = events.find((e) => e.type === "response.steer.failed") as { steer: { input: unknown }; error: { code: string } };
    expect(failed.error.code).toBe("response_not_active");
    expect(failed.steer.input).toBe("late");
    expect(last.id).toBe(first.id);
    expect(last.status).toBe("completed");
  });

  it("cancel stops the response and marks it cancelled", async () => {
    const { agent } = await tmpAgent({ wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta epsilon zeta eta"));
    const chain = collectChain(agent, first.id);
    await sleep(30);
    expect((await agent.cancel(first.id)).status).toBe("cancelled");
    const { events } = await chain;
    expect(events.at(-1)!.type).toBe("response.cancelled");
    expect(agent.status().state).toBe("idle");
    const next = await agent.create(req("again"));
    await collectChain(agent, next.id);
  });

  it("cancelIfForeground skips background responses", async () => {
    const { agent } = await tmpAgent({ wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma", { background: true }));
    const chain = collectChain(agent, first.id);
    await agent.cancelIfForeground(first.id);
    expect((await chain).last.status).toBe("completed");
  });

  it("permission request pauses the turn until decided", async () => {
    const { agent } = await tmpAgent();
    const first = await agent.create(req("[perm] go"));
    const seen: { id: string; tool: string }[] = [];
    const unsub = agent.stream(first.id, -1, (ev) => {
      if (ev.type === "greyfolk.permission_request") seen.push(ev as never);
    });
    const chain = collectChain(agent, first.id);
    await sleep(20);
    const status = agent.status();
    expect(status.state).toBe("busy");
    expect(status.permission_requests).toHaveLength(1);
    expect(seen[0]!.id).toBe(status.permission_requests[0]!.id);
    expect(seen[0]!.tool).toBe("Bash");
    agent.decidePermission(seen[0]!.id, "allow");
    expect(textOf((await chain).last)).toContain("permission allow");
    expect(() => agent.decidePermission(seen[0]!.id, "deny")).toThrow(ApiError);
    unsub();
  });

  it("cancel denies a waiting permission request", async () => {
    const { agent } = await tmpAgent();
    const first = await agent.create(req("[perm] go"));
    const chain = collectChain(agent, first.id);
    await sleep(20);
    await agent.cancel(first.id);
    expect((await chain).last.status).toBe("cancelled");
    expect(agent.status().permission_requests).toHaveLength(0);
  });

  it("tool calls appear as mcp_call output items", async () => {
    const { agent } = await tmpAgent();
    const first = await agent.create(req("[tool] run"));
    const { events, last } = await collectChain(agent, first.id);
    const call = last.output.find((o) => o.type === "mcp_call");
    expect(call && call.type === "mcp_call" ? call.status : "").toBe("completed");
    expect(events.some((e) => e.type === "response.mcp_call.completed")).toBe(true);
  });

  it("an engine failure ends the response failed", async () => {
    const { agent } = await tmpAgent();
    const first = await agent.create(req("[fail] now"));
    const { last } = await collectChain(agent, first.id);
    expect(last.status).toBe("failed");
    expect(last.error?.code).toBe("engine_error");
  });

  it("a cut-off response is reported failed on restart; the session resumes", async () => {
    const { agent, agentDir, root } = await tmpAgent();
    const first = await agent.create(req("hi"));
    await collectChain(agent, first.id);
    const sid = agent.status().session_id;
    await fs.writeFile(path.join(agentDir, ".greyfolk", "inflight"), "resp_cut\n");
    const { agent: again } = await tmpAgent({ agentDir, root });
    expect(again.retrieve("resp_cut").status).toBe("failed");
    expect(again.status().session_id).toBe(sid);
    expect((await again.history()).length).toBeGreaterThan(0);
  });

  it("export and reset require idle; reset archives the session outside the folder", async () => {
    const { agent, agentDir, root } = await tmpAgent({ wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta"));
    const chain = collectChain(agent, first.id);
    await expect(agent.export(path.join(root, "copy"))).rejects.toMatchObject({ status: 409, code: "not_idle" });
    await expect(agent.reset()).rejects.toMatchObject({ status: 409, code: "not_idle" });
    await chain;
    const oldSid = agent.status().session_id!;
    const exp = await agent.export(path.join(root, "copy"));
    expect((await fs.readdir(path.join(exp.dest, "fake-session"))).length).toBe(1);
    const { archived_to } = await agent.reset();
    expect(archived_to.startsWith(path.join(root, "archive"))).toBe(true);
    await expect(fs.access(path.join(agentDir, "fake-session", `${oldSid}.jsonl`))).rejects.toBeTruthy();
    expect(agent.status().session_id).toBeNull();
    const next = await agent.create(req("hi"));
    await collectChain(agent, next.id);
    expect(agent.status().session_id).not.toBe(oldSid);
  });
});

describe("lifecycle fixes", () => {
  it("closing the creating stream after a steer still cancels the turn (its live successor)", async () => {
    const { agent } = await tmpAgent({ wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta epsilon zeta eta theta"));
    const chain = collectChain(agent, first.id);
    await sleep(30);
    expect(await (await agent.steer(first.id, "more words here please")).result).toBe("taken_in");
    await agent.cancelIfForeground(first.id);
    expect((await chain).last.status).toBe("cancelled");
  });

  it("a cancel right after create is never lost", async () => {
    const { agent } = await tmpAgent({ wordDelayMs: 15 });
    const r = await agent.create(req("alpha beta gamma delta"));
    const chain = collectChain(agent, r.id);
    await agent.cancel(r.id);
    expect((await chain).last.status).toBe("cancelled");
  });

  it("steer: empty input is refused; only the live response of the turn takes a steer", async () => {
    const { agent } = await tmpAgent({ wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta epsilon zeta eta theta"));
    const chain = collectChain(agent, first.id);
    await sleep(30);
    await expect(agent.steer(first.id, [])).rejects.toMatchObject({ status: 400 });
    expect(await (await agent.steer(first.id, "x y z")).result).toBe("taken_in");
    expect(await (await agent.steer(first.id, "again")).result).toBe("response_ended"); // first is no longer the live response
    await chain;
  });

  it("previous_response_id keeps working across a restart (the newest response is recorded)", async () => {
    const { agent, agentDir, root } = await tmpAgent();
    const a = await agent.create(req("one"));
    await collectChain(agent, a.id);
    await agent.close();
    const { agent: again } = await tmpAgent({ agentDir, root });
    const b = await again.create(req("two", { previous_response_id: a.id }));
    await collectChain(again, b.id);
    await expect(again.create(req("three", { previous_response_id: a.id }))).rejects.toMatchObject({ code: "previous_response_not_latest" });
  });

  it("refuses MCP fields it cannot apply instead of dropping them; honours allowed_tools", async () => {
    const { agent } = await tmpAgent();
    const tool = { type: "mcp", server_label: "gz", server_url: "http://127.0.0.1:9/mcp", require_approval: "never" };
    await expect(agent.create(req("hi", { tools: [{ ...tool, authorization: "tok" }] }))).rejects.toMatchObject({ status: 400, code: "unsupported_tool", param: "tools[0].authorization" });
    await expect(agent.create(req("hi", { tools: [{ ...tool, allowed_tools: { read_only: true } }] }))).rejects.toMatchObject({ status: 400, param: "tools[0].allowed_tools" });
    await expect(agent.create(req("hi", { tools: [{ ...tool, require_approval: { never: { tool_names: ["x"] } } }] }))).rejects.toMatchObject({ status: 400 });
    const ok = await agent.create(req("hi", { tools: [{ ...tool, allowed_tools: ["file_read"] }] }));
    await collectChain(agent, ok.id);
  });
});

describe("native subagents (spec §5)", () => {
  it("keep the agent busy until they finish, with no event of greyfolk's own", async () => {
    const { agent } = await tmpAgent();
    const r = await agent.create(req("please [spawn] a helper"));
    const { events } = await collectChain(agent, r.id);
    expect(events.some((e) => e.type.startsWith("greyfolk.subagent") || e.type.startsWith("greyfolk.held"))).toBe(false);
    expect(agent.status().state).toBe("busy");
    expect(agent.status().subagents.running).toBe(1);
    await sleep(80);
    expect(agent.status().state).toBe("idle");
  });
});

describe("model policy", () => {
  it("--model request accepts only the engine's family, else 400", async () => {
    const { agent } = await tmpAgent({ modelPolicy: "request" });
    await expect(agent.create(req("hi", { model: "claude-sonnet-5-5" }))).rejects.toMatchObject({ status: 400, code: "model_not_in_family", param: "model" });
    const ok = await agent.create(req("hi", { model: "fake-1" }));
    expect(ok.model).toBe("fake-1");
    await collectChain(agent, ok.id);
    await agent.close();
  });
});
