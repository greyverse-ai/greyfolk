/**
 * Bearer key auth (spec §2 "Listening and auth").
 * The key is read from an inherited file descriptor (`--key-fd`), never from the environment,
 * arguments or a file the sandbox could read.
 */
import { closeSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

/** Reads the key once and closes the descriptor, so no engine process inherits it. */
export function readKeyFromFd(fd: number): string {
  let raw: string;
  try {
    raw = readFileSync(fd, "utf8");
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  const key = raw.replace(/\r?\n$/, "");
  if (!key) throw new Error(`bearer key on fd ${fd} is empty`);
  return key;
}

export class BearerAuth {
  private readonly key: Buffer;

  constructor(key: string) {
    if (!key) throw new Error("bearer key must not be empty");
    this.key = Buffer.from(key, "utf8");
  }

  /** True when `Authorization: Bearer <key>` carries the configured key. */
  check(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader) return false;
    const m = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    if (!m) return false;
    const given = Buffer.from(m[1]!, "utf8");
    if (given.length !== this.key.length) return false;
    return timingSafeEqual(given, this.key);
  }
}
