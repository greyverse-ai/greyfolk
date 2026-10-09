/**
 * Start options (spec §8) resolved from the one option table (`options.ts`), without side effects
 * so they can be tested.
 *
 * Fail closed: `--engine` is required (no silent default). Turning engine tools off is per kind
 * (`--disable-tools`) or all at once (`--no-host-tools`); an engine that cannot confirm what it
 * was told to turn off refuses to start. The bearer key comes only from an inherited file
 * descriptor (`--key-fd`): never argv, the environment or a file (spec §2).
 */
import * as path from "node:path";
import { parseListen, type ListenTarget } from "./server/listen.js";
import { parseExecPrefix } from "./engine/process.js";
import { TOOL_KINDS, type OptionValues, type ToolKind } from "./options.js";
import type { ModelPolicy } from "./service/agent-service.js";

export interface StartOptions {
  listen: ListenTarget;
  agentDir: string;
  key: string;
  engine: string;
  /** Launcher prefix the engine is started through (empty = greyfolk starts it itself). */
  engineExec: string[];
  /** Kinds of the engine's own tools that are off. */
  disabledTools: ToolKind[];
  modelPolicy: ModelPolicy;
  /** Path of the starter's subagent profile file, or null. */
  subagentProfile: string | null;
  soulOverride: string | undefined;
  resetArchiveDir: string;
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
export function resolveOptions(v: OptionValues, keys: KeyReaders, engines: string[]): StartOptions {
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

  const listed = (v.get("disable-tools") as string[] | undefined) ?? [];
  const disabledTools: ToolKind[] = v.get("no-host-tools") === true ? [...TOOL_KINDS] : TOOL_KINDS.filter((k) => listed.includes(k));

  const profile = str(v, "subagent-profile");
  const resetArchiveDir = path.resolve(str(v, "reset-archive") ?? path.join(path.dirname(agentDir), `${path.basename(agentDir)}.archive`));
  return {
    listen,
    agentDir,
    key,
    engine,
    engineExec: parseExecPrefix(str(v, "engine-exec")),
    disabledTools,
    modelPolicy: (str(v, "model") ?? "fixed") as ModelPolicy,
    subagentProfile: profile ? path.resolve(profile) : null,
    soulOverride: str(v, "soul"),
    resetArchiveDir,
    values: v,
  };
}
