/** Server-sent events writer for Responses streaming. */
import type { ServerResponse } from "node:http";
import type { StreamEvent } from "../profile/types.js";

export const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.cancelled"]);

export class SseWriter {
  private readonly res: ServerResponse;
  private open = true;

  constructor(res: ServerResponse) {
    this.res = res;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();
  }

  send(event: StreamEvent): void {
    if (!this.open) return;
    this.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  end(): void {
    if (!this.open) return;
    this.open = false;
    this.res.end();
  }
}
