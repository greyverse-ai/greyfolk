#!/usr/bin/env node
/**
 * greyfolk CLI (spec §8). Start options come from the starter; nothing here names a greyzone.
 * Option parsing and the fail-closed rules live in `cli-options.ts`.
 */
import * as path from "node:path";
import { Agent } from "./profile/engine.js";
import { SessionStore } from "./session/store.js";
import { BearerAuth, readKeyFromFd } from "./server/auth.js";
import { parseSoul } from "./soul.js";
import { startServer } from "./server/index.js";
import { promises as fs } from "node:fs";
import { FakeHarness } from "./harness/fake.js";
import { ClaudeHarness } from "./harness/claude.js";
import { CodexHarness } from "./harness/codex.js";
import { parseArgs, resolveOptions } from "./cli-options.js";
import type { Harness, HarnessStartOptions } from "./harness/types.js";

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
  const o = resolveOptions(parseArgs(process.argv.slice(2)), { readKeyFromFd });
  const { agentDir, harnessName, execPrefix, modelPolicy, subagentProfile, resetArchiveDir } = o;
  const auth = new BearerAuth(o.key);
  const soulRead = harnessName === "fake" ? { body: "", summary: "fake harness, no soul" } : await readSoul(agentDir, o.soulOverride);
  const soul = soulRead.body;

  const harnessFactory = (sessionId: string | null): Harness => {
    if (harnessName === "fake") return new FakeHarness({ agentDir, sessionId });
    const start: HarnessStartOptions = {
      agentDir,
      soul,
      sessionId,
      harnessExec: execPrefix,
      model: null,
      subagentProfile,
      onSessionId: () => {
        /* the engine reports the session id through the `session` event; the Agent records it */
      },
    };
    if (harnessName === "claude") return new ClaudeHarness(start);
    return new CodexHarness(start);
  };

  const agent = new Agent({ harnessFactory, store: new SessionStore(agentDir), modelPolicy, resetArchiveDir });
  await agent.init();
  const server = await startServer(agent, auth, o.listen);
  process.stderr.write(`greyfolk listening on ${server.address} (harness=${harnessName}, agent=${agentDir}, soul: ${soulRead.summary})\n`);

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
