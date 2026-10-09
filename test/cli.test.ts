import { describe, expect, it } from "vitest";
import { resolveOptions, type KeyReaders } from "../src/cli-options.js";
import { CORE_OPTIONS, formatHelp, parseArgv, splitEngineArgs, withDefaults, type OptionSpec } from "../src/options.js";

const keys: KeyReaders = { readKeyFromFd: () => "k-from-fd" };
const engines = ["fake", "claude", "codex"];
const specs: OptionSpec[] = [...CORE_OPTIONS, { name: "codex-bin", kind: "string", help: "codex engine: the binary" }];
const base = ["--listen", "tcp:127.0.0.1:0", "--key-fd", "3", "--agent-dir", "/tmp/agent-x"];
const resolve = (argv: string[]) => {
  const { own, engine } = splitEngineArgs(argv);
  return resolveOptions(withDefaults(specs, parseArgv(own, specs)), keys, engines, engine);
};

describe("start options", () => {
  it("--engine is required; the engine's own options come after -- and pass as they are", () => {
    expect(() => resolve(base)).toThrow(/--engine is required/);
    expect(() => resolve([...base, "--engine", "nope"])).toThrow(/--engine must be one of/);
    const o = resolve([...base, "--engine", "claude", "--", "--tools", "Agent,TodoWrite", "--model", "x"]);
    expect(o.engine).toBe("claude");
    expect(o.engineArgs).toEqual(["--tools", "Agent,TodoWrite", "--model", "x"]);
  });

  it("removed options point at what replaced them; unknown ones are refused", () => {
    expect(() => resolve([...base, "--engine", "claude", "--no-host-tools"])).toThrow(/after --/);
    expect(() => resolve([...base, "--engine", "claude", "--disable-tools", "shell"])).toThrow(/after --/);
    expect(() => resolve([...base, "--engine", "claude", "--harness-exec", "x"])).toThrow(/--engine-exec/);
    expect(() => resolve([...base, "--engine", "claude", "--nope", "x"])).toThrow(/unknown option --nope/);
  });

  it("--engine-exec is an optional launcher; engines add their own options to the one table", () => {
    expect(resolve([...base, "--engine", "claude", "--engine-exec", "/usr/bin/env -i"]).engineExec).toEqual(["/usr/bin/env", "-i"]);
    expect(resolve([...base, "--engine", "codex", "--codex-bin", "/opt/codex"]).values.get("codex-bin")).toBe("/opt/codex");
    expect(formatHelp(specs, engines)).toContain("--codex-bin");
  });

  it("never takes the bearer key from argv", () => {
    expect(() => resolve(["--listen", "tcp:127.0.0.1:0", "--engine", "fake", "--dev-key", "x"])).toThrow(/--dev-key was removed/);
    expect(() => resolve(["--listen", "tcp:127.0.0.1:0", "--engine", "fake"])).toThrow(/--key-fd/);
    expect(resolve([...base, "--engine", "fake"]).key).toBe("k-from-fd");
  });
});
