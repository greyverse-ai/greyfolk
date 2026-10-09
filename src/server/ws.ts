/**
 * The Responses WebSocket mode (spec §2, the default transport): one connection carries
 * `response.create`, `response.steer` and `response.cancel` client events; the server sends
 * the stream events of each response (and of its successors in the same turn).
 * Closing the connection cancels a response it created that is not `background`.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { CreateParams, ResponseSteerInput, ResponsesApi } from "../api/types.js";
import { TERMINAL_EVENTS } from "../api/types.js";
import { ApiError } from "../api/errors.js";
import type { BearerAuth } from "./auth.js";

export interface WsOptions {
  agent: ResponsesApi;
  auth: BearerAuth;
}

export interface WebSocketHandler {
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Terminates every open connection (server shutdown). */
  close: () => void;
}

export function createWebSocketHandler(opts: WsOptions): WebSocketHandler {
  const { agent, auth } = opts;
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => attach(ws));

  const close = (): void => {
    for (const c of wss.clients) c.terminate();
    wss.close();
  };

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://greyfolk");
    if (url.pathname !== "/v1/responses") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!auth.check(req.headers.authorization)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };

  return { handleUpgrade, close };

  function attach(ws: WebSocket): void {
    const created = new Set<string>();
    const unsubs = new Set<() => void>();
    const send = (msg: unknown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const sendError = (err: unknown, extra: Record<string, unknown> = {}): void => {
      const e = ApiError.from(err);
      send({ type: "error", ...extra, error: e.toBody().error });
    };

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        sendError(ApiError.invalid("Message is not valid JSON."));
        return;
      }
      const type = String(msg.type ?? "");
      if (type === "response.create") {
        onCreate(msg).catch((err) => sendError(err, { event_id: msg.event_id ?? null }));
      } else if (type === "response.steer") {
        onSteer(msg).catch((err) => sendError(err, { event_id: msg.event_id ?? null }));
      } else if (type === "response.cancel") {
        onCancel(msg).catch((err) => sendError(err, { event_id: msg.event_id ?? null }));
      } else {
        sendError(ApiError.invalid(`Unknown client event type '${type}'.`), { event_id: msg.event_id ?? null });
      }
    });

    ws.on("close", () => {
      for (const u of unsubs) u();
      unsubs.clear();
      for (const id of created) agent.cancelIfForeground(id).catch(() => {});
    });

    async function onCreate(msg: Record<string, unknown>): Promise<void> {
      const { type: _t, event_id: _e, ...params } = msg;
      const response = await agent.create({ ...params, stream: true } as CreateParams);
      created.add(response.id);
      const unsub = agent.stream(response.id, -1, (ev) => {
        send(ev);
        if (TERMINAL_EVENTS.has(ev.type)) {
          created.delete(response.id);
          queueMicrotask(() => {
            unsub();
            unsubs.delete(unsub);
          });
        }
      });
      unsubs.add(unsub);
    }

    async function onSteer(msg: Record<string, unknown>): Promise<void> {
      if (msg.input === undefined) throw ApiError.invalid("Missing required parameter: 'input'.", "missing_required_parameter", "input");
      let previous = typeof msg.previous_response_id === "string" ? msg.previous_response_id : null;
      if (!previous) {
        const turn = agent.status().turn;
        if (!turn) {
          send({ type: "response.steer.failed", event_id: msg.event_id ?? null, error: { type: "invalid_request_error", code: "response_not_active", message: "No response is running; start a new turn." } });
          return;
        }
        previous = turn.response_id;
      }
      const { liveResponseId, result, steerId } = await agent.steer(previous, msg.input as ResponseSteerInput);
      if (!liveResponseId) {
        send({ type: "response.steer.failed", event_id: msg.event_id ?? null, steer: { id: steerId, previous_response_id: previous }, error: { type: "invalid_request_error", code: "response_not_active", message: "The response ended before the input could be taken in; start a new turn." } });
        return;
      }
      await result;
    }

    async function onCancel(msg: Record<string, unknown>): Promise<void> {
      const id = typeof msg.response_id === "string" ? msg.response_id : null;
      if (!id) throw ApiError.invalid("Missing required parameter: 'response_id'.", "missing_required_parameter", "response_id");
      await agent.cancel(id);
    }
  }
}
