/** Binds the HTTP handler and the WebSocket upgrade to one listening socket (spec §2, §8). */
import * as http from "node:http";
import * as net from "node:net";
import { promises as fs } from "node:fs";
import type { Agent } from "../profile/engine.js";
import type { BearerAuth } from "./auth.js";
import { createRequestHandler } from "./http.js";
import type { ListenTarget } from "./listen.js";
import { createWebSocketHandler } from "./ws.js";

export interface GreyfolkServer {
  server: http.Server;
  /** Where the server listens (unix path or host:port). */
  address: string;
  close(): Promise<void>;
}

export function createServer(agent: Agent, auth: BearerAuth): { server: http.Server; closeSockets: () => void } {
  const server = http.createServer(createRequestHandler({ agent, auth }));
  const ws = createWebSocketHandler({ agent, auth });
  server.on("upgrade", ws.handleUpgrade);
  return { server, closeSockets: ws.close };
}

/** Default mode of a unix listening socket: owner only (the starter may dictate another). */
export const DEFAULT_SOCKET_MODE = 0o600;

/** True when something currently accepts connections on the socket path. */
function socketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(socketPath);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

/**
 * Prepares a unix socket path: refuses anything that exists and is not a socket, refuses a socket
 * another server still answers on, and unlinks only a stale socket.
 */
export async function prepareUnixSocketPath(socketPath: string): Promise<void> {
  const st = await fs.lstat(socketPath).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (!st) return;
  if (!st.isSocket()) throw new Error(`refusing to listen on ${socketPath}: it exists and is not a socket`);
  if (await socketAlive(socketPath)) throw new Error(`refusing to listen on ${socketPath}: another server is accepting connections there`);
  await fs.unlink(socketPath);
}

export async function listen(server: http.Server, target: ListenTarget): Promise<string> {
  const mode = target.kind === "unix" ? (target.mode ?? DEFAULT_SOCKET_MODE) : null;
  if (target.kind === "unix") await prepareUnixSocketPath(target.path);
  // The socket is created with the restrictive mode from the start (umask), then set exactly.
  const oldUmask = mode !== null && process.platform !== "win32" ? process.umask(0o777 & ~mode) : null;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      const done = (): void => {
        server.off("error", reject);
        resolve();
      };
      if (target.kind === "unix") server.listen(target.path, done);
      else if (target.kind === "tcp") server.listen(target.port, target.host, done);
      else server.listen({ fd: target.fd }, done);
    });
  } finally {
    if (oldUmask !== null) process.umask(oldUmask);
  }
  if (target.kind === "unix" && mode !== null && process.platform !== "win32") await fs.chmod(target.path, mode);
  const addr = server.address();
  if (typeof addr === "string") return addr;
  if (addr) return `${addr.address}:${addr.port}`;
  return target.kind === "fd" ? `fd:${target.fd}` : "";
}

export async function startServer(agent: Agent, auth: BearerAuth, target: ListenTarget): Promise<GreyfolkServer> {
  const { server, closeSockets } = createServer(agent, auth);
  const address = await listen(server, target);
  return {
    server,
    address,
    close: () =>
      new Promise<void>((resolve) => {
        closeSockets();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
