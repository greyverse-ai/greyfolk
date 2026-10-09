import { describe, expect, it } from "vitest";
import { parseArgs, resolveOptions, type KeyReaders } from "../src/cli-options.js";

const keys: KeyReaders = { readKeyFromFd: () => "k-from-fd" };
const base = ["--listen", "tcp:127.0.0.1:0", "--key-fd", "3", "--agent-dir", "/tmp/agent-x"];
const resolve = (argv: string[]) => resolveOptions(parseArgs(argv), keys);

describe("cli options (fail closed)", () => {
  it("requires --harness; no silent default", () => {
    expect(() => resolve(base)).toThrow(/--harness is required/);
    expect(resolve([...base, "--harness", "fake"]).harnessName).toBe("fake");
  });

  it("claude and codex refuse to start without --harness-exec; fake may", () => {
    expect(() => resolve([...base, "--harness", "claude"])).toThrow(/--harness-exec/);
    expect(() => resolve([...base, "--harness", "codex"])).toThrow(/--harness-exec/);
    expect(() => resolve([...base, "--harness", "codex", "--harness-exec", "  "])).toThrow(/--harness-exec/);
    expect(resolve([...base, "--harness", "claude", "--harness-exec", "/usr/bin/env -i"]).execPrefix).toEqual(["/usr/bin/env", "-i"]);
    expect(resolve([...base, "--harness", "fake"]).execPrefix).toEqual([]);
  });

  it("never takes the bearer key from argv", () => {
    expect(() => resolve(["--listen", "tcp:127.0.0.1:0", "--harness", "fake", "--dev-key", "x"])).toThrow(/--dev-key was removed/);
    expect(() => resolve(["--listen", "tcp:127.0.0.1:0", "--harness", "fake"])).toThrow(/--key-fd/);
    expect(resolve([...base, "--harness", "fake"]).key).toBe("k-from-fd");
    // Spec §2: the key arrives on an inherited fd only — never a file the sandbox might read.
    expect(() => resolve(["--listen", "tcp:127.0.0.1:0", "--key-file", "/tmp/k", "--harness", "fake"])).toThrow(/--key-file was removed/);
  });

  it("--socket-mode sets the unix socket mode", () => {
    const o = resolve(["--listen", "unix:/tmp/s.sock", "--key-fd", "3", "--harness", "fake", "--socket-mode", "0660"]);
    expect(o.listen).toEqual({ kind: "unix", path: "/tmp/s.sock", mode: 0o660 });
  });
});

