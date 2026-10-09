/**
 * `--harness-exec <launcher>`: a prefix the starter supplies (the sandbox launcher).
 * The engine program is started only through it; if it fails, greyfolk exits (fail closed).
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants } from "node:fs";

/** Splits a launcher string into argv (whitespace-separated, double/single quotes honoured). */
export function parseExecPrefix(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export function checkExecPrefix(prefix: string[]): void {
  if (prefix.length === 0) return;
  const launcher = prefix[0]!;
  if (launcher.includes("/")) {
    accessSync(launcher, constants.X_OK);
  }
}

/** Spawns `prefix... command args...` in its own process group so the group can be killed. */
export function spawnThrough(prefix: string[], command: string, args: string[], options: SpawnOptions): ChildProcess {
  const argv = [...prefix, command, ...args];
  const child = spawn(argv[0]!, argv.slice(1), { ...options, detached: process.platform !== "win32" });
  return child;
}

/** Kills the process group of `child` (falls back to the process itself). */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}
