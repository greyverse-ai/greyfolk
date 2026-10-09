/**
 * In-memory log of responses and their event streams, for streaming and re-attach
 * (spec §2 "Re-attach": `GET /v1/responses/{id}` with resumable streaming).
 *
 * A turn is a chain of responses; each response keeps its own event log with per-response
 * sequence numbers. Subscribers get replay from `starting_after` and then live events.
 */
import { randomBytes } from "node:crypto";
import type { AgentResponse, StreamEvent, StreamListener, UnnumberedEvent } from "../api/types.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/** A fresh response object with the SDK's required fields at greyfolk's values. */
export function newResponse(fields: Pick<AgentResponse, "instructions" | "model" | "tools" | "metadata"> & { background: boolean; previous_response_id: string | null }): AgentResponse {
  return {
    id: newId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    completed_at: null,
    status: "in_progress",
    error: null,
    incomplete_details: null,
    output: [],
    output_text: "",
    usage: undefined,
    parallel_tool_calls: false,
    temperature: null,
    top_p: null,
    tool_choice: "auto",
    access_programs: null,
    ...fields,
  };
}

export class ResponseRecord {
  readonly events: StreamEvent[] = [];
  private readonly subscribers = new Set<StreamListener>();
  private seq = 0;
  /** Set when a successor response continues the same turn (steer). */
  nextResponseId: string | null = null;
  readonly turnId: string;
  response: AgentResponse;

  constructor(response: AgentResponse, turnId: string) {
    this.response = response;
    this.turnId = turnId;
  }

  get id(): string {
    return this.response.id;
  }

  get ended(): boolean {
    return this.response.status !== "in_progress";
  }

  /** A deep copy of the response object, safe to put on the wire. */
  snapshot(): AgentResponse {
    return structuredClone(this.response);
  }

  emit(event: UnnumberedEvent): StreamEvent {
    const numbered = { ...event, sequence_number: this.seq++ } as StreamEvent;
    this.events.push(numbered);
    for (const s of this.subscribers) s(numbered);
    return numbered;
  }

  subscribe(startingAfter: number, sub: StreamListener): () => void {
    for (const ev of this.events) if (ev.sequence_number > startingAfter) sub(ev);
    if (this.ended) return () => {};
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }
}

export class ResponseLog {
  private readonly records = new Map<string, ResponseRecord>();
  private latestTurnId: string | null = null;
  private readonly turnMembers = new Map<string, string[]>();

  create(response: AgentResponse, turnId: string): ResponseRecord {
    const rec = new ResponseRecord(response, turnId);
    this.records.set(response.id, rec);
    this.latestTurnId = turnId;
    const members = this.turnMembers.get(turnId) ?? [];
    members.push(response.id);
    this.turnMembers.set(turnId, members);
    return rec;
  }

  get(id: string): ResponseRecord | undefined {
    return this.records.get(id);
  }

  /** The id of the newest response (the end of the latest turn's chain), or null. */
  latestResponseId(): string | null {
    const turn = this.latestTurn();
    return turn ? (turn.responses.at(-1) ?? null) : null;
  }

  latestTurn(): { id: string; responses: string[] } | null {
    if (!this.latestTurnId) return null;
    return { id: this.latestTurnId, responses: this.turnMembers.get(this.latestTurnId) ?? [] };
  }

  /** Streams a response and, after it ends `incomplete` (steered), its successors in the same turn. */
  subscribeChain(responseId: string, startingAfter: number, listener: StreamListener): (() => void) | null {
    const first = this.records.get(responseId);
    if (!first) return null;
    let unsub: () => void = () => {};
    let active = true;
    const attach = (rec: ResponseRecord, after: number): void => {
      unsub = rec.subscribe(after, (ev) => {
        if (!active) return;
        listener(ev);
        if (ev.type === "response.incomplete" && rec.nextResponseId) {
          const next = this.records.get(rec.nextResponseId);
          if (next) queueMicrotask(() => active && attach(next, -1));
        }
      });
    };
    attach(first, startingAfter);
    return () => {
      active = false;
      unsub();
    };
  }
}
