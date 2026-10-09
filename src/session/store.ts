/**
 * Session handling (spec §3).
 *
 * - The session is the engine's own file; greyfolk keeps no copy.
 * - The current session id lives in `.greyfolk/session` in the agent folder.
 * - A record of fed input hashes (`.greyfolk/seen-inputs`) lets resent history be skipped.
 * - `.greyfolk/inflight` names the response that was running, so a cut-off response is reported failed.
 * - `.greyfolk/held` keeps subagent results that arrived after their response ended (spec §5).
 * - Reset moves the engine's session paths out of the agent's reach (to an archive dir outside the folder).
 * - Export copies the agent folder when fully idle, leaving out what the engine rebuilds.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export const GREYFOLK_DIR = ".greyfolk";

export interface HeldResult {
  id: string;
  status: "completed" | "failed" | "stopped";
  output: string;
  /** When greyfolk took it in (ISO 8601). */
  at: string;
}

export class SessionStore {
  readonly agentDir: string;
  readonly dir: string;
  private readonly seen = new Set<string>();

  constructor(agentDir: string) {
    this.agentDir = path.resolve(agentDir);
    this.dir = path.join(this.agentDir, GREYFOLK_DIR);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(path.join(this.dir, "run"), { recursive: true });
    try {
      const raw = await fs.readFile(path.join(this.dir, "seen-inputs"), "utf8");
      for (const line of raw.split("\n")) if (line.trim()) this.seen.add(line.trim());
    } catch {
      /* none yet */
    }
  }

  get sessionFile(): string {
    return path.join(this.dir, "session");
  }

  async readSessionId(): Promise<string | null> {
    try {
      const id = (await fs.readFile(this.sessionFile, "utf8")).trim();
      return id || null;
    } catch {
      return null;
    }
  }

  async writeSessionId(id: string): Promise<void> {
    await fs.writeFile(this.sessionFile, `${id}\n`, "utf8");
  }

  hasSeen(hash: string): boolean {
    return this.seen.has(hash);
  }

  async markSeen(hashes: string[]): Promise<void> {
    const fresh = hashes.filter((h) => !this.seen.has(h));
    if (fresh.length === 0) return;
    for (const h of fresh) this.seen.add(h);
    await fs.appendFile(path.join(this.dir, "seen-inputs"), fresh.map((h) => `${h}\n`).join(""), "utf8");
  }

  async readInflight(): Promise<string | null> {
    try {
      const id = (await fs.readFile(path.join(this.dir, "inflight"), "utf8")).trim();
      return id || null;
    } catch {
      return null;
    }
  }

  async writeInflight(responseId: string | null): Promise<void> {
    const p = path.join(this.dir, "inflight");
    if (responseId === null) {
      await fs.rm(p, { force: true });
    } else {
      await fs.writeFile(p, `${responseId}\n`, "utf8");
    }
  }

  /** Held subagent results keyed by the first response id of the turn that spawned them (spec §5). */
  async readHeld(): Promise<Record<string, HeldResult[]>> {
    try {
      const raw = await fs.readFile(path.join(this.dir, "held"), "utf8");
      const parsed = JSON.parse(raw) as Record<string, HeldResult[]>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  async writeHeld(held: Record<string, HeldResult[]>): Promise<void> {
    const p = path.join(this.dir, "held");
    if (Object.keys(held).length === 0) {
      await fs.rm(p, { force: true });
    } else {
      await fs.writeFile(p, `${JSON.stringify(held)}\n`, "utf8");
    }
  }

  /**
   * Starts over: the engine's session paths and greyfolk's own session records move to
   * `<archiveDir>/<timestamp>/`, which must lie outside the agent folder.
   */
  async reset(sessionPaths: string[], archiveDir: string): Promise<string> {
    const archive = path.resolve(archiveDir);
    if (isInside(this.agentDir, archive)) throw new Error("reset archive dir must lie outside the agent folder");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(archive, stamp);
    await fs.mkdir(target, { recursive: true });
    const toMove = [...sessionPaths, path.join(GREYFOLK_DIR, "session"), path.join(GREYFOLK_DIR, "seen-inputs"), path.join(GREYFOLK_DIR, "inflight"), path.join(GREYFOLK_DIR, "held")];
    for (const rel of toMove) {
      const src = path.join(this.agentDir, rel);
      if (!isInside(this.agentDir, src)) throw new Error(`session path escapes the agent folder: ${rel}`);
      if (!(await exists(src))) continue;
      const dst = path.join(target, rel);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await moveAcross(src, dst);
    }
    this.seen.clear();
    return target;
  }

  /** Copies the agent folder to `dest`, leaving out `excludes` (relative paths or glob-like `*` names) and greyfolk's run dir. */
  async export(dest: string, excludes: string[]): Promise<void> {
    const target = path.resolve(dest);
    if (isInside(this.agentDir, target)) throw new Error("export destination must lie outside the agent folder");
    const skip = [...excludes, path.join(GREYFOLK_DIR, "run"), path.join(GREYFOLK_DIR, "inflight")].map(toMatcher);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(this.agentDir, target, {
      recursive: true,
      errorOnExist: false,
      filter: (src) => {
        const rel = path.relative(this.agentDir, src);
        if (!rel) return true;
        return !skip.some((m) => m(rel));
      },
    });
  }
}

function toMatcher(pattern: string): (rel: string) => boolean {
  const normalised = pattern.split(path.sep).join("/");
  if (!normalised.includes("*")) {
    return (rel) => {
      const r = rel.split(path.sep).join("/");
      return r === normalised || r.startsWith(`${normalised}/`);
    };
  }
  const re = new RegExp(`^${normalised.split("*").map(escapeRe).join("[^/]*")}$`);
  return (rel) => {
    const r = rel.split(path.sep).join("/");
    return re.test(r) || re.test(path.posix.basename(r));
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function moveAcross(src: string, dst: string): Promise<void> {
  try {
    await fs.rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(src, dst, { recursive: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}
