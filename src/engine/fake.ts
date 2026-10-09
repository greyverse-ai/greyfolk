/**
 * A scripted engine for tests and local dry runs. No model.
 *
 * Echoes each input message word by word ("echo: <text>") with a small delay, so steer and
 * cancel can land between model steps. Markers inside the text drive extras:
 *   [perm]  — asks a permission request (tool "Bash") before echoing and reports the decision
 *   [tool]  — one MCP call + result after echoing
 *   [fail]  — ends the turn failed
 *   [spawn] — starts a subagent that finishes `subagentDelayMs` after the turn ended (the agent
 *             stays busy until then)
 * The session is a JSONL transcript under `<agentDir>/fake-session/<id>.jsonl`.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { HistoryMessage } from "../api/types.js";
import type { InputMessage } from "../api/input.js";
import type { QueuedSteer } from "../common/steer-queue.js";
import { usage, type Turn, type TurnEnd } from "../common/turn.js";
import type { Engine, EngineOptions, EngineState, EngineTurn } from "./engine.js";
import { registerEngine } from "./registry.js";

export interface FakeEngineOptions {
  agentDir: string;
  midTurnInput?: boolean;
  /** Delay between words (ms). */
  wordDelayMs?: number;
  /** How long after its turn ends a `[spawn]` subagent reports (ms). */
  subagentDelayMs?: number;
  model?: string | null;
}

const SESSION_DIR = "fake-session";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class FakeEngine implements Engine {
  readonly name = "fake";
  /** The fake accepts `fake-*` model names only (so family rejection is testable). */
  readonly modelFamily = /^fake-/;
  readonly canAskApproval = true;
  private readonly agentDir: string;
  private readonly midTurnInput: boolean;
  private sid: string | null = null;
  private readonly delay: number;
  private readonly model: string | null;
  private running = false;
  private cancelled = false;
  private endedResolvers: (() => void)[] = [];
  private readonly subagentDelay: number;
  private readonly runningSubagents = new Set<string>();
  private spawnedThisTurn: string[] = [];
  /** Steers handed over and not yet taken into a step. */
  private steers: { id: string; input: InputMessage[] }[] = [];
  /** Inputs steered so far (for assertions). */
  readonly steeredInputs: InputMessage[] = [];
  /** Turns started so far (for assertions). */
  readonly turns: EngineTurn[] = [];

  constructor(opts: FakeEngineOptions) {
    this.agentDir = opts.agentDir;
    this.midTurnInput = opts.midTurnInput ?? true;
    this.delay = opts.wordDelayMs ?? 5;
    this.model = opts.model ?? "fake-1";
    this.subagentDelay = opts.subagentDelayMs ?? 30;
  }

  async start(sessionId: string | null): Promise<void> {
    this.sid = sessionId;
    await fs.mkdir(path.join(this.agentDir, SESSION_DIR), { recursive: true });
  }

  private get transcriptPath(): string {
    return path.join(this.agentDir, SESSION_DIR, `${this.sid}.jsonl`);
  }

  private async note(msg: HistoryMessage): Promise<void> {
    await fs.appendFile(this.transcriptPath, `${JSON.stringify(msg)}\n`, "utf8");
  }

  async run(turn: Turn, req: EngineTurn): Promise<TurnEnd> {
    if (this.running) throw new Error("fake engine: a turn is already running");
    if (turn.cancelRequested) return { status: "cancelled", error: null, usage: null };
    this.running = true;
    this.cancelled = false;
    this.turns.push(req);
    try {
      if (!this.sid) {
        this.sid = `fake-${randomBytes(6).toString("hex")}`;
        await turn.sessionStarted(this.sid);
      }
      const queue = [...req.input];
      let full = "";
      while (queue.length > 0 && !this.cancelled) {
        const item = queue.shift()!;
        await this.note({ role: item.role === "user" ? "user" : "system", text: item.content, at: new Date().toISOString() });
        if (item.content.includes("[perm]")) {
          const decision = await turn.askPermission({ tool: "Bash", operation: { command: "echo perm" } });
          const d = `permission ${decision}. `;
          full += d;
          turn.textDelta(d);
          if (this.cancelled) break;
        }
        let steered = false;
        for (const w of `echo: ${item.content}`.split(" ")) {
          await sleep(this.delay);
          if (this.cancelled) break;
          const s = this.steers.shift();
          if (s) {
            turn.steerTakenIn(s.id);
            this.steeredInputs.push(...s.input);
            full = "";
            queue.unshift(...s.input);
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
          const id = `call_${randomBytes(4).toString("hex")}`;
          turn.mcpCallStarted(id, { server: "fake", name: "fake_tool", arguments: { text: item.content } });
          await sleep(this.delay);
          if (this.cancelled) break;
          turn.mcpCallEnded(id, "ok", null);
        }
        if (item.content.includes("[spawn]")) {
          const id = `sub_${randomBytes(4).toString("hex")}`;
          this.runningSubagents.add(id);
          this.spawnedThisTurn.push(id);
        }
        if (item.content.includes("[fail]")) return { status: "failed", error: "scripted failure", usage: null };
      }
      if (this.cancelled) return { status: "cancelled", error: null, usage: null };
      if (full) await this.note({ role: "assistant", text: full, at: new Date().toISOString() });
      turn.textDone(full);
      return { status: "completed", error: null, usage: usage(1, full.length) };
    } finally {
      this.running = false;
      for (const r of this.endedResolvers) r();
      this.endedResolvers = [];
      this.steers = [];
      for (const id of this.spawnedThisTurn) setTimeout(() => this.runningSubagents.delete(id), this.subagentDelay);
      this.spawnedThisTurn = [];
    }
  }

  async steer(_turn: Turn, steer: QueuedSteer): Promise<boolean> {
    if (!this.running || !this.midTurnInput || this.cancelled) return false;
    this.steers.push(steer); // taken at the next word
    return true;
  }

  async cancel(): Promise<void> {
    if (!this.running) return;
    this.cancelled = true;
    await new Promise<void>((r) => this.endedResolvers.push(r));
  }

  state(): EngineState {
    return { running: this.running, sessionId: this.sid, model: this.model, subagents: { running: this.runningSubagents.size, lost: [] }, subagentProfileApplied: false };
  }

  async history(): Promise<HistoryMessage[]> {
    if (!this.sid) return [];
    try {
      const raw = await fs.readFile(this.transcriptPath, "utf8");
      return raw
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as HistoryMessage);
    } catch {
      return [];
    }
  }

  exportExcludes(): string[] {
    return [`${SESSION_DIR}/*.index`];
  }

  sessionPaths(): string[] {
    return [SESSION_DIR];
  }

  async stop(): Promise<void> {
    if (this.running) await this.cancel();
  }
}

registerEngine({ name: "fake", needsSoul: false, create: (o: EngineOptions) => new FakeEngine({ agentDir: o.agentDir }) });
