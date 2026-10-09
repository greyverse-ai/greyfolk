/**
 * The Codex app-server's own wire: JSON-RPC messages, one per line, over the child's stdio
 * (`codex app-server`). Requests go both ways: greyfolk calls the server, and the server asks
 * greyfolk (approvals); notifications carry the turn as it runs.
 */
import type { ChildProcess } from "node:child_process";
import * as readline from "node:readline";

interface Message {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RpcHandlers {
  notification(method: string, params: unknown): void;
  /** Answers a request the server sends; a throw becomes a JSON-RPC error. */
  request(method: string, params: unknown): Promise<unknown>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export class AppServerRpc {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Resolves when the process is gone, with why. */
  readonly closed: Promise<string>;

  constructor(
    readonly child: ChildProcess,
    private readonly handlers: RpcHandlers,
  ) {
    readline.createInterface({ input: child.stdout! }).on("line", (line) => this.receive(line));
    this.closed = new Promise((resolve) => {
      const done = (why: string) => {
        for (const p of this.pending.values()) p.reject(new Error(`codex app-server ${why}`));
        this.pending.clear();
        resolve(why);
      };
      child.once("exit", (code, signal) => done(`exited (${signal ?? code})`));
      child.once("error", (err) => done(`failed: ${err.message}`));
    });
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  private write(msg: Message): void {
    if (this.child.stdin?.writable) this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private receive(line: string): void {
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      const id = msg.id;
      this.handlers.request(msg.method, msg.params).then(
        (result) => this.write({ id, result }),
        (err: unknown) => this.write({ id, error: { code: err instanceof RpcError ? err.code : -32603, message: err instanceof Error ? err.message : String(err) } }),
      );
    } else if (msg.method !== undefined) {
      this.handlers.notification(msg.method, msg.params);
    } else if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new RpcError(msg.error.message, msg.error.code));
      else p?.resolve(msg.result);
    }
  }
}
