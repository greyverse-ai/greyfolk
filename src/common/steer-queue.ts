/**
 * Steers of the running turn, each waiting to settle once: `taken_in` when the engine reports the
 * model step that received it (`Turn.steerTakenIn`), `response_ended` when the turn ends (or the
 * engine refuses it) first. The engine keeps the input itself; this only settles outcomes.
 */
import type { SteerResult } from "../api/types.js";
import type { InputMessage } from "../api/input.js";

export interface QueuedSteer {
  id: string;
  input: InputMessage[];
}

export class SteerQueue {
  private readonly pending = new Map<string, (r: SteerResult) => void>();

  /** Registers a steer; the promise settles when the engine takes it in or the turn ends. */
  push(steer: QueuedSteer): Promise<SteerResult> {
    return new Promise((resolve) => this.pending.set(steer.id, resolve));
  }

  settle(id: string, result: SteerResult): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(result);
  }

  /** The turn ended: everything not taken in is `response_ended`. */
  endAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, "response_ended");
  }
}
