/**
 * Permission-request bridge (spec §2 `greyfolk.permission_request`): an engine's tool-permission
 * question becomes a stream event; the caller's `POST /greyfolk/permissions/{id}` answers it.
 */
import type { PermissionDecision } from "../api/types.js";
import { ApiError } from "../api/errors.js";
import { newId } from "./response-log.js";

interface Pending {
  id: string;
  responseId: string;
  turnId: string;
  resolve: (d: PermissionDecision) => void;
}

export interface PermissionAsk {
  responseId: string;
  turnId: string;
  signal?: AbortSignal;
  /** Puts the request on the stream once it has an id. */
  announce: (id: string) => void;
}

export class PermissionBridge {
  private readonly pending = new Map<string, Pending>();

  ask(req: PermissionAsk): Promise<PermissionDecision> {
    return new Promise((resolve) => {
      const id = newId("perm");
      this.pending.set(id, { id, responseId: req.responseId, turnId: req.turnId, resolve });
      req.signal?.addEventListener("abort", () => {
        if (this.pending.delete(id)) resolve("deny");
      });
      req.announce(id);
    });
  }

  decide(id: string, decision: PermissionDecision): { id: string; decision: PermissionDecision } {
    const p = this.pending.get(id);
    if (!p) throw ApiError.notFound(`Permission request '${id}' is not waiting.`, "id");
    this.pending.delete(id);
    p.resolve(decision);
    return { id, decision };
  }

  /** Denies every request still waiting in the turn (it ended or was cancelled). */
  denyTurn(turnId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.turnId !== turnId) continue;
      this.pending.delete(p.id);
      p.resolve("deny");
    }
  }

  list(): { id: string; response_id: string }[] {
    return [...this.pending.values()].map((p) => ({ id: p.id, response_id: p.responseId }));
  }
}
