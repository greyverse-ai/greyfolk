/** Small file helpers shared by the service and the engines. */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** True when `child` lies inside `parent` (or is it). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Writes a file atomically (temp file + rename), with the given mode. */
export async function writeAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, { encoding: "utf8", mode });
  await fs.rename(tmp, file);
}
