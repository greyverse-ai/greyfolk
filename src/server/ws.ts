/**
 * The Responses WebSocket mode (spec §2, the default transport): one connection carries the
 * standard client events, `response.create` and `response.steer`; the server sends the stream
 * events of each response (and of its successors in the same turn). Cancelling is the standard
 * `POST /v1/responses/{id}/cancel`. Closing the connection cancels a response it created that is
 * not `background`.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentResponse, CreateParams, ResponseSteerFailedEvent, ResponseSteerInput, ResponsesApi } from "../api/types.js";
import { TERMINAL_EVENTS } from "../api/types.js";
import { ApiError } from "../api/errors.js";
import type { BearerAuth } from "./auth.js";


export interface WebSocketHandler {
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Terminates every open connection (server shutdown). */
  close: () => void;
}

export function createWebSocketHandler(agent: ResponsesApi, auth: BearerAuth): WebSocketHandler {
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
    /** The sequence number of the last event sent here (a steer failure follows it). */
    let lastSequence = -1;
    const send = (msg: object & { type: string; sequence_number?: number }): void => {
      if (typeof msg.sequence_number === "number") lastSequence = msg.sequence_number;
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const sendError = (err: unknown): void => {
      const e = ApiError.from(err);
      send({ type: "error", status: e.status, error: e.toBody().error } as { type: string });
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
      if (type === "response.create") onCreate(msg).catch(sendError);
      else if (type === "response.steer") onSteer(msg).catch(sendError);
      else sendError(ApiError.invalid(`Unknown client event type '${type}'.`, null, "type"));
    });

    ws.on("close", () => {
      for (const u of unsubs) u();
      unsubs.clear();
      for (const id of created) agent.cancelIfForeground(id).catch(() => {});
    });

    async function onCreate(msg: Record<string, unknown>): Promise<void> {
      const { type: _t, ...params } = msg;
      const response = await agent.create({ ...params, stream: true } as CreateParams);
      created.add(response.id);
      const unsub = agent.stream(response.id, -1, (ev) => {
        send(ev);
        if (!TERMINAL_EVENTS.has(ev.type)) return;
        if (ev.type === "response.incomplete" && (ev as { response: AgentResponse }).response.incomplete_details?.reason === "steered") return;
        created.delete(response.id);
        queueMicrotask(() => {
          unsub();
          unsubs.delete(unsub);
        });
      });
      unsubs.add(unsub);
    }

    async function onSteer(msg: Record<string, unknown>): Promise<void> {
      const previous = typeof msg.previous_response_id === "string" ? msg.previous_response_id : "";
      const outcome = previous
        ? await agent.steer(previous, msg.input as ResponseSteerInput)
        : { id: null, result: Promise.resolve({ code: "invalid_input", message: "Missing required parameter: 'previous_response_id'." }) };
      const r = await outcome.result;
      if (r === "taken_in") return;
      const failed: ResponseSteerFailedEvent = {
        type: "response.steer.failed",
        sequence_number: lastSequence + 1,
        steer: { ...(outcome.id ? { id: outcome.id } : {}), previous_response_id: previous, input: msg.input as ResponseSteerInput },
        error: { type: "invalid_request_error", code: r.code, message: r.message },
      };
      send(failed);
    }
  }
}
