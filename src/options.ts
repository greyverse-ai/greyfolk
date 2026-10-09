/**
 * Every start option greyfolk takes, defined once (spec §8). The table below is the only place an
 * option is declared: argv parsing, validation and `--help` all come from it. Engines add their own
 * options through the registry (`EngineDefinition.options`), so a new engine never edits this file.
 *
 * Each option has exactly one source: the start command of this greyfolk process, set by its
 * starter, fixed for the process's life. There is no config-file layer and no precedence between
 * sources. Where an option overlaps a setting in the engine's own files, the spec's settings map
 * (greyfolk.md §8.1) says which one decides and how.
 */

export type OptionKind = "string" | "flag" | "list";

export interface OptionSpec {
  name: string;
  kind: OptionKind;
  help?: string;
  /** Allowed values (for a list: of each item). */
  values?: readonly string[];
  default?: string | boolean | string[];
  /** Refused with this message (options that were removed on purpose). */
  removed?: string;
}

/** Kinds of the engine's own tools that can be turned off one by one (`--disable-tools`). */
export const TOOL_KINDS = ["shell", "files", "web", "browser", "images", "apps"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];

export const CORE_OPTIONS: OptionSpec[] = [
  { name: "listen", kind: "string", help: "where to listen: unix:PATH, tcp:HOST:PORT (PORT 0 = any) or fd:N (an inherited listening socket)" },
  { name: "socket-mode", kind: "string", help: "mode of a unix: listening socket (octal, default 0600)" },
  { name: "key-fd", kind: "string", help: "the bearer key, read once from this inherited file descriptor (never argv, the environment or a file)" },
  { name: "agent-dir", kind: "string", default: ".", help: "the agent folder" },
  { name: "engine", kind: "string", help: "the engine to run (required; see the list below)" },
  { name: "engine-exec", kind: "string", help: "a launcher prefix the engine is started through (e.g. a sandbox wrapper); without it greyfolk starts the engine itself" },
  { name: "disable-tools", kind: "list", values: TOOL_KINDS, default: [], help: `kinds of the engine's own tools to turn off: ${TOOL_KINDS.join(", ")}` },
  { name: "no-host-tools", kind: "flag", default: false, help: "turn off every kind of the engine's own tools (same as --disable-tools with all kinds); only the request's MCP tools reach anything" },
  { name: "model", kind: "string", values: ["fixed", "request"], default: "fixed", help: "fixed: a request's model is ignored; request: it may choose within the engine's family" },
  { name: "subagent-profile", kind: "string", help: "a JSON file: the MCP tools (and, with host tools on, paths) native subagents may use" },
  { name: "soul", kind: "string", help: "the instruction file to use instead of AGENTS.md / CLAUDE.md in the agent folder" },
  { name: "reset-archive", kind: "string", help: "where a reset moves the old session (outside the agent folder; default <agent>.archive)" },
  { name: "help", kind: "flag", default: false, help: "print this list" },
  { name: "harness", kind: "string", removed: "--harness was renamed: name the engine with --engine" },
  { name: "harness-exec", kind: "string", removed: "--harness-exec was renamed: use --engine-exec" },
  { name: "dev-key", kind: "string", removed: "--dev-key was removed: the bearer key never travels in arguments; hand it over on an inherited file descriptor with --key-fd N" },
  { name: "key-file", kind: "string", removed: "--key-file was removed: the bearer key never lives in a file the sandbox might read; hand it over on an inherited file descriptor with --key-fd N (e.g. --key-fd 3 3<key)" },
];

export type OptionValues = Map<string, string | boolean | string[]>;

function specOf(specs: OptionSpec[], name: string): OptionSpec {
  const spec = specs.find((s) => s.name === name);
  if (!spec) throw new Error(`unknown option --${name}`);
  if (spec.removed) throw new Error(spec.removed);
  return spec;
}

function coerce(spec: OptionSpec, raw: string, where: string): string | boolean | string[] {
  if (spec.kind === "flag") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`--${spec.name} (${where}) is a flag`);
  }
  if (spec.kind === "list") {
    const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (spec.values) for (const i of items) if (!spec.values.includes(i)) throw new Error(`--${spec.name} (${where}): '${i}' is not one of ${spec.values.join(", ")}`);
    return items;
  }
  const v = raw;
  if (spec.values && !spec.values.includes(v)) throw new Error(`--${spec.name} must be one of ${spec.values.join(", ")}`);
  return v;
}

/** Parses `--name value`, `--name=value` and bare flags against the specs. */
export function parseArgv(argv: string[], specs: OptionSpec[]): OptionValues {
  const out: OptionValues = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument '${a}'`);
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const spec = specOf(specs, name);
    if (spec.kind === "flag" && eq < 0) {
      out.set(name, true);
      continue;
    }
    let raw: string;
    if (eq > 0) raw = a.slice(eq + 1);
    else {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${name} needs a value`);
      raw = v;
      i++;
    }
    out.set(name, coerce(spec, raw, "command line"));
  }
  return out;
}

/** The parsed values with each option's default filled in where it was not given. */
export function withDefaults(specs: OptionSpec[], given: OptionValues): OptionValues {
  const out: OptionValues = new Map();
  for (const s of specs) if (s.default !== undefined) out.set(s.name, s.default);
  for (const [k, v] of given) out.set(k, v);
  return out;
}

export function formatHelp(specs: OptionSpec[], engines: string[]): string {
  const lines = ["greyfolk — one agent served as an OpenAI Responses-shaped server", "", "options:"];
  for (const s of specs) {
    if (s.removed) continue;
    const arg = s.kind === "flag" ? "" : s.kind === "list" ? " a,b,…" : " VALUE";
    const def = s.default !== undefined && s.default !== false && !(Array.isArray(s.default) && s.default.length === 0) ? ` (default ${String(s.default)})` : "";
    lines.push(`  --${s.name}${arg}`.padEnd(28) + (s.help ?? "") + def);
  }
  lines.push("", `engines: ${engines.join(", ")}`);
  return lines.join("\n");
}
