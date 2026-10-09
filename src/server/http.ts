/**
 * The HTTP surface (spec §2): `POST /v1/responses` (streaming or not), `GET /v1/responses/{id}`
 * (JSON or resumable SSE), `POST /v1/responses/{id}/cancel`, and the `greyfolk.*` extension
 * endpoints: `POST /greyfolk/export`, `POST /greyfolk/reset`,
 * `GET /greyfolk/history`, `POST /greyfolk/permissions/{id}`.
 * `GET /health` is the standard health check (the agent's state; see health.ts).
 * Every call needs the bearer key. The WebSocket upgrade on `/v1/responses` is handled in ws.ts.
 */
import * as http from "node:http";
import type { CreateParams, AgentResponse, ResponsesApi } from "../api/types.js";
import { ApiError } from "../api/errors.js";
import type { BearerAuth } from "./auth.js";
import { SseWriter, TERMINAL_EVENTS } from "./sse.js";
import { HEALTH_CONTENT_TYPE, toHealth } from "./health.js";

const MAX_BODY = 16 * 1024 * 1024;

export interface HttpHandlerOptions {
  agent: ResponsesApi;
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

function sendJson(res: http.ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": `${contentType}; charset=utf-8`, "content-length": Buffer.byteLength(data) });
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

/** Waits for the chain starting at `responseId` to reach a terminal response; resolves with that response. */
export function waitForChainEnd(agent: ResponsesApi, responseId: string): Promise<AgentResponse> {
  return new Promise((resolve) => {
    const unsub = agent.stream(responseId, -1, (ev) => {
      if (TERMINAL_EVENTS.has(ev.type)) {
        queueMicrotask(() => unsub());
        resolve((ev as { response: AgentResponse }).response);
      }
    });
  });
}

/** Streams the chain from `startingAfter` over SSE; ends the stream at the terminal event. */
function streamChain(agent: ResponsesApi, responseId: string, startingAfter: number, req: http.IncomingMessage, res: http.ServerResponse, cancelOnClose: boolean): void {
  const sse = new SseWriter(res);
  let done = false;
  const unsub = agent.stream(responseId, startingAfter, (ev) => {
    sse.send(ev);
    if (TERMINAL_EVENTS.has(ev.type)) {
      done = true;
      queueMicrotask(() => unsub());
      sse.end();
    }
  });
  req.on("close", () => {
    if (done) return;
    unsub();
    if (cancelOnClose) agent.cancelIfForeground(responseId).catch(() => {});
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
        return sendJson(res, 200, await agent.cancel(parts[2]!));
      }
    }
    if (parts.length === 1 && parts[0] === "health" && method === "GET") return sendJson(res, 200, toHealth(agent.status()), HEALTH_CONTENT_TYPE);
    if (parts[0] === "greyfolk") {
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
    const body = (await readJsonBody(req)) as CreateParams;
    const response = await agent.create(body);
    if (body.stream === true) {
      streamChain(agent, response.id, -1, req, res, true);
      return;
    }
    // A background response is returned at once; the caller polls or re-attaches (the standard).
    if (body.background === true) return sendJson(res, 200, response);
    sendJson(res, 200, await waitForChainEnd(agent, response.id));
  }

  async function getResponse(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL): Promise<void> {
    const response = agent.retrieve(id);
    if (url.searchParams.get("stream") === "true") {
      const after = Number(url.searchParams.get("starting_after") ?? "-1");
      if (!Number.isInteger(after)) throw ApiError.invalid("'starting_after' must be an integer.", null, "starting_after");
      streamChain(agent, id, after, req, res, false);
      return;
    }
    sendJson(res, 200, response);
  }
}
