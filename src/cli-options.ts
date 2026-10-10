/**
 * Start options (spec §8) resolved from the one option table (`options.ts`), without side effects
 * so they can be tested.
 *
 * `--engine` is required (no silent default); the engine's own options come after `--`. The
 * bearer key comes only from an inherited file descriptor (`--key-fd`): never argv, the
 * environment or a file (spec §2).
 */
import * as path from "node:path";
import { parseListen, type ListenTarget } from "./server/listen.js";
import { parseExecPrefix } from "./engine/process.js";
import type { OptionValues } from "./options.js";
import type { ModelPolicy } from "./service/agent.js";

export interface StartOptions {
  listen: ListenTarget;
  agentDir: string;
  key: string;
  engine: string;
  /** Launcher prefix the engine is started through (empty = greyfolk starts it itself). */
  engineExec: string[];
  /** The engine's own options (after `--`), for its SDK as they are. */
  engineArgs: string[];
  modelPolicy: ModelPolicy;
  /** Every resolved option, for the engine's own options. */
  values: OptionValues;
}

export interface KeyReaders {
  readKeyFromFd(fd: number): string;
}

const str = (v: OptionValues, k: string): string | undefined => {
  const x = v.get(k);
  return typeof x === "string" ? x : undefined;
};

/** `engines`: the registered engine names (the caller passes them, so this stays free of side effects). */
export function resolveOptions(v: OptionValues, keys: KeyReaders, engines: string[], engineArgs: string[] = []): StartOptions {
  const listenArg = str(v, "listen");
  if (!listenArg) throw new Error("--listen is required");
  const listen = parseListen(listenArg);
  const socketMode = str(v, "socket-mode");
  if (listen.kind === "unix" && socketMode !== undefined) {
    const mode = parseInt(socketMode, 8);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error("--socket-mode must be an octal mode like 0600");
    listen.mode = mode;
  }
  const agentDir = path.resolve(str(v, "agent-dir") ?? ".");

  const keyFd = str(v, "key-fd");
  if (!keyFd) throw new Error("--key-fd N is required (the bearer key arrives on an inherited file descriptor)");
  const fd = Number(keyFd);
  if (!Number.isInteger(fd) || fd < 0) throw new Error("--key-fd needs a file descriptor number");
  const key = keys.readKeyFromFd(fd);

  const engine = str(v, "engine");
  if (!engine) throw new Error(`--engine is required (${engines.join(", ")}); there is no default`);
  if (!engines.includes(engine)) throw new Error(`--engine must be one of: ${engines.join(", ")}`);


  return {
    listen,
    agentDir,
    key,
    engine,
    engineExec: parseExecPrefix(str(v, "engine-exec")),
    engineArgs,
    modelPolicy: (str(v, "model") ?? "fixed") as ModelPolicy,
    values: v,
  };
}
