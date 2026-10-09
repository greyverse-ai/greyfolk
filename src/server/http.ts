/**
 * The HTTP controller: `POST /v1/responses` (streaming or not), `GET /v1/responses/{id}` (JSON or
 * resumable SSE), `POST /v1/responses/{id}/cancel`, `GET /v1/conversations/{id}/items`, and the
 * standard health check `GET /health`. Every call needs the bearer key. The WebSocket mode on
 * `/v1/responses` is in ws.ts.
 */
import * as http from "node:http";
import type { AgentResponse, CreateParams, ResponsesApi } from "../api/types.js";
import { TERMINAL_EVENTS } from "../api/types.js";
import { ApiError } from "../api/errors.js";
import type { BearerAuth } from "./auth.js";
import { SseWriter } from "./sse.js";
import { HEALTH_CONTENT_TYPE, toHealth } from "./health.js";

const MAX_BODY = 16 * 1024 * 1024;

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
  if (res.headersSent) return void res.end();
  sendJson(res, e.status, e.toBody());
}

/** Resolves with the terminal response of the chain that starts at `responseId`. */
function chainEnd(agent: ResponsesApi, responseId: string): Promise<AgentResponse> {
  return new Promise((resolve) => {
    const unsub = agent.stream(responseId, -1, (ev) => {
      if (!TERMINAL_EVENTS.has(ev.type)) return;
      // A steered response ends `incomplete` and its successor goes on: the chain ends later.
      if (ev.type === "response.incomplete" && (ev as { response: AgentResponse }).response.incomplete_details?.reason === "steered") return;
      queueMicrotask(() => unsub());
      resolve((ev as { response: AgentResponse }).response);
    });
  });
}

function streamChain(agent: ResponsesApi, responseId: string, startingAfter: number, req: http.IncomingMessage, res: http.ServerResponse, cancelOnClose: boolean): void {
  const sse = new SseWriter(res);
  let done = false;
  const unsub = agent.stream(responseId, startingAfter, (ev) => {
    sse.send(ev);
    if (!TERMINAL_EVENTS.has(ev.type)) return;
    // A steered response ends `incomplete` and its successor continues on the same stream.
    if (ev.type === "response.incomplete" && (ev as { response: AgentResponse }).response.incomplete_details?.reason === "steered") return;
    done = true;
    queueMicrotask(() => unsub());
    sse.end();
  });
  // The response side closes when the client goes away (the request side has closed already, once its body was read).
  res.on("close", () => {
    if (done || res.writableEnded) return;
    unsub();
    if (cancelOnClose) agent.cancelIfForeground(responseId).catch(() => {});
  });
}

export function createRequestHandler(agent: ResponsesApi, auth: BearerAuth): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => void handle(req, res).catch((err) => sendError(res, err));

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!auth.check(req.headers.authorization)) throw ApiError.unauthorized();
    const url = new URL(req.url ?? "/", "http://greyfolk");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && parts[0] === "health" && method === "GET") return sendJson(res, 200, toHealth(agent.state()), HEALTH_CONTENT_TYPE);
    if (parts[0] === "v1" && parts[1] === "responses") {
      if (parts.length === 2 && method === "POST") {
        const body = (await readJsonBody(req)) as CreateParams;
        const response = await agent.create(body);
        if (body.stream === true) return streamChain(agent, response.id, -1, req, res, true);
        // A background response is returned at once; the caller polls or re-attaches (the standard).
        if (body.background === true) return sendJson(res, 200, response);
        return sendJson(res, 200, await chainEnd(agent, response.id));
      }
      if (parts.length === 3 && method === "GET") {
        const response = agent.retrieve(parts[2]!);
        if (url.searchParams.get("stream") !== "true") return sendJson(res, 200, response);
        const after = Number(url.searchParams.get("starting_after") ?? "-1");
        if (!Number.isInteger(after)) throw ApiError.invalid("'starting_after' must be an integer.", null, "starting_after");
        return streamChain(agent, parts[2]!, after, req, res, false);
      }
      if (parts.length === 4 && parts[3] === "cancel" && method === "POST") return sendJson(res, 200, await agent.cancel(parts[2]!));
    }
    if (parts[0] === "v1" && parts[1] === "conversations" && parts.length === 4 && parts[3] === "items" && method === "GET") {
      return sendJson(res, 200, await agent.conversationItems(parts[2]!));
    }
    throw ApiError.notFound(`No route for ${method} ${url.pathname}.`);
  }
}
