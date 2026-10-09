import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_SETTING_SOURCES, ClaudeEngine, HOST_TOOLS, NON_HOST_TOOLS } from "../src/engine/claude.js";
import { loadSubagentProfile, type SubagentProfile } from "../src/engine/subagent-profile.js";
import { TOOL_KINDS, type ToolKind } from "../src/options.js";

const notStarted = () => {
  throw new Error("not started in this test");
};

async function mk(opts: { off?: readonly ToolKind[]; profile?: SubagentProfile | null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-claude-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  const e = new ClaudeEngine({ agentDir, soul: "You are the soul.", disabledTools: new Set(opts.off ?? []), exec: [], values: new Map(), subagentProfile: opts.profile ?? null, queryFn: notStarted });
  await e.start(null);
  return { agentDir, root, e };
}

const proc = () => ({ abort: new AbortController(), child: null });
type Hook = (input: never, id: string, o: { signal: AbortSignal }) => Promise<unknown>;
const decisionOf = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
const callHook = (e: ClaudeEngine, tool_name: string, tool_input: unknown = {}, agent_id?: string) =>
  (e.preToolUse as unknown as Hook)({ hook_event_name: "PreToolUse", session_id: "s", transcript_path: "", cwd: "/", tool_name, tool_input, tool_use_id: "t", agent_id } as never, "t", { signal: new AbortController().signal });

/** Puts a fake active turn on the engine so the hook can see the turn's MCP servers. */
function activate(e: ClaudeEngine, mcp: { label: string; requireApproval: "never" | "always"; allowedTools: string[] | null }[], asked: string[] = []) {
  (e as unknown as { active: unknown }).active = {
    turn: { askPermission: async ({ tool }: { tool: string }) => (asked.push(tool), "deny") },
    mcp: new Map(mcp.map((m) => [m.label, { kind: "http", url: "http://h", headers: {}, ...m }])),
    steers: new Map(),
    end: () => {},
    cancelled: false,
    error: null,
  };
}

describe("claude engine isolation", () => {
  it("loads only the agent folder's own settings, passes the soul explicitly, and names no MCP server in its start options", async () => {
    const { agentDir, e } = await mk();
    const o = e.buildOptions(proc());
    expect(CLAUDE_SETTING_SOURCES).toEqual(["user"]);
    expect(o.settingSources).toEqual(["user"]);
    expect(o.systemPrompt).toBe("You are the soul.");
    expect(o.cwd).toBe(agentDir);
    expect(o.env?.CLAUDE_CONFIG_DIR).toBe(agentDir);
    expect(o.strictMcpConfig).toBe(true);
    // A turn's MCP servers go over the control channel (setMcpServers), so nothing reaches argv.
    expect(o.mcpServers).toBeUndefined();
    expect(o.managedSettings).toMatchObject({ autoMemoryEnabled: false });
    expect(o.tools).toBeUndefined();
    expect(e.modelFamily.test("claude-sonnet-5-5")).toBe(true);
    expect(e.modelFamily.test("gpt-5")).toBe(false);
  });

  it("turns tool kinds off one by one; with every kind off only the non-host built-ins remain", async () => {
    const partial = (await mk({ off: ["shell"] })).e.buildOptions(proc());
    expect(partial.disallowedTools).toContain("Bash");
    expect(partial.disallowedTools).not.toContain("Read");
    expect(partial.tools).toBeUndefined();
    const all = (await mk({ off: TOOL_KINDS })).e.buildOptions(proc());
    expect(all.tools).toEqual(NON_HOST_TOOLS);
    expect(all.disallowedTools).toEqual(HOST_TOOLS);
  });

  it("the PreToolUse hook enforces allowed_tools and require_approval ahead of the folder's allow rules", async () => {
    const asked: string[] = [];
    const { e } = await mk({ off: TOOL_KINDS });
    activate(e, [
      { label: "zone", requireApproval: "never", allowedTools: ["file_read"] },
      { label: "ext", requireApproval: "always", allowedTools: null },
    ], asked);
    expect(decisionOf(await callHook(e, "mcp__zone__file_read"))).toBe("allow");
    expect(decisionOf(await callHook(e, "mcp__zone__file_write"))).toBe("deny");
    expect(decisionOf(await callHook(e, "mcp__other__x"))).toBe("deny");
    expect(asked).toEqual([]);
    expect(decisionOf(await callHook(e, "mcp__ext__send"))).toBe("deny");
    expect(asked).toEqual(["mcp__ext__send"]);
    expect(decisionOf(await callHook(e, "Agent"))).toBeUndefined();
  });
});

describe("claude subagent profile (spec §5)", () => {
  async function profile(dir: string, body: object): Promise<SubagentProfile> {
    const f = path.join(dir, "worker.json");
    await fs.writeFile(f, JSON.stringify(body));
    return loadSubagentProfile(f, dir);
  }

  it("confines a profiled subagent to its named MCP tools (host tools off)", async () => {
    const { root } = await mk();
    const p = await profile(root, { name: "worker", description: "Looks things up.", mcp_tools: ["zone__file_read", "zone__file_list"] });
    const { e } = await mk({ off: TOOL_KINDS, profile: p });
    const o = e.buildOptions(proc());
    expect(o.agents?.worker?.tools).toEqual(["mcp__*"]);
    expect(e.state().subagentProfileApplied).toBe(true);
    activate(e, [{ label: "zone", requireApproval: "never", allowedTools: null }]);
    expect(decisionOf(await callHook(e, "mcp__zone__file_read", {}, "sub1"))).toBe("allow");
    expect(decisionOf(await callHook(e, "mcp__zone__file_write", {}, "sub1"))).toBe("deny");
    expect(decisionOf(await callHook(e, "mcp__zone__file_write", {}))).toBe("allow"); // main thread: not confined by the profile
  });

  it("with host tools on, confines a subagent's writes to its writable folder", async () => {
    const { root } = await mk();
    const p = await profile(root, { name: "worker", read_only: ["wiki"], writable: "scratch" });
    const { e } = await mk({ profile: p });
    expect(e.buildOptions(proc()).agents?.worker?.tools).toEqual(["Read", "Glob", "Grep", "Write", "Edit", "mcp__*"]);
    expect(decisionOf(await callHook(e, "Write", { file_path: path.join(root, "scratch", "a.md") }, "sub1"))).toBeUndefined();
    expect(decisionOf(await callHook(e, "Edit", { file_path: "/etc/hosts" }, "sub1"))).toBe("deny");
  });

  it("without a profile nothing is added; a missing profile file is refused", async () => {
    const { root, e } = await mk();
    expect(e.buildOptions(proc()).agents).toBeUndefined();
    await expect(loadSubagentProfile(path.join(root, "nope.json"), root)).rejects.toThrow(/subagent profile not found/);
  });
});
