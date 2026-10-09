/**
 * CLI start options (spec §8), resolved without side effects so they can be tested.
 *
 *   greyfolk --listen unix:/path|tcp:host:port|fd:N --key-fd N --agent-dir DIR
 *            --harness fake|claude|codex --harness-exec "<launcher>" [--model fixed|request]
 *            [--subagent-profile NAME] [--soul FILE] [--reset-archive DIR] [--socket-mode OCTAL]
 *
 * Fail closed: `--harness` is required (no silent default), and `claude`/`codex` refuse to start
 * without `--harness-exec` (the sandbox launcher). Only `fake` may run without one. The bearer key
 * comes only from an inherited file descriptor (`--key-fd`): never argv, the environment or a file
 * (spec §2 — a file is something the sandbox might read).
 */
import * as path from "node:path";
import { parseListen, type ListenTarget } from "./server/listen.js";
import { checkExecPrefix, parseExecPrefix } from "./harness/exec.js";

export type HarnessName = "fake" | "claude" | "codex";
export type ModelPolicy = "fixed" | "request";

export interface StartOptions {
  listen: ListenTarget;
  agentDir: string;
  key: string;
  harnessName: HarnessName;
  execPrefix: string[];
  modelPolicy: ModelPolicy;
  subagentProfile: string | null;
  soulOverride: string | undefined;
  resetArchiveDir: string;
}

export interface KeyReaders {
  readKeyFromFd(fd: number): string;
}

export function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument '${a}'`);
    const eq = a.indexOf("=");
    if (eq > 0) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${a.slice(2)} needs a value`);
      out.set(a.slice(2), v);
      i++;
    }
  }
  return out;
}

export function resolveOptions(args: Map<string, string>, keys: KeyReaders): StartOptions {
  const listenArg = args.get("listen");
  if (!listenArg) throw new Error("--listen is required");
  const listen = parseListen(listenArg);
  if (listen.kind === "unix" && args.has("socket-mode")) {
    const mode = parseInt(args.get("socket-mode")!, 8);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error("--socket-mode must be an octal mode like 0600");
    listen.mode = mode;
  }
  const agentDir = path.resolve(args.get("agent-dir") ?? ".");

  if (args.has("dev-key")) throw new Error("--dev-key was removed: the bearer key never travels in arguments; hand it over on an inherited file descriptor with --key-fd N");
  if (args.has("key-file")) throw new Error("--key-file was removed: the bearer key never lives in a file the sandbox might read; hand it over on an inherited file descriptor with --key-fd N (e.g. --key-fd 3 3<key)");
  const keyFd = args.get("key-fd");
  if (!keyFd) throw new Error("--key-fd N is required (the bearer key arrives on an inherited file descriptor)");
  const fd = Number(keyFd);
  if (!Number.isInteger(fd) || fd < 0) throw new Error("--key-fd needs a file descriptor number");
  const key = keys.readKeyFromFd(fd);

  const modelPolicy = (args.get("model") ?? "fixed") as ModelPolicy;
  if (modelPolicy !== "fixed" && modelPolicy !== "request") throw new Error("--model must be 'fixed' or 'request'");

  const harnessName = args.get("harness") as HarnessName | undefined;
  if (!harnessName) throw new Error("--harness is required ('fake', 'claude' or 'codex'); there is no default");
  if (!["fake", "claude", "codex"].includes(harnessName)) throw new Error("--harness must be 'fake', 'claude' or 'codex'");

  const execPrefix = parseExecPrefix(args.get("harness-exec"));
  if (harnessName !== "fake" && execPrefix.length === 0) {
    throw new Error(`--harness ${harnessName} needs --harness-exec <launcher>: the engine is started only through the sandbox launcher (fail closed)`);
  }
  checkExecPrefix(execPrefix);

  const subagentProfile = args.get("subagent-profile") ?? null;
  const resetArchiveDir = path.resolve(args.get("reset-archive") ?? path.join(path.dirname(agentDir), `${path.basename(agentDir)}.archive`));
  return { listen, agentDir, key, harnessName, execPrefix, modelPolicy, subagentProfile, soulOverride: args.get("soul"), resetArchiveDir };
}
