/**
 * A scripted harness for tests and local dry runs. No engine, no model.
 *
 * Behaviour: echoes each input item word by word ("echo: <text>") with a small delay, so
 * steer and cancel can land between model steps. Markers inside the text drive extras:
 *   [perm]  — asks a permission request (tool "Bash") before echoing and reports the decision
 *   [tool]  — emits one tool call + result after echoing
 *   [fail]  — ends the turn failed
 *   [spawn] — starts a subagent that finishes `subagentDelayMs` after the turn ended (its result
 *             arrives late, so greyfolk holds it — spec §5)
 * The session is a JSONL transcript under `<agentDir>/fake-session/<id>.jsonl`.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Harness, HarnessCapabilities, HarnessEvent, HarnessInputItem, HarnessStatus, HistoryMessage, SteerResult, SubagentResult, TurnRequest } from "./types.js";

export interface FakeHarnessOptions {
  agentDir: string;
  sessionId: string | null;
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

export class FakeHarness implements Harness {
  readonly name = "fake";
  readonly capabilities: HarnessCapabilities;
  /** The fake accepts `fake-*` model names only (so family rejection is testable). */
  readonly modelFamily = /^fake-/;
  private readonly agentDir: string;
  private sid: string | null;
  private readonly delay: number;
  private readonly model: string | null;
  private running = false;
  private cancelled = false;
  private steers: { id: string; items: HarnessInputItem[] }[] = [];
  private endedResolvers: (() => void)[] = [];
  private readonly subagentDelay: number;
  private lateListener: ((r: SubagentResult) => void) | null = null;
  private runningSubagents = new Set<string>();
  private spawnedThisTurn: string[] = [];
  /** Inputs steered so far (for assertions). */
  readonly steeredInputs: HarnessInputItem[] = [];
  /** Turns started so far (for assertions). */
  readonly turns: TurnRequest[] = [];

  constructor(opts: FakeHarnessOptions) {
    this.agentDir = opts.agentDir;
    this.sid = opts.sessionId;
    this.delay = opts.wordDelayMs ?? 5;
    this.model = opts.model ?? "fake-1";
    this.subagentDelay = opts.subagentDelayMs ?? 30;
    this.capabilities = { midTurnInput: opts.midTurnInput ?? true, permissionRequests: true, subagents: true };
  }

  async prepare(): Promise<void> {
    await fs.mkdir(path.join(this.agentDir, SESSION_DIR), { recursive: true });
  }

  private get transcriptPath(): string {
    return path.join(this.agentDir, SESSION_DIR, `${this.sid}.jsonl`);
  }

  private async record(msg: HistoryMessage): Promise<void> {
    await fs.appendFile(this.transcriptPath, `${JSON.stringify(msg)}\n`, "utf8");
  }

  async *startTurn(req: TurnRequest): AsyncIterable<HarnessEvent> {
    if (this.running) throw new Error("fake harness: a turn is already running");
    this.running = true;
    this.cancelled = false;
    this.turns.push(req);
    try {
      if (!this.sid) {
        this.sid = `fake-${randomBytes(6).toString("hex")}`;
        yield { type: "session", sessionId: this.sid };
      }
      const queue = [...req.input];
      let full = "";
      let failed = false;
      while (queue.length > 0 && !this.cancelled) {
        const item = queue.shift()!;
        await this.record({ role: item.role === "user" ? "user" : "system", text: item.text, at: new Date().toISOString() });
        if (item.text.includes("[perm]")) {
          const ac = new AbortController();
          const decision = await req.onPermissionRequest({ tool: "Bash", operation: { command: "echo perm" }, signal: ac.signal });
          const d = `permission ${decision}. `;
          full += d;
          yield { type: "text_delta", text: d };
          if (this.cancelled) break;
        }
        const words = `echo: ${item.text}`.split(" ");
        for (const w of words) {
          await sleep(this.delay);
          if (this.cancelled) break;
          const s = this.steers.shift();
          if (s) {
            yield { type: "steer_taken_in", steerId: s.id };
            full = "";
            queue.unshift(...s.items);
            break;
          }
          const d = (full ? " " : "") + w;
          full += d;
          yield { type: "text_delta", text: d };
        }
        if (this.cancelled) break;
        if (item.text.includes("[tool]")) {
          const id = `call_${randomBytes(4).toString("hex")}`;
          yield { type: "tool_call", id, name: "fake_tool", server: "fake", arguments: { text: item.text } };
          await sleep(this.delay);
          if (this.cancelled) break;
          yield { type: "tool_result", id, output: "ok", error: null };
        }
        if (item.text.includes("[spawn]")) {
          const id = `sub_${randomBytes(4).toString("hex")}`;
          this.runningSubagents.add(id);
          this.spawnedThisTurn.push(id);
          yield { type: "subagent_started", id, description: `fake subagent for: ${item.text}` };
        }
        if (item.text.includes("[fail]")) {
          failed = true;
          break;
        }
      }
      if (this.cancelled) {
        yield { type: "done", status: "cancelled", error: null, usage: null };
      } else if (failed) {
        yield { type: "done", status: "failed", error: "scripted failure", usage: null };
      } else {
        if (full) await this.record({ role: "assistant", text: full, at: new Date().toISOString() });
        yield { type: "message_done", text: full };
        yield { type: "done", status: "completed", error: null, usage: { input_tokens: 1, output_tokens: full.length, total_tokens: 1 + full.length } };
      }
    } finally {
      this.running = false;
      this.steers = [];
      for (const r of this.endedResolvers) r();
      this.endedResolvers = [];
      for (const id of this.spawnedThisTurn) {
        setTimeout(() => {
          if (!this.runningSubagents.delete(id)) return;
          this.lateListener?.({ id, status: "completed", output: `fake subagent ${id} finished` });
        }, this.subagentDelay);
      }
      this.spawnedThisTurn = [];
    }
  }

  onLateSubagentResult(listener: (result: SubagentResult) => void): void {
    this.lateListener = listener;
  }

  async steer(steerId: string, input: HarnessInputItem[]): Promise<SteerResult> {
    if (!this.running || !this.capabilities.midTurnInput || this.cancelled) return "response_ended";
    this.steers.push({ id: steerId, items: input });
    this.steeredInputs.push(...input);
    return "taken_in";
  }

  async cancel(): Promise<void> {
    if (!this.running) return;
    this.cancelled = true;
    await new Promise<void>((r) => this.endedResolvers.push(r));
  }

  status(): HarnessStatus {
    return { state: this.running ? "running" : "idle", sessionId: this.sid, subagents: { running: this.runningSubagents.size, lost: [] }, model: this.model, subagentProfile: { name: null, applied: false } };
  }

  sessionId(): string | null {
    return this.sid;
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

  async close(): Promise<void> {
    if (this.running) await this.cancel();
  }
}
