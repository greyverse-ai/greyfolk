/**
 * The sample engine: how an engine is written (an example, not shipped — `engine/index.ts` does not
 * list it, so it registers only where it is imported, as in the tests). No model, no SDK. Echoes each input message word by
 * word ("echo: <text>") so steer and cancel can land between steps. Markers in the text:
 *   [tool]    one MCP call (server "sample") and its result
 *   [approve] asks approval before an MCP call to server "ext", then reports the answer
 *   [fail]    ends the turn failed
 *   [spawn]   a native subagent that runs `subagentDelayMs` past the turn (the agent stays busy)
 */
import { randomBytes } from "node:crypto";
import type { InputMessage } from "../api/input.js";
import { usage, type Turn, type TurnEnd } from "../service/turn.js";
import type { ConversationMessage, Engine, EngineState, EngineTurn } from "./engine.js";
import { registerEngine } from "./registry.js";

export interface SampleEngineOptions {
  midTurnInput?: boolean;
  wordDelayMs?: number;
  subagentDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SampleEngine implements Engine {
  readonly name = "sample";
  readonly modelFamily = /^sample-/;
  readonly canAskApproval = true;
  get canSteer(): boolean {
    return this.midTurnInput;
  }
  /** Conversations (the sample's own sessions). */
  readonly sessions = new Map<string, ConversationMessage[]>();
  readonly turns: EngineTurn[] = [];
  private current: string | null = null;
  private running = false;
  private cancelled = false;
  private steers: { id: string; input: InputMessage[] }[] = [];
  private subagents = 0;
  private readonly midTurnInput: boolean;
  private readonly delay: number;
  private readonly subagentDelay: number;

  constructor(opts: SampleEngineOptions = {}) {
    this.midTurnInput = opts.midTurnInput ?? true;
    this.delay = opts.wordDelayMs ?? 5;
    this.subagentDelay = opts.subagentDelayMs ?? 30;
  }

  async start(): Promise<void> {}

  async run(turn: Turn, req: EngineTurn): Promise<TurnEnd> {
    if (turn.cancelRequested) return { status: "cancelled", error: null, usage: null };
    this.running = true;
    this.cancelled = false;
    this.turns.push(req);
    try {
      const id = req.conversation ?? `conv_sample_${randomBytes(6).toString("hex")}`;
      if (!this.sessions.has(id)) this.sessions.set(id, []);
      this.current = id;
      turn.conversationStarted(id);
      const log = this.sessions.get(id)!;
      const queue = [...req.input];
      let full = "";
      while (queue.length && !this.cancelled) {
        const item = queue.shift()!;
        log.push({ role: "user", text: item.content });
        let steered = false;
        for (const w of `echo: ${item.content}`.split(" ")) {
          await sleep(this.delay);
          if (this.cancelled) break;
          const s = this.steers.shift();
          if (s) {
            turn.steerTakenIn(s.id);
            queue.unshift(...s.input);
            full = "";
            steered = true;
            break;
          }
          const d = (full ? " " : "") + w;
          full += d;
          turn.textDelta(d);
        }
        if (this.cancelled) break;
        if (steered) continue;
        if (item.content.includes("[tool]")) {
          const call = `call_${randomBytes(4).toString("hex")}`;
          turn.mcpCallStarted(call, { server: "sample", name: "sample_tool", arguments: { text: item.content } });
          await sleep(this.delay);
          turn.mcpCallEnded(call, "ok", null);
        }
        if (item.content.includes("[approve]")) {
          const ok = await turn.requestApproval({ server: "ext", name: "send", arguments: { text: item.content } });
          if (this.cancelled) break;
          full += ` approval ${ok ? "yes" : "no"}.`;
          turn.textDelta(` approval ${ok ? "yes" : "no"}.`);
        }
        if (item.content.includes("[spawn]")) {
          this.subagents++;
          setTimeout(() => this.subagents--, this.subagentDelay);
        }
        if (item.content.includes("[fail]")) return { status: "failed", error: "scripted failure", usage: null };
      }
      if (this.cancelled) return { status: "cancelled", error: null, usage: null };
      log.push({ role: "assistant", text: full });
      turn.textDone(full);
      return { status: "completed", error: null, usage: usage(1, full.length) };
    } finally {
      this.running = false;
      this.steers = [];
    }
  }

  async steer(_turn: Turn, id: string, input: InputMessage[]): Promise<boolean> {
    if (!this.running || !this.midTurnInput || this.cancelled) return false;
    this.steers.push({ id, input });
    return true;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  state(): EngineState {
    return { running: this.running, conversation: this.current, model: "sample-1", subagents: this.subagents };
  }

  async conversation(id: string): Promise<ConversationMessage[] | null> {
    return this.sessions.get(id) ?? null;
  }

  async stop(): Promise<void> {
    this.cancelled = true;
  }
}

registerEngine({ name: "sample", create: () => new SampleEngine() });
