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
  const base = `http://${server.address}`;
  const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  return { agent, server, base, headers };
}

function parseSse(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((b) => b.includes("data:"))
    .map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data:"))!.slice(5)));
}

describe("HTTP surface", () => {
  it("rejects calls without the bearer key", async () => {
    const { base } = await boot();
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(401);
    const r2 = await fetch(`${base}/health`, { headers: { authorization: "Bearer wrong" } });
    expect(r2.status).toBe(401);
  });

  it("POST /v1/responses streams SSE and GET re-attaches with starting_after", async () => {
    const { base, headers } = await boot();
    const r = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "hi there", stream: true }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await r.text());
    expect(events[0]!.type).toBe("response.created");
    expect(events.at(-1)!.type).toBe("response.completed");
    const id = (events[0]!.response as { id: string }).id;
    const g = await fetch(`${base}/v1/responses/${id}`, { headers });
    expect(((await g.json()) as { status: string }).status).toBe("completed");
    const re = await fetch(`${base}/v1/responses/${id}?stream=true&starting_after=${events.length - 3}`, { headers });
    const tail = parseSse(await re.text());
    expect(tail.length).toBe(2);
    expect(tail.at(-1)!.type).toBe("response.completed");
  });

  it("non-streaming POST returns the final response; a second create while busy → 409", async () => {
    const { base, headers } = await boot({ wordDelayMs: 15 });
    const p = fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "alpha beta gamma delta" }) });
    await sleep(20);
    const busy = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "x" }) });
    expect(busy.status).toBe(409);
    const body = (await (await p).json()) as { status: string; output: { type: string }[] };
    expect(body.status).toBe("completed");
  });

  it("GET /health is the standard health check format with the agent's state as checks", async () => {
    const { base, headers } = await boot();
    const r = await fetch(`${base}/health`, { headers });
    expect(r.headers.get("content-type")).toContain("application/health+json");
    const h = (await r.json()) as { status: string; serviceId: string; checks: Record<string, { observedValue: unknown; status: string }[]> };
    expect(h.status).toBe("pass");
    expect(h.serviceId).toBe("greyfolk");
    expect(h.checks["agent:state"]![0]!.observedValue).toBe("idle");
    expect(h.checks["agent:subagents"]![0]!.observedValue).toBe(0);
  });

  it("a non-streaming background request returns at once (in_progress); the caller polls", async () => {
    const { base, headers } = await boot({ wordDelayMs: 15 });
    const r = (await (await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "alpha beta gamma delta", background: true }) })).json()) as { id: string; status: string };
    expect(r.status).toBe("in_progress");
    await sleep(200);
    expect(((await (await fetch(`${base}/v1/responses/${r.id}`, { headers })).json()) as { status: string }).status).toBe("completed");
  });

  it("cancel endpoint and health/permissions/history extensions", async () => {
    const { base, headers } = await boot({ wordDelayMs: 15 });
    const r = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: "[perm] alpha beta gamma", stream: true, background: true }) });
    const reader = r.body!.getReader();
    await sleep(30);
    const checks = async () => ((await (await fetch(`${base}/health`, { headers })).json()) as { checks: Record<string, { observedValue: unknown }[]> }).checks;
    const st = await checks();
    expect(st["agent:state"]![0]!.observedValue).toBe("busy");
    const pending = st["agent:permission_requests"]![0]!.observedValue as { id: string }[];
    expect(pending).toHaveLength(1);
    const pr = await fetch(`${base}/greyfolk/permissions/${pending[0]!.id}`, { method: "POST", headers, body: JSON.stringify({ decision: "deny" }) });
    expect(pr.status).toBe(200);
    await sleep(10);
    const turn = (await checks())["agent:turn"]![0]!.observedValue as { response_id: string } | null;
    if (turn) {
      const c = await fetch(`${base}/v1/responses/${turn.response_id}/cancel`, { method: "POST", headers });
      expect(["cancelled", "completed"]).toContain(((await c.json()) as { status: string }).status);
    }
    reader.cancel().catch(() => {});
    await sleep(10);
    const h = (await (await fetch(`${base}/greyfolk/history`, { headers })).json()) as { data: unknown[] };
    expect(h.data.length).toBeGreaterThan(0);
    const bad = await fetch(`${base}/greyfolk/permissions/nope`, { method: "POST", headers, body: JSON.stringify({ decision: "allow" }) });
    expect(bad.status).toBe(404);
  });

  it("unsupported input → 400 invalid_request_error", async () => {
    const { base, headers } = await boot();
    const r = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ input: [{ role: "user", content: [{ type: "input_image", image_url: "x" }] }] }) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: { type: string } }).error.type).toBe("invalid_request_error");
  });
});

