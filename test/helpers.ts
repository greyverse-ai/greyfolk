import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentService, type ModelPolicy } from "../src/service/agent-service.js";
import { FakeEngine } from "../src/engine/fake.js";
import { defaultToolAttacher } from "../src/mcp/translate.js";
import type { AgentResponse, StreamEvent } from "../src/api/types.js";

export async function tmpAgent(opts: { midTurnInput?: boolean; wordDelayMs?: number; modelPolicy?: ModelPolicy; agentDir?: string; root?: string } = {}) {
  const root = opts.root ?? (await fs.mkdtemp(path.join(os.tmpdir(), "greyfolk-")));
  const agentDir = opts.agentDir ?? path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  let engine: FakeEngine | null = null;
  const agent = new AgentService({
    createEngine: () => {
      engine = new FakeEngine({ agentDir, midTurnInput: opts.midTurnInput, wordDelayMs: opts.wordDelayMs ?? 5 });
      return engine;
    },
    agentDir,
    modelPolicy: opts.modelPolicy ?? "fixed",
    resetArchiveDir: path.join(root, "archive"),
    attachTools: defaultToolAttacher(),
  });
  await agent.init();
  return { agent, agentDir, root, engine: () => engine! };
}

/** A `POST /v1/responses` body. */
export function req(input: unknown, extra: Record<string, unknown> = {}) {
  return { input, stream: true, ...extra } as never;
}

/** Collects the chain's events until a terminal event; `last` is the terminal response. */
export function collectChain(agent: AgentService, id: string): Promise<{ events: StreamEvent[]; last: AgentResponse }> {
  return new Promise((resolve) => {
    const events: StreamEvent[] = [];
    const unsub = agent.stream(id, -1, (ev) => {
      events.push(ev);
      if (ev.type === "response.completed" || ev.type === "response.failed" || ev.type === "response.cancelled") {
        queueMicrotask(() => unsub());
        resolve({ events, last: (ev as { response: AgentResponse }).response });
      }
    });
  });
}

export function textOf(r: AgentResponse): string {
  const msg = r.output.find((o) => o.type === "message");
  if (!msg || msg.type !== "message") return "";
  const part = msg.content[0];
  return part && part.type === "output_text" ? part.text : "";
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
