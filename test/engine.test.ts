import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiError } from "../src/profile/errors.js";
import { collectChain, req, sleep, tmpAgent } from "./helpers.js";
import { Agent } from "../src/profile/engine.js";
import { FakeHarness } from "../src/harness/fake.js";
import { SessionStore } from "../src/session/store.js";

describe("profile engine", () => {
  it("runs one turn and streams Responses events", async () => {
    const { agent } = await tmpAgent();
    const rec = await agent.create(req("hello world"));
    expect(rec.response.status).toBe("in_progress");
    const { events, last } = await collectChain(agent, rec.id);
    expect(events[0]!.type).toBe("response.created");
    expect(events.at(-1)!.type).toBe("response.completed");
    expect(last.id).toBe(rec.id);
    const msg = last.response.output.find((o) => o.type === "message");
    expect(msg && msg.type === "message" ? msg.content[0]!.text : "").toBe("echo: hello world");
    expect(last.response.usage?.total_tokens).toBeGreaterThan(0);
    expect(agent.status().state).toBe("idle");
  });

  it("refuses a second turn while one runs (one turn at a time)", async () => {
    const { agent } = await tmpAgent();
    const rec = await agent.create(req("first turn here"));
    await expect(agent.create(req("second"))).rejects.toMatchObject({ status: 409, code: "turn_in_progress" });
    await collectChain(agent, rec.id);
    const next = await agent.create(req("second"));
    expect(next.id).not.toBe(rec.id);
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

  it("feeds only the input items the session does not already hold", async () => {
    const { agent, harness } = await tmpAgent();
    const a = await agent.create(req([{ role: "user", content: "one" }]));
    await collectChain(agent, a.id);
    const b = await agent.create(req([{ role: "user", content: "one" }, { role: "assistant", content: "echo: one" }, { role: "user", content: "two" }]));
    await collectChain(agent, b.id);
    expect(harness().turns[1]!.input).toEqual([{ role: "user", text: "two" }]);
    await expect(agent.create(req([{ role: "user", content: "one" }]))).rejects.toMatchObject({ status: 400, code: "no_new_input" });
  });

  it("refuses input the harness cannot take", async () => {
    const { agent } = await tmpAgent();
    await expect(agent.create(req([{ role: "user", content: [{ type: "input_audio", data: "x" }] }]))).rejects.toMatchObject({ status: 400, type: "invalid_request_error", code: "unsupported_input" });
  });

  it("steer: ends the running response incomplete(steered) and continues in a successor", async () => {
    const { agent, harness } = await tmpAgent({ wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta epsilon zeta"));
    const chain = collectChain(agent, first.id);
    await sleep(30);
    const { result, steerId } = await agent.steer(first.id, "steered text");
    expect(await result).toBe("taken_in");
    const { events, last } = await chain;
    const types = events.map((e) => e.type);
    const takenIdx = types.indexOf("response.steer.taken_in");
    expect(takenIdx).toBeGreaterThan(0);
    expect(types[takenIdx + 1]).toBe("response.incomplete");
    expect(types[takenIdx + 2]).toBe("response.created");
    expect(first.response.status).toBe("incomplete");
    expect(first.response.incomplete_details).toEqual({ reason: "steered" });
    expect(first.nextResponseId).toBe(last.id);
    expect(last.response.previous_response_id).toBe(first.id);
    expect(last.response.status).toBe("completed");
    expect(last.turnId).toBe(first.turnId);
    expect(harness().steeredInputs).toEqual([{ role: "user", text: "steered text" }]);
    const accepted = events.find((e) => e.type === "response.steer.accepted") as { steer: { id: string } };
    expect(accepted.steer.id).toBe(steerId);
    expect(agent.status().state).toBe("idle");
  });

  it("steer after the turn ended → response_ended", async () => {
    const { agent } = await tmpAgent();
    const first = await agent.create(req("short"));
    await collectChain(agent, first.id);
    const { result } = await agent.steer(first.id, "late");
    expect(await result).toBe("response_ended");
  });

  it("steer on a harness without mid-turn input → response_ended and a steer.failed event", async () => {
    const { agent } = await tmpAgent({ midTurnInput: false, wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta"));
    const chain = collectChain(agent, first.id);
    await sleep(20);
    const { result } = await agent.steer(first.id, "late");
    expect(await result).toBe("response_ended");
    const { events, last } = await chain;
    expect(events.some((e) => e.type === "response.steer.failed")).toBe(true);
    expect(last.id).toBe(first.id);
    expect(last.response.status).toBe("completed");
  });

  it("cancel stops the response and marks it cancelled", async () => {
    const { agent } = await tmpAgent({ wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta epsilon zeta eta"));
    const chain = collectChain(agent, first.id);
    await sleep(30);
    const rec = await agent.cancel(first.id);
    expect(rec.response.status).toBe("cancelled");
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
    const { last } = await chain;
    expect(last.response.status).toBe("completed");
  });

  it("permission request pauses the turn until decided", async () => {
    const { agent } = await tmpAgent();
    const first = await agent.create(req("[perm] go"));
    const chain = collectChain(agent, first.id);
    await sleep(20);
    const status = agent.status();
    expect(status.state).toBe("busy");
    const pending = status.permission_requests as { id: string; response_id: string }[];
    expect(pending).toHaveLength(1);
    const permEv = first.events.find((e) => e.type === "greyfolk.permission_request") as { id: string; tool: string };
    expect(permEv.id).toBe(pending[0]!.id);
    expect(permEv.tool).toBe("Bash");
    agent.decidePermission(permEv.id, "allow");
    const { last } = await chain;
    const msg = last.response.output.find((o) => o.type === "message");
    expect(msg && msg.type === "message" ? msg.content[0]!.text : "").toContain("permission allow");
    expect(() => agent.decidePermission(permEv.id, "deny")).toThrow(ApiError);
  });

  it("cancel denies a waiting permission request", async () => {
    const { agent } = await tmpAgent();
    const first = await agent.create(req("[perm] go"));
    const chain = collectChain(agent, first.id);
    await sleep(20);
    await agent.cancel(first.id);
    const { last } = await chain;
    expect(last.response.status).toBe("cancelled");
    expect((agent.status().permission_requests as unknown[]).length).toBe(0);
  });

  it("tool calls appear as mcp_call output items", async () => {
    const { agent } = await tmpAgent();
    const first = await agent.create(req("[tool] run"));
    const { events, last } = await collectChain(agent, first.id);
    const call = last.response.output.find((o) => o.type === "mcp_call");
    expect(call && call.type === "mcp_call" ? call.status : "").toBe("completed");
    expect(events.some((e) => e.type === "response.mcp_call.completed")).toBe(true);
  });

  it("a harness failure ends the response failed", async () => {
    const { agent } = await tmpAgent();
    const first = await agent.create(req("[fail] now"));
    const { last } = await collectChain(agent, first.id);
    expect(last.response.status).toBe("failed");
    expect(last.response.error?.code).toBe("harness_error");
  });

  it("a cut-off response is reported failed on restart; the session resumes", async () => {
    const { agent, agentDir, root } = await tmpAgent();
    const first = await agent.create(req("hi"));
    await collectChain(agent, first.id);
    const sid = agent.status().session_id as string;
    await fs.writeFile(path.join(agentDir, ".greyfolk", "inflight"), "resp_cut\n");
    const { Agent } = await import("../src/profile/engine.js");
    const { FakeHarness } = await import("../src/harness/fake.js");
    const { SessionStore } = await import("../src/session/store.js");
    const again = new Agent({ harnessFactory: (s) => new FakeHarness({ agentDir, sessionId: s }), store: new SessionStore(agentDir), modelPolicy: "fixed", resetArchiveDir: path.join(root, "archive") });
    await again.init();
    expect(again.responses.get("resp_cut")?.response.status).toBe("failed");
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
    const oldSid = agent.status().session_id as string;
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

describe("held subagent results (spec §5)", () => {
  it("holds a late subagent result under the first response id of its turn and lists it in status", async () => {
    const { agent } = await tmpAgent();
    const rec = await agent.create(req("please [spawn] a helper"));
    const { events } = await collectChain(agent, rec.id);
    expect(events.some((e) => e.type === "greyfolk.subagent_started")).toBe(true);
    // The subagent is still running: the instance stays busy and nothing is held yet.
    expect(agent.status().state).toBe("busy");
    expect(agent.status().held).toEqual([]);
    await sleep(80);
    expect(agent.status().state).toBe("idle");
    expect(agent.status().held).toEqual([{ turn: rec.id, count: 1 }]);
  });

  it("never carries held results into a response that does not name them", async () => {
    const { agent, harness } = await tmpAgent();
    const a = await agent.create(req("[spawn] one"));
    await collectChain(agent, a.id);
    await sleep(80);
    const b = await agent.create(req("unrelated"));
    const { events } = await collectChain(agent, b.id);
    expect(harness().turns[1]!.input).toEqual([{ role: "user", text: "unrelated" }]);
    expect(events.some((e) => e.type === "greyfolk.held_delivered")).toBe(false);
    expect(agent.status().held).toEqual([{ turn: a.id, count: 1 }]);
  });

  it("delivers held results only when the request names their turns (greyfolk.deliver_held)", async () => {
    const { agent, harness } = await tmpAgent();
    const a = await agent.create(req("[spawn] one"));
    await collectChain(agent, a.id);
    await sleep(80);
    const b = await agent.create(req("now use it", { deliver_held: [a.id] }));
    const { events } = await collectChain(agent, b.id);
    const delivered = events.find((e) => e.type === "greyfolk.held_delivered") as { turns: { turn: string; results: { id: string; status: string; output: string }[] }[] };
    expect(delivered.turns).toHaveLength(1);
    expect(delivered.turns[0]!.turn).toBe(a.id);
    expect(delivered.turns[0]!.results[0]!.status).toBe("completed");
    const fed = harness().turns[1]!.input;
    expect(fed).toHaveLength(2);
    expect(fed[0]!.role).toBe("developer");
    expect(fed[0]!.text).toContain(`turn=${a.id}`);
    expect(fed[0]!.text).toContain(delivered.turns[0]!.results[0]!.output);
    expect(fed[1]).toEqual({ role: "user", text: "now use it" });
    expect(agent.status().held).toEqual([]);
    // Delivered once: naming the turn again is an error.
    await expect(agent.create(req("again", { deliver_held: [a.id] }))).rejects.toMatchObject({ status: 400, code: "unknown_held_turn" });
  });

  it("refuses unknown turn ids and accepts a request whose only new input is the held results", async () => {
    const { agent, harness } = await tmpAgent();
    await expect(agent.create(req("x", { deliver_held: ["resp_nope"] }))).rejects.toMatchObject({ status: 400, code: "unknown_held_turn" });
    const a = await agent.create(req("[spawn] two"));
    await collectChain(agent, a.id);
    await sleep(80);
    // Resending only the known history plus deliver_held feeds just the held results.
    const b = await agent.create(req([{ role: "user", content: "[spawn] two" }], { deliver_held: [a.id] }));
    await collectChain(agent, b.id);
    expect(harness().turns[1]!.input.map((i) => i.role)).toEqual(["developer"]);
  });

  it("keeps held results across a restart of the instance", async () => {
    const { agent, agentDir, root } = await tmpAgent();
    const a = await agent.create(req("[spawn] persist"));
    await collectChain(agent, a.id);
    await sleep(80);
    await agent.close();
    const again = new Agent({
      harnessFactory: (sessionId) => new FakeHarness({ agentDir, sessionId }),
      store: new SessionStore(agentDir),
      modelPolicy: "fixed",
      resetArchiveDir: path.join(root, "archive"),
    });
    await again.init();
    expect(again.status().held).toEqual([{ turn: a.id, count: 1 }]);
    const b = await again.create(req("go", { deliver_held: [a.id] }));
    await collectChain(again, b.id);
    expect(again.status().held).toEqual([]);
    expect(await fs.readFile(path.join(agentDir, ".greyfolk", "held"), "utf8").catch(() => "gone")).toBe("gone");
  });

  it("keys the held result by the first response of a steered turn, not the successor", async () => {
    const { agent } = await tmpAgent({ wordDelayMs: 15 });
    const first = await agent.create(req("alpha beta gamma delta epsilon zeta"));
    const chain = collectChain(agent, first.id);
    await sleep(30);
    const { result } = await agent.steer(first.id, "[spawn] later");
    expect(await result).toBe("taken_in");
    const { last } = await chain;
    expect(last.id).not.toBe(first.id);
    await sleep(80);
    expect(agent.status().held).toEqual([{ turn: first.id, count: 1 }]);
  });
});

describe("model policy", () => {
  it("--model request accepts only the harness's family, else 400", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-model-"));
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir);
    const agent = new Agent({ harnessFactory: (s) => new FakeHarness({ agentDir, sessionId: s }), store: new SessionStore(agentDir), modelPolicy: "request", resetArchiveDir: path.join(root, "archive") });
    await agent.init();
    await expect(agent.create(req("hi", { model: "claude-sonnet-5-5" }))).rejects.toMatchObject({ status: 400, code: "model_not_in_family", param: "model" });
    const ok = await agent.create(req("hi", { model: "fake-1" }));
    expect(ok.response.model).toBe("fake-1");
    await collectChain(agent, ok.id);
    await agent.close();
  });
});
