/**
 * Every start option greyfolk takes, defined once (spec §8). The table below is the only place an
 * option is declared: argv parsing, validation and `--help` all come from it. An engine's own
 * options are its own keys, after `--`.
 *
 * Each option has exactly one source: the start command of this greyfolk process, set by its
 * starter. Everything after `--` belongs to the engine: greyfolk hands it to the engine's SDK as
 * it is. The engine's own settings files in the agent folder are read by the engine as usual.
 */

export type OptionKind = "string" | "flag" | "list";

export interface OptionSpec {
  name: string;
  kind: OptionKind;
  help?: string;
  /** Allowed values (for a list: of each item). */
  values?: readonly string[];
  default?: string | boolean | string[];
}

export const CORE_OPTIONS: OptionSpec[] = [
  { name: "listen", kind: "string", help: "where to listen: unix:PATH, tcp:HOST:PORT (PORT 0 = any) or fd:N (an inherited listening socket)" },
  { name: "socket-mode", kind: "string", help: "mode of a unix: listening socket (octal, default 0600)" },
  { name: "key-fd", kind: "string", help: "the bearer key, read once from this inherited file descriptor (never argv, the environment or a file)" },
  { name: "agent-dir", kind: "string", default: ".", help: "the agent folder" },
  { name: "engine", kind: "string", help: "the engine to run (required; see the list below)" },
  { name: "engine-exec", kind: "string", help: "a launcher prefix the engine is started through (e.g. a sandbox wrapper); without it greyfolk starts the engine itself" },
  { name: "model", kind: "string", values: ["fixed", "request"], default: "fixed", help: "fixed: a request's model is ignored; request: it may choose within the engine's family" },
  { name: "help", kind: "flag", default: false, help: "print this list" },
  { name: "engines", kind: "flag", default: false, help: "print the engines this greyfolk has, one per line" },
];

export type OptionValues = Map<string, string | boolean | string[]>;

function specOf(specs: OptionSpec[], name: string): OptionSpec {
  const spec = specs.find((s) => s.name === name);
  if (!spec) throw new Error(`unknown option --${name}`);
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

/** Splits greyfolk's own options from the engine's (everything after `--`). */
export function splitEngineArgs(argv: string[]): { own: string[]; engine: string[] } {
  const i = argv.indexOf("--");
  return i < 0 ? { own: argv, engine: [] } : { own: argv.slice(0, i), engine: argv.slice(i + 1) };
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
    const arg = s.kind === "flag" ? "" : s.kind === "list" ? " a,b,…" : " VALUE";
    const def = s.default !== undefined && s.default !== false && !(Array.isArray(s.default) && s.default.length === 0) ? ` (default ${String(s.default)})` : "";
    lines.push(`  --${s.name}${arg}`.padEnd(28) + (s.help ?? "") + def);
  }
  lines.push("", `engines: ${engines.join(", ")}`, "", "greyfolk [options] --engine NAME [-- the engine's own options, passed to its SDK as they are]");
  return lines.join("\n");
}
