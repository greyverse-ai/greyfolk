import { describe, expect, it } from "vitest";
import { resolveOptions, type KeyReaders } from "../src/cli-options.js";
import { CORE_OPTIONS, formatHelp, parseArgv, withDefaults, type OptionSpec } from "../src/options.js";

const keys: KeyReaders = { readKeyFromFd: () => "k-from-fd" };
const engines = ["fake", "claude", "codex"];
const engineSpecs: OptionSpec[] = [{ name: "codex-bin", kind: "string", help: "codex engine: the binary" }];
const specs = [...CORE_OPTIONS, ...engineSpecs];
const base = ["--listen", "tcp:127.0.0.1:0", "--key-fd", "3", "--agent-dir", "/tmp/agent-x"];
const resolve = (argv: string[]) => resolveOptions(withDefaults(specs, parseArgv(argv, specs)), keys, engines);

describe("start options (one table, fail closed)", () => {
  it("requires --engine from the registry; no silent default", () => {
    expect(() => resolve(base)).toThrow(/--engine is required/);
    expect(() => resolve([...base, "--engine", "nope"])).toThrow(/--engine must be one of/);
    expect(resolve([...base, "--engine", "claude"]).engine).toBe("claude");
  });

  it("turns tool kinds off one by one, or all with --no-host-tools", () => {
    expect(resolve([...base, "--engine", "claude"]).disabledTools).toEqual([]);
    expect(resolve([...base, "--engine", "claude", "--disable-tools", "shell,web"]).disabledTools).toEqual(["shell", "web"]);
    expect(resolve([...base, "--engine", "codex", "--no-host-tools"]).disabledTools).toEqual(["shell", "files", "web", "browser", "images", "apps"]);
    expect(() => resolve([...base, "--engine", "codex", "--disable-tools", "shell,teleport"])).toThrow(/'teleport' is not one of/);
  });

  it("--engine-exec is an optional launcher; the old names point at the new ones", () => {
    expect(resolve([...base, "--engine", "claude"]).engineExec).toEqual([]);
    expect(resolve([...base, "--engine", "claude", "--engine-exec", "/usr/bin/env -i"]).engineExec).toEqual(["/usr/bin/env", "-i"]);
    expect(() => resolve([...base, "--engine", "claude", "--harness-exec", "/usr/bin/env"])).toThrow(/use --engine-exec/);
    expect(() => resolve([...base, "--harness", "claude"])).toThrow(/--engine/);
    expect(() => resolve([...base, "--engine", "claude", "--nope", "x"])).toThrow(/unknown option --nope/);
  });

  it("an engine's own options join the same table", () => {
    expect(resolve([...base, "--engine", "codex", "--codex-bin", "/opt/codex"]).values.get("codex-bin")).toBe("/opt/codex");
    expect(formatHelp(specs, engines)).toContain("--codex-bin");
    expect(formatHelp(specs, engines)).not.toContain("--harness");
  });

  it("never takes the bearer key from argv", () => {
    expect(() => resolve(["--listen", "tcp:127.0.0.1:0", "--engine", "fake", "--dev-key", "x"])).toThrow(/--dev-key was removed/);
    expect(() => resolve(["--listen", "tcp:127.0.0.1:0", "--engine", "fake"])).toThrow(/--key-fd/);
    expect(resolve([...base, "--engine", "fake"]).key).toBe("k-from-fd");
    expect(() => resolve(["--listen", "tcp:127.0.0.1:0", "--key-file", "/tmp/k", "--engine", "fake"])).toThrow(/--key-file was removed/);
  });

  it("--socket-mode sets the unix socket mode; --subagent-profile is a file path", () => {
    const o = resolve(["--listen", "unix:/tmp/s.sock", "--key-fd", "3", "--engine", "fake", "--socket-mode", "0660", "--subagent-profile", "/etc/greyfolk/worker.json"]);
    expect(o.listen).toEqual({ kind: "unix", path: "/tmp/s.sock", mode: 0o660 });
    expect(o.subagentProfile).toBe("/etc/greyfolk/worker.json");
  });
});
