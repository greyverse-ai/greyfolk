/**
 * Session record (spec §3).
 *
 * - The session is the engine's own file; greyfolk keeps no copy.
 * - The current session id lives in `.greyfolk/session` in the agent folder.
 * - `.greyfolk/inflight` names the response that was running, so a cut-off response is reported failed.
 * - `.greyfolk/latest` names the newest response, so a client can continue after a restart.
 * - Every write goes through one queue and is atomic (temp file + rename), so writes never interleave.
 * - Reset moves the engine's session paths out of the agent's reach (to an archive dir outside the folder).
 * - Export copies the agent folder when fully idle, leaving out what the engine rebuilds.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { escapeRe, exists, isInside, writeAtomic } from "./fsutil.js";

export const GREYFOLK_DIR = ".greyfolk";


/** The session record in `.greyfolk/` (engine-neutral; every engine uses it). */
export class SessionRecord {
  readonly agentDir: string;
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();

  /** Runs `fn` after every earlier write has finished. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  constructor(agentDir: string) {
    this.agentDir = path.resolve(agentDir);
    this.dir = path.join(this.agentDir, GREYFOLK_DIR);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(path.join(this.dir, "run"), { recursive: true });
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

  writeSessionId(id: string): Promise<void> {
    return this.serial(() => writeAtomic(this.sessionFile, `${id}\n`));
  }

  async readLatest(): Promise<string | null> {
    try {
      return (await fs.readFile(path.join(this.dir, "latest"), "utf8")).trim() || null;
    } catch {
      return null;
    }
  }

  writeLatest(responseId: string): Promise<void> {
    return this.serial(() => writeAtomic(path.join(this.dir, "latest"), `${responseId}\n`));
  }

  async readInflight(): Promise<string | null> {
    try {
      const id = (await fs.readFile(path.join(this.dir, "inflight"), "utf8")).trim();
      return id || null;
    } catch {
      return null;
    }
  }

  writeInflight(responseId: string | null): Promise<void> {
    const p = path.join(this.dir, "inflight");
    return this.serial(() => (responseId === null ? fs.rm(p, { force: true }) : writeAtomic(p, `${responseId}\n`)));
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
    const toMove = [...sessionPaths, path.join(GREYFOLK_DIR, "session"), path.join(GREYFOLK_DIR, "inflight"), path.join(GREYFOLK_DIR, "latest")];
    for (const rel of toMove) {
      const src = path.join(this.agentDir, rel);
      if (!isInside(this.agentDir, src)) throw new Error(`session path escapes the agent folder: ${rel}`);
      if (!(await exists(src))) continue;
      const dst = path.join(target, rel);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await moveAcross(src, dst);
    }
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

async function moveAcross(src: string, dst: string): Promise<void> {
  try {
    await fs.rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(src, dst, { recursive: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}