describe("WebSocket surface", () => {
  function connect(base: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/v1/responses`, { headers: { authorization: `Bearer ${KEY}` } });
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  it("refuses the upgrade without the key", async () => {
    const { base } = await boot();
    await expect(connect(base.replace("http", "http")).then(() => "ok")).resolves.toBe("ok");
    const bad = new WebSocket(`${base.replace("http", "ws")}/v1/responses`);
    await new Promise<void>((resolve) => bad.once("error", () => resolve()));
  });

  it("response.create then response.steer continues the turn in a successor", async () => {
    const { base, agent } = await boot({ wordDelayMs: 15 });
    const ws = await connect(base);
    const events: Record<string, unknown>[] = [];
    const done = new Promise<void>((resolve) => {
      ws.on("message", (raw) => {
        const ev = JSON.parse(raw.toString()) as Record<string, unknown>;
        events.push(ev);
        if (ev.type === "response.completed") resolve();
      });
    });
    ws.send(JSON.stringify({ type: "response.create", input: "alpha beta gamma delta epsilon zeta" }));
    await sleep(60);
    ws.send(JSON.stringify({ type: "response.steer", input: "more" }));
    await done;
    const types = events.map((e) => e.type);
    expect(types).toContain("response.steer.accepted");
    expect(types).toContain("greyfolk.steer_taken_in");
    expect(types.filter((t) => t === "response.created").length).toBe(2);
    expect(types).toContain("response.incomplete");
    expect(agent.status().state).toBe("idle");
    ws.send(JSON.stringify({ type: "response.steer", input: "too late" }));
    const failed = await new Promise<Record<string, unknown>>((resolve) => ws.on("message", (raw) => {
      const ev = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (ev.type === "response.steer.failed") resolve(ev);
    }));
    expect((failed.error as { code: string }).code).toBe("response_not_active");
    ws.close();
  });

  it("closing the socket cancels a foreground response it created", async () => {
    const { base, agent } = await boot({ wordDelayMs: 15 });
    const ws = await connect(base);
    const first = new Promise<string>((resolve) => {
      ws.on("message", (raw) => {
        const ev = JSON.parse(raw.toString()) as { type: string; response?: { id: string } };
        if (ev.type === "response.created") resolve(ev.response!.id);
      });
    });
    ws.send(JSON.stringify({ type: "response.create", input: "alpha beta gamma delta epsilon zeta eta theta" }));
    const id = await first;
    ws.close();
    await sleep(60);
    expect(agent.retrieve(id).status).toBe("cancelled");
    expect(agent.status().state).toBe("idle");
  });
});

describe("unix socket hardening", () => {
  it("creates the socket 0600, reuses only a stale socket, refuses non-sockets and live sockets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-sock-"));
    const sock = path.join(root, "g.sock");
    const { agent } = await tmpAgent();
    const auth = new BearerAuth(KEY);
    // A regular file in the way is never removed.
    await fs.writeFile(sock, "not a socket");
    await expect(startServer(agent, auth, { kind: "unix", path: sock })).rejects.toThrow(/not a socket/);
    expect(await fs.readFile(sock, "utf8")).toBe("not a socket");
    await fs.unlink(sock);
    // A stale socket left by a dead process is replaced.
    execFileSync(process.execPath, ["-e", "const s=require('node:net').createServer();s.listen(process.argv[1],()=>process.exit(0))", sock]);
    expect((await fs.lstat(sock)).isSocket()).toBe(true);
    const server = await startServer(agent, auth, { kind: "unix", path: sock });
    servers.push(server);
    const st = await fs.lstat(sock);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    // A live socket is never taken over.
    const { agent: other } = await tmpAgent();
    await expect(startServer(other, auth, { kind: "unix", path: sock })).rejects.toThrow(/accepting connections/);
    expect((await fs.lstat(sock)).isSocket()).toBe(true);
  });

  it("honours a starter-dictated socket mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-sock-"));
    const sock = path.join(root, "g.sock");
    const { agent } = await tmpAgent();
    const server = await startServer(agent, new BearerAuth(KEY), { kind: "unix", path: sock, mode: 0o660 });
    servers.push(server);
    expect((await fs.lstat(sock)).mode & 0o777).toBe(0o660);
  });
});
