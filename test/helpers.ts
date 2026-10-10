import { AgentService, type ModelPolicy } from "../src/service/agent.js";
import { FakeEngine } from "../src/engine/fake.js";
import type { AgentResponse, StreamEvent } from "../src/api/types.js";
import { TERMINAL_EVENTS } from "../src/api/types.js";

export async function tmpAgent(opts: { midTurnInput?: boolean; wordDelayMs?: number; modelPolicy?: ModelPolicy } = {}) {
  const engine = new FakeEngine({ midTurnInput: opts.midTurnInput, wordDelayMs: opts.wordDelayMs ?? 5 });
  const agent = new AgentService({ engine, modelPolicy: opts.modelPolicy ?? "fixed" });
  await agent.init();
  return { agent, engine };
}

/** A `POST /v1/responses` body. */
export function req(input: unknown, extra: Record<string, unknown> = {}) {
  return { input, stream: true, ...extra } as never;
}

/** Collects a response's events until the chain ends (a steered `incomplete` continues). */
export function collectChain(agent: AgentService, id: string): Promise<{ events: StreamEvent[]; last: AgentResponse }> {
  return new Promise((resolve) => {
    const events: StreamEvent[] = [];
    const unsub = agent.stream(id, -1, (ev) => {
      events.push(ev);
      if (!TERMINAL_EVENTS.has(ev.type)) return;
      const r = (ev as { response: AgentResponse }).response;
      if (ev.type === "response.incomplete" && r.incomplete_details?.reason === "steered") return;
      queueMicrotask(() => unsub());
      resolve({ events, last: r });
    });
  });
}

export function textOf(r: AgentResponse): string {
  return r.output
    .filter((o) => o.type === "message")
    .map((m) => (m.type === "message" && m.content[0]?.type === "output_text" ? m.content[0].text : ""))
    .join("");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
