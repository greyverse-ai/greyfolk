#!/usr/bin/env node
/**
 * greyfolk CLI (spec §8). Start options come from the starter; nothing here names a greyzone.
 * Option parsing and the fail-closed rules live in `cli-options.ts`.
 */
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { AgentService } from "./service/agent.js";
import { BearerAuth, readKeyFromFd } from "./server/auth.js";
import { startServer } from "./server/index.js";
import { resolveOptions } from "./cli-options.js";
import { CORE_OPTIONS, formatHelp, parseArgv, splitEngineArgs, withDefaults } from "./options.js";
import { engineNames, getEngine } from "./engine/registry.js";
import "./engine/index.js";

/** `--soul FILE`: a file added, as it is, to the engine's own instructions (the engine reads the folder's AGENTS.md / CLAUDE.md itself). */
async function readExtraInstructions(agentDir: string, file: string | undefined): Promise<{ text: string | null; summary: string }> {
  if (!file) return { text: null, summary: "the engine's own" };
  const f = path.resolve(agentDir, file);
  return { text: await fs.readFile(f, "utf8"), summary: `${f} added` };
}

async function main(): Promise<void> {
  const specs = CORE_OPTIONS;
  const { own, engine: engineArgs } = splitEngineArgs(process.argv.slice(2));
  const given = parseArgv(own, specs);
  if (given.get("help") === true) {
    process.stdout.write(`${formatHelp(specs, engineNames())}\n`);
    return;
  }
  if (given.get("engines") === true) {
    process.stdout.write(`${engineNames().join("\n")}\n`);
    return;
  }
  const o = resolveOptions(withDefaults(specs, given), { readKeyFromFd }, engineNames(), engineArgs);
  const def = getEngine(o.engine);
  const auth = new BearerAuth(o.key);
  const extra = await readExtraInstructions(o.agentDir, o.soulOverride);
  const agent = new AgentService({
    engine: def.create({ agentDir: o.agentDir, extraInstructions: extra.text, engineArgs: o.engineArgs, exec: o.engineExec, values: o.values }),
    modelPolicy: o.modelPolicy,
  });
  await agent.init();
  const server = await startServer(agent, auth, o.listen);
  process.stderr.write(`greyfolk listening on ${server.address} (engine=${o.engine}, engine options: ${o.engineArgs.join(" ") || "none"}, agent=${o.agentDir}, instructions: ${extra.summary})\n`);

  const shutdown = async (): Promise<void> => {
    await server.close();
    await agent.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  process.stderr.write(`greyfolk: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
