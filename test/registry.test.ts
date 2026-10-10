import { describe, expect, it } from "vitest";
import { engineNames, getEngine, registerEngine } from "../src/engine/registry.js";
import { AgentService } from "../src/service/agent.js";
import type { Engine } from "../src/engine/engine.js";
import { usage } from "../src/service/turn.js";
import { collectChain, req, textOf } from "./helpers.js";
import "../src/engine/index.js";

/** A whole new engine: one strategy and one registration; nothing else changes. */
class ShoutEngine implements Engine {
  readonly name = "shout";
  readonly modelFamily = /^shout-/;
  readonly canAskApproval = false;
  readonly canSteer = false;
  async start() {}
  async run(turn: Parameters<Engine["run"]>[0], r: Parameters<Engine["run"]>[1]) {
    turn.textDone(r.input.map((i) => i.content.toUpperCase()).join(" "));
    return { status: "completed" as const, error: null, usage: usage(1, 1) };
  }
  async steer() {
    return false;
  }
  async cancel() {}
  state() {
    return { running: false, conversation: null, model: "shout-1", subagents: 0 };
  }
  async conversation() {
    return null;
  }
  async stop() {}
}

describe("engine registry", () => {
  it("a new engine is one strategy plus one registration and runs through the unchanged service", async () => {
    expect(engineNames()).toEqual(expect.arrayContaining(["claude", "codex"]));
    registerEngine({ name: "shout", create: () => new ShoutEngine() });
    const agent = new AgentService({ engine: getEngine("shout").create({ agentDir: "/", engineArgs: [], exec: [], values: new Map() }), modelPolicy: "fixed" });
    const r = await agent.create(req("hello there"));
    expect(textOf((await collectChain(agent, r.id)).last)).toBe("HELLO THERE");
  });
});
