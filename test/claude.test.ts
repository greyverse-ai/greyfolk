import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_SETTING_SOURCES, ClaudeHarness, type LiveTurn } from "../src/harness/claude.js";

describe("claude harness isolation", () => {
  it("loads only the agent folder's own settings and passes the soul explicitly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-claude-"));
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir);
    const h = new ClaudeHarness({
      agentDir,
      soul: "You are the soul.",
      sessionId: null,
      harnessExec: ["/usr/bin/env"],
      model: null,
      subagentProfile: null,
      onSessionId: () => {},
      queryFn: () => {
        throw new Error("not started in this test");
      },
    });
    await h.prepare();
    const turn: LiveTurn = { query: null as unknown as Query, input: null as never, abort: new AbortController(), child: null, pendingSteers: [], resultSeen: false, pendingEvents: [] };
    const o = h.buildOptions({ responseId: "r1", input: [{ role: "user", text: "hi" }], instructions: null, model: null, mcp: [], onPermissionRequest: async () => "deny" }, turn);
    // Spec §3: no project/local settings, no CLAUDE.md / .mcp.json auto-load; only <agent>/settings.json via CLAUDE_CONFIG_DIR.
    expect(CLAUDE_SETTING_SOURCES).toEqual(["user"]);
    expect(o.settingSources).toEqual(["user"]);
    expect(o.settingSources).not.toContain("project");
    expect(o.settingSources).not.toContain("local");
    expect(o.systemPrompt).toBe("You are the soul.");
    expect(o.cwd).toBe(agentDir);
    expect(o.env?.CLAUDE_CONFIG_DIR).toBe(agentDir);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.managedSettings).toMatchObject({ autoMemoryEnabled: false });
    expect(h.modelFamily.test("claude-sonnet-5-5")).toBe(true);
    expect(h.modelFamily.test("gpt-5")).toBe(false);
  });
});

describe("claude subagent profile (spec §5)", () => {
  const mk = async (profile: string | null) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-claude-prof-"));
    const agentDir = path.join(root, "agent");
    await fs.mkdir(path.join(agentDir, "subagent-profiles"), { recursive: true });
    await fs.writeFile(path.join(agentDir, "subagent-profiles", "worker.json"), JSON.stringify({ description: "Looks things up.", read_only: ["wiki"], writable: "scratch" }));
    const h = new ClaudeHarness({ agentDir, soul: "soul", sessionId: null, harnessExec: ["/usr/bin/env"], model: null, subagentProfile: profile, onSessionId: () => {}, queryFn: () => { throw new Error("not started"); } });
    return { agentDir, h };
  };
  const turn = (): LiveTurn => ({ query: null as unknown as Query, input: null as never, abort: new AbortController(), child: null, pendingSteers: [], resultSeen: false, pendingEvents: [] });
  const req = { responseId: "r1", input: [{ role: "user" as const, text: "hi" }], instructions: null, model: null, mcp: [], onPermissionRequest: async () => "deny" as const };

  it("applies the profile: agent definition with read-only paths, one writable folder, no MCP tools; status says applied", async () => {
    const { agentDir, h } = await mk("worker");
    await h.prepare();
    const o = h.buildOptions(req, turn());
    const def = o.agents?.worker;
    expect(def).toBeDefined();
    expect(def!.tools).not.toContain("Bash");
    expect(def!.disallowedTools).toEqual(["mcp__*"]);
    expect(def!.prompt).toContain(path.join(agentDir, "scratch"));
    expect(def!.prompt).toContain(path.join(agentDir, "wiki"));
    expect(h.status().subagentProfile).toEqual({ name: "worker", applied: true });
    // The PreToolUse guard confines every subagent's writes to the writable folder and refuses MCP tools.
    const guard = o.hooks?.PreToolUse?.[0]?.hooks[0]!;
    const call = (tool_name: string, tool_input: unknown, agent_id?: string) =>
      guard({ hook_event_name: "PreToolUse", session_id: "s", transcript_path: "", cwd: agentDir, tool_name, tool_input, tool_use_id: "t", agent_id } as never, "t", { signal: new AbortController().signal });
    const deny = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
    expect(deny(await call("Write", { file_path: path.join(agentDir, "scratch", "a.md") }, "sub1"))).toBeUndefined();
    expect(deny(await call("Write", { file_path: path.join(agentDir, "wiki", "a.md") }, "sub1"))).toBe("deny");
    expect(deny(await call("Edit", { file_path: "/etc/hosts" }, "sub1"))).toBe("deny");
    expect(deny(await call("mcp__x__tool", {}, "sub1"))).toBe("deny");
    expect(deny(await call("Read", { file_path: "/etc/hosts" }, "sub1"))).toBeUndefined();
    expect(deny(await call("Write", { file_path: "/etc/hosts" }))).toBeUndefined(); // main thread: not confined by the profile
  });

  it("without a profile nothing is added; a missing profile file refuses the start", async () => {
    const { h } = await mk(null);
    await h.prepare();
    const o = h.buildOptions(req, turn());
    expect(o.agents).toBeUndefined();
    expect(o.hooks?.PreToolUse).toBeUndefined();
    expect(h.status().subagentProfile).toEqual({ name: null, applied: false });
    const { h: h2 } = await mk("nope");
    await expect(h2.prepare()).rejects.toThrow(/subagent profile 'nope' not found/);
  });
});
