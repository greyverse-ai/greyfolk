/**
 * In-memory record of responses and their event streams, for streaming and re-attach
 * (spec §2 "Re-attach": `GET /v1/responses/{id}` with resumable streaming).
 *
 * A turn is a chain of responses; each response keeps its own event log with per-response
 * sequence numbers. Subscribers get replay from `starting_after` and then live events.
 */
import { randomBytes } from "node:crypto";
import type { ResponseObject, StreamEvent } from "./types.js";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export type Subscriber = (event: StreamEvent) => void;

export class ResponseRecord {
  readonly events: StreamEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private seq = 0;
  /** Set when a successor response continues the same turn (steer). */
  nextResponseId: string | null = null;
  readonly turnId: string;
  response: ResponseObject;

  constructor(response: ResponseObject, turnId: string) {
    this.response = response;
    this.turnId = turnId;
  }

  get id(): string {
    return this.response.id;
  }

  get ended(): boolean {
    return this.response.status !== "in_progress";
  }

  emit(type: string, data: Record<string, unknown>): StreamEvent {
    const event: StreamEvent = { type, sequence_number: this.seq++, ...data };
    this.events.push(event);
    for (const s of this.subscribers) s(event);
    return event;
  }

  subscribe(startingAfter: number, sub: Subscriber): () => void {
    for (const ev of this.events) if (ev.sequence_number > startingAfter) sub(ev);
    if (this.ended) return () => {};
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }
}

export class ResponseStore {
  private readonly records = new Map<string, ResponseRecord>();
  private latestTurnId: string | null = null;
  private readonly turnMembers = new Map<string, string[]>();

  create(response: ResponseObject, turnId: string): ResponseRecord {
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

  /** True when `id` belongs to the latest turn (any response of its chain). */
  isInLatestTurn(id: string): boolean {
    const rec = this.records.get(id);
    return !!rec && rec.turnId === this.latestTurnId;
  }

  latestTurn(): { id: string; responses: string[] } | null {
    if (!this.latestTurnId) return null;
    return { id: this.latestTurnId, responses: this.turnMembers.get(this.latestTurnId) ?? [] };
  }

  /** Records a response that was running when a previous instance died. */
  registerFailed(id: string, message: string): void {
    if (this.records.has(id)) return;
    const now = Math.floor(Date.now() / 1000);
    const response: ResponseObject = {
      id,
      object: "response",
      created_at: now,
      completed_at: now,
      status: "failed",
      error: { code: "instance_stopped", message },
      incomplete_details: null,
      instructions: null,
      model: "",
      output: [],
      previous_response_id: null,
      tools: [],
      usage: null,
      background: false,
      metadata: {},
    };
    const rec = new ResponseRecord(response, id);
    rec.emit("response.failed", { response });
    this.records.set(id, rec);
  }
}
