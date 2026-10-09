import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "../src/profile/engine.js";
import { FakeHarness } from "../src/harness/fake.js";
import { SessionStore } from "../src/session/store.js";
import type { StreamEvent } from "../src/profile/types.js";
import type { ResponseRecord } from "../src/profile/responses.js";

export async function tmpAgent(opts: { midTurnInput?: boolean; wordDelayMs?: number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir);
  let harness: FakeHarness | null = null;
  const agent = new Agent({
    harnessFactory: (sessionId) => {
      harness = new FakeHarness({ agentDir, sessionId, midTurnInput: opts.midTurnInput, wordDelayMs: opts.wordDelayMs ?? 5 });
      return harness;
    },
    store: new SessionStore(agentDir),
    modelPolicy: "fixed",
    resetArchiveDir: path.join(root, "archive"),
  });
  await agent.init();
  return { agent, agentDir, root, harness: () => harness! };
}

export function req(input: unknown, extra: Record<string, unknown> = {}) {
  return { model: null, input, instructions: null, previous_response_id: null, tools: [], stream: true, background: false, metadata: {}, deliver_held: [], ...extra };
}

export function collectChain(agent: Agent, id: string): Promise<{ events: StreamEvent[]; last: ResponseRecord }> {
  return new Promise((resolve) => {
    const events: StreamEvent[] = [];
    const unsub = agent.subscribeChain(id, -1, (rec, ev) => {
      events.push(ev);
      if (ev.type === "response.completed" || ev.type === "response.failed" || ev.type === "response.cancelled") {
        queueMicrotask(unsub);
        resolve({ events, last: rec });
      }
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
