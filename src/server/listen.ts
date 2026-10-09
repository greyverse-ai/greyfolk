/** `--listen unix:/path | tcp:host:port | fd:N` (spec §2 "Listening and auth", §8). */

export type ListenTarget =
  | { kind: "unix"; path: string; mode?: number }
  | { kind: "tcp"; host: string; port: number }
  | { kind: "fd"; fd: number };

export function parseListen(value: string): ListenTarget {
  if (value.startsWith("unix:")) {
    const path = value.slice("unix:".length);
    if (!path) throw new Error("--listen unix: needs a socket path");
    return { kind: "unix", path };
  }
  if (value.startsWith("tcp:")) {
    const rest = value.slice("tcp:".length);
    const at = rest.lastIndexOf(":");
    if (at < 0) throw new Error("--listen tcp: needs host:port");
    const host = rest.slice(0, at);
    const port = Number(rest.slice(at + 1));
    if (!host || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--listen tcp: needs host:port");
    return { kind: "tcp", host, port };
  }
  if (value.startsWith("fd:")) {
    const fd = Number(value.slice("fd:".length));
    if (!Number.isInteger(fd) || fd < 0) throw new Error("--listen fd: needs a file descriptor number");
    return { kind: "fd", fd };
  }
  throw new Error(`unknown --listen form '${value}' (use unix:/path, tcp:host:port or fd:N)`);
}
