#!/usr/bin/env node
/**
 * greyfolk CLI (spec §8). Start options come from the starter; nothing here names a greyzone.
 * Option parsing and the fail-closed rules live in `cli-options.ts`.
 */
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { AgentService } from "./service/agent-service.js";
import { BearerAuth, readKeyFromFd } from "./server/auth.js";
import { parseSoul } from "./soul.js";
import { startServer } from "./server/index.js";
import { resolveOptions } from "./cli-options.js";
import { CORE_OPTIONS, formatHelp, parseArgv, withDefaults } from "./options.js";
import { engineNames, engineOptions, getEngine } from "./engine/registry.js";
import { loadSubagentProfile } from "./engine/subagent-profile.js";
import { defaultToolAttacher } from "./mcp/translate.js";
import "./engine/index.js";

/**
 * The soul: the agent's instruction file in the folder (spec §1). Its metadata header is parsed and
 * validated (a malformed header refuses the start); only the Markdown body becomes the system prompt.
 */
async function readSoul(agentDir: string, override: string | undefined): Promise<{ body: string; summary: string }> {
  const candidates = override ? [path.resolve(agentDir, override)] : [path.join(agentDir, "AGENTS.md"), path.join(agentDir, "CLAUDE.md")];
  for (const f of candidates) {
    const text = await fs.readFile(f, "utf8").catch(() => null);
    if (text === null) continue;
    let soul;
    try {
      soul = parseSoul(text);
    } catch (e) {
      throw new Error(`soul ${f}: ${(e as Error).message}`);
    }
    const m = soul.metadata;
    const summary = soul.hasHeader ? `name=${m.name ?? "-"} version=${m.version ?? "-"} author=${m.author ?? "-"}` : "no metadata header";
    return { body: soul.body, summary };
  }
  throw new Error(`no soul found in ${agentDir} (expected AGENTS.md or CLAUDE.md, or pass --soul FILE)`);
}

async function main(): Promise<void> {
  const specs = [...CORE_OPTIONS, ...engineOptions()];
  const given = parseArgv(process.argv.slice(2), specs);
  if (given.get("help") === true) {
    process.stdout.write(`${formatHelp(specs, engineNames())}\n`);
    return;
  }
  const o = resolveOptions(withDefaults(specs, given), { readKeyFromFd }, engineNames());
  const def = getEngine(o.engine);
  const auth = new BearerAuth(o.key);
  const soulRead = def.needsSoul ? await readSoul(o.agentDir, o.soulOverride) : { body: "", summary: `${o.engine} engine, no soul` };
  const subagentProfile = o.subagentProfile ? await loadSubagentProfile(o.subagentProfile, o.agentDir) : null;
  const startOptions = { agentDir: o.agentDir, soul: soulRead.body, disabledTools: new Set(o.disabledTools), exec: o.engineExec, values: o.values, subagentProfile };

  const agent = new AgentService({
    createEngine: () => def.create(startOptions),
    agentDir: o.agentDir,
    modelPolicy: o.modelPolicy,
    resetArchiveDir: o.resetArchiveDir,
    subagentProfileName: subagentProfile?.name ?? null,
    attachTools: defaultToolAttacher(),
  });
  await agent.init();
  const server = await startServer(agent, auth, o.listen);
  process.stderr.write(`greyfolk listening on ${server.address} (engine=${o.engine}, tools off: ${o.disabledTools.join(",") || "none"}, agent=${o.agentDir}, soul: ${soulRead.summary})\n`);

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
