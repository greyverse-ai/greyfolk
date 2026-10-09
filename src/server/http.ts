/**
 * The HTTP surface (spec §2): `POST /v1/responses` (streaming or not), `GET /v1/responses/{id}`
 * (JSON or resumable SSE), `POST /v1/responses/{id}/cancel`, and the `greyfolk.*` extension
 * endpoints: `GET /greyfolk/status`, `POST /greyfolk/export`, `POST /greyfolk/reset`,
 * `GET /greyfolk/history`, `POST /greyfolk/permissions/{id}`.
 * Every call needs the bearer key. The WebSocket upgrade on `/v1/responses` is handled in ws.ts.
 */
import * as http from "node:http";
import type { Agent } from "../profile/engine.js";
import { ApiError } from "../profile/errors.js";
import { parseCreateRequest } from "../profile/input.js";
import type { ResponseRecord } from "../profile/responses.js";
import type { BearerAuth } from "./auth.js";
import { SseWriter, TERMINAL_EVENTS } from "./sse.js";

const MAX_BODY = 16 * 1024 * 1024;

export interface HttpHandlerOptions {
  agent: Agent;
  auth: BearerAuth;
}

export function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(ApiError.invalid("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(ApiError.invalid("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  const e = ApiError.from(err);
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, e.status, e.toBody());
}

/** Waits for the chain starting at `record` to reach a terminal response; resolves with that response. */
export function waitForChainEnd(agent: Agent, record: ResponseRecord): Promise<ResponseRecord> {
  return new Promise((resolve) => {
    const unsub = agent.subscribeChain(record.id, -1, (rec, ev) => {
      if (TERMINAL_EVENTS.has(ev.type)) {
        queueMicrotask(unsub);
        resolve(rec);
      }
    });
  });
}

/** Streams the chain from `startingAfter` over SSE; ends the stream at the terminal event. */
function streamChain(agent: Agent, record: ResponseRecord, startingAfter: number, req: http.IncomingMessage, res: http.ServerResponse, cancelOnClose: boolean): void {
  const sse = new SseWriter(res);
  let done = false;
  const unsub = agent.subscribeChain(record.id, startingAfter, (_rec, ev) => {
    sse.send(ev);
    if (TERMINAL_EVENTS.has(ev.type)) {
      done = true;
      queueMicrotask(unsub);
      sse.end();
    }
  });
  req.on("close", () => {
    if (done) return;
    unsub();
    if (cancelOnClose) agent.cancelIfForeground(record.id).catch(() => {});
  });
}

export function createRequestHandler(opts: HttpHandlerOptions): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const { agent, auth } = opts;
  return (req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!auth.check(req.headers.authorization)) throw ApiError.unauthorized();
    const url = new URL(req.url ?? "/", "http://greyfolk");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts[0] === "v1" && parts[1] === "responses") {
      if (parts.length === 2 && method === "POST") return createResponse(req, res);
      if (parts.length === 3 && method === "GET") return getResponse(req, res, parts[2]!, url);
      if (parts.length === 4 && parts[3] === "cancel" && method === "POST") {
        const rec = await agent.cancel(parts[2]!);
        return sendJson(res, 200, rec.response);
      }
    }
    if (parts[0] === "greyfolk") {
      if (parts[1] === "status" && method === "GET") return sendJson(res, 200, agent.status());
      if (parts[1] === "history" && method === "GET") return sendJson(res, 200, { object: "list", data: await agent.history() });
      if (parts[1] === "export" && method === "POST") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        if (typeof body.dest !== "string" || !body.dest) throw ApiError.invalid("'dest' (a path outside the agent folder) is required.", null, "dest");
        return sendJson(res, 200, await agent.export(body.dest));
      }
      if (parts[1] === "reset" && method === "POST") {
        await readJsonBody(req);
        return sendJson(res, 200, await agent.reset());
      }
      if (parts[1] === "permissions" && parts.length === 3 && method === "POST") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        if (body.decision !== "allow" && body.decision !== "deny") throw ApiError.invalid("'decision' must be 'allow' or 'deny'.", null, "decision");
        return sendJson(res, 200, agent.decidePermission(parts[2]!, body.decision));
      }
    }
    throw ApiError.notFound(`No route for ${method} ${url.pathname}.`);
  }

  async function createResponse(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = parseCreateRequest(await readJsonBody(req));
    const record = await agent.create(body);
    if (body.stream) {
      streamChain(agent, record, -1, req, res, true);
      return;
    }
    const final = await waitForChainEnd(agent, record);
    sendJson(res, 200, final.response);
  }

  async function getResponse(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL): Promise<void> {
    const rec = agent.responses.get(id);
    if (!rec) throw ApiError.notFound(`Response '${id}' not found.`, "response_id");
    if (url.searchParams.get("stream") === "true") {
      const after = Number(url.searchParams.get("starting_after") ?? "-1");
      if (!Number.isInteger(after)) throw ApiError.invalid("'starting_after' must be an integer.", null, "starting_after");
      streamChain(agent, rec, after, req, res, false);
      return;
    }
    sendJson(res, 200, rec.response);
  }
}
