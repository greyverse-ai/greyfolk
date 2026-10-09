import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { BearerAuth } from "../src/server/auth.js";
import { startServer, type AgentServer } from "../src/server/index.js";
import { sleep, tmpAgent } from "./helpers.js";

const KEY = "test-key-not-real";
let servers: AgentServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

async function boot(opts: { wordDelayMs?: number } = {}) {
  const { agent } = await tmpAgent(opts);
  const server = await startServer(agent, new BearerAuth(KEY), { kind: "tcp", host: "127.0.0.1", port: 0 });
  servers.push(server);
  return { agent, base: `http://${server.address}`, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" } };
}

const parseSse = (text: string) =>
  text
    .split("\n\n")
    .filter((b) => b.includes("data:"))
    .map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data:"))!.slice(5)) as Record<string, unknown>);

describe("HTTP controller", () => {
  it("needs the bearer key; GET /health is the standard health check", async () => {
    const { base, headers } = await boot();
    expect((await fetch(`${base}/health`)).status).toBe(401);
    const r = await fetch(`${base}/health`, { headers });
    expect(r.headers.get("content-type")).toContain("application/health+json");
    const h = (await r.json()) as { status: string; checks: Record<string, { observedValue: unknown }[]> };
    expect(h.status).toBe("pass");
    expect(h.checks["agent:busy"]![0]!.observedValue).toBe(false);
  });

  it("streams SSE, re-attaches with starting_after, serves the conversation's items", async () => {
    const { base, headers } = await boot();
    const r = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "hi there", stream: true }) });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await r.text());
    expect(events.at(-1)!.type).toBe("response.completed");
    const resp = events[0]!.response as { id: string };
    const tail = parseSse(await (await fetch(`${base}/v1/responses/${resp.id}?stream=true&starting_after=${events.length - 3}`, { headers })).text());
    expect(tail.length).toBe(2);
    const conv = ((events.at(-1)!.response as { conversation: { id: string } }).conversation).id;
    const items = (await (await fetch(`${base}/v1/conversations/${conv}/items`, { headers })).json()) as { object: string; data: { role: string }[] };
    expect(items.object).toBe("list");
    expect(items.data.map((d) => d.role)).toEqual(["user", "assistant"]);
  });

  it("non-streaming POST returns the final response; background returns at once; cancel endpoint", async () => {
    const { base, headers } = await boot({ wordDelayMs: 15 });
    const final = (await (await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "alpha beta" }) })).json()) as { status: string };
    expect(final.status).toBe("completed");
    const bg = (await (await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "alpha beta gamma delta epsilon", background: true }) })).json()) as { id: string; status: string };
    expect(bg.status).toBe("in_progress");
    const c = (await (await fetch(`${base}/v1/responses/${bg.id}/cancel`, { method: "POST", headers })).json()) as { status: string };
    expect(c.status).toBe("cancelled");
    const bad = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_image", image_url: "x" }] }] }) });
    expect(bad.status).toBe(400);
  });

  it("a client that drops a foreground SSE stream cancels the response", async () => {
    const { base, headers, agent } = await boot({ wordDelayMs: 15 });
    const ctrl = new AbortController();
    const r = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "alpha beta gamma delta epsilon zeta eta theta", stream: true }), signal: ctrl.signal });
    const reader = r.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const id = (parseSse(first)[0]!.response as { id: string }).id;
    ctrl.abort();
    await sleep(80);
    expect(agent.retrieve(id).status).toBe("cancelled");
  });
});

describe("WebSocket controller", () => {
  const connect = (base: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/v1/responses`, { headers: { authorization: `Bearer ${KEY}` } });
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });

  it("response.create then response.steer continues the turn in a successor; a late steer fails", async () => {
    const { base, agent } = await boot({ wordDelayMs: 15 });
    const ws = await connect(base);
    const events: Record<string, unknown>[] = [];
    let first = "";
    const done = new Promise<void>((resolve) =>
      ws.on("message", (raw) => {
        const ev = JSON.parse(raw.toString()) as Record<string, unknown>;
        events.push(ev);
        if (ev.type === "response.created" && !first) first = (ev.response as { id: string }).id;
        if (ev.type === "response.completed") resolve();
      }),
    );
    ws.send(JSON.stringify({ type: "response.create", input: "alpha beta gamma delta epsilon zeta" }));
    await sleep(60);
    ws.send(JSON.stringify({ type: "response.steer", previous_response_id: first, input: "more" }));
    await done;
    const types = events.map((e) => e.type);
    expect(types).toContain("response.steer.accepted");
    expect(types.filter((t) => t === "response.created").length).toBe(2);
    expect(types).toContain("response.incomplete");
    expect(agent.state().busy).toBe(false);
    const nextFailure = () =>
      new Promise<Record<string, unknown>>((resolve) =>
        ws.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>)),
      );
    let failed = nextFailure();
    ws.send(JSON.stringify({ type: "response.steer", previous_response_id: first, input: "too late" }));
    expect(await failed).toMatchObject({ type: "response.steer.failed", sequence_number: expect.any(Number), error: { type: "invalid_request_error", code: "response_not_active" }, steer: { previous_response_id: first, input: "too late" } });
    failed = nextFailure();
    ws.send(JSON.stringify({ type: "response.steer", input: "no target" }));
    expect(await failed).toMatchObject({ type: "response.steer.failed", error: { code: "invalid_input" } });
    failed = nextFailure();
    ws.send(JSON.stringify({ type: "response.steer", previous_response_id: "resp_nope", input: "x" }));
    expect(await failed).toMatchObject({ type: "response.steer.failed", error: { code: "response_not_found" } });
    ws.close();
  });

  it("closing the socket cancels a foreground response it created", async () => {
    const { base, agent } = await boot({ wordDelayMs: 15 });
    const ws = await connect(base);
    const id = await new Promise<string>((resolve) => {
      ws.on("message", (raw) => {
        const ev = JSON.parse(raw.toString()) as { type: string; response?: { id: string } };
        if (ev.type === "response.created") resolve(ev.response!.id);
      });
      ws.send(JSON.stringify({ type: "response.create", input: "alpha beta gamma delta epsilon zeta eta theta" }));
    });
    ws.close();
    await sleep(60);
    expect(agent.retrieve(id).status).toBe("cancelled");
  });
});

describe("unix socket hardening", () => {
  it("creates the socket 0600, reuses only a stale socket, refuses non-sockets and live sockets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-sock-"));
    const sock = path.join(root, "g.sock");
    const { agent } = await tmpAgent();
    const auth = new BearerAuth(KEY);
    await fs.writeFile(sock, "not a socket");
    await expect(startServer(agent, auth, { kind: "unix", path: sock })).rejects.toThrow(/not a socket/);
    await fs.unlink(sock);
    execFileSync(process.execPath, ["-e", "const s=require('node:net').createServer();s.listen(process.argv[1],()=>process.exit(0))", sock]);
    const server = await startServer(agent, auth, { kind: "unix", path: sock });
    servers.push(server);
    expect((await fs.lstat(sock)).mode & 0o777).toBe(0o600);
    const { agent: other } = await tmpAgent();
    await expect(startServer(other, auth, { kind: "unix", path: sock })).rejects.toThrow(/accepting connections/);
  });
});
