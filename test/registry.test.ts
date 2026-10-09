import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { registerEngine, getEngine, engineNames } from "../src/engine/registry.js";
import { AgentService } from "../src/service/agent-service.js";
import { defaultToolAttacher } from "../src/mcp/translate.js";
import type { Engine } from "../src/engine/engine.js";
import { usage } from "../src/common/turn.js";
import { collectChain, req, textOf } from "./helpers.js";
import "../src/engine/index.js";

/**
 * A whole new engine in one place: the strategy plus one registration line. Nothing in the
 * service, the controller or the other engines changes for it.
 */
class ShoutEngine implements Engine {
  readonly name = "shout";
  readonly modelFamily = /^shout-/;
  readonly canAskApproval = false;
  async start(): Promise<void> {}
  async run(turn: Parameters<Engine["run"]>[0], r: Parameters<Engine["run"]>[1]) {
    turn.textDone(r.input.map((i) => i.content.toUpperCase()).join(" "));
    return { status: "completed" as const, error: null, usage: usage(1, 1) };
  }
  async steer() {
    return false;
  }
  async cancel() {}
  onLateSubagentResult() {}
  state() {
    return { running: false, sessionId: null, model: "shout-1", subagents: { running: 0, lost: [] }, subagentProfileApplied: false };
  }
  async history() {
    return [];
  }
  exportExcludes() {
    return [];
  }
  sessionPaths() {
    return [];
  }
  async stop() {}
}

describe("engine registry", () => {
  it("lists the shipped engines", () => {
    expect(engineNames()).toEqual(expect.arrayContaining(["fake", "claude", "codex"]));
    expect(() => getEngine("nope")).toThrow(/unknown engine/);
  });

  it("a new engine is one strategy plus one registration, and runs through the unchanged service", async () => {
    registerEngine({ name: "shout", needsSoul: false, create: () => new ShoutEngine() });
    expect(() => registerEngine({ name: "shout", needsSoul: false, create: () => new ShoutEngine() })).toThrow(/twice/);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-reg-"));
    const agentDir = path.join(root, "agent");
    await fs.mkdir(agentDir);
    const def = getEngine("shout");
    const agent = new AgentService({ createEngine: () => def.create({ agentDir, soul: "", disabledTools: new Set(), exec: [], values: new Map(), subagentProfile: null }), agentDir, modelPolicy: "fixed", resetArchiveDir: path.join(root, "archive"), attachTools: defaultToolAttacher() });
    await agent.init();
    const r = await agent.create(req("hello there"));
    expect(textOf((await collectChain(agent, r.id)).last)).toBe("HELLO THERE");
    expect(agent.status().engine).toBe("shout");
  });
});
