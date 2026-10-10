/**
 * `GET /health`: the agent's state in the common health check format for HTTP APIs
 * (`application/health+json`, draft-inadarei-api-health-check). Busy is not unhealthy.
 */
import { createRequire } from "node:module";
import type { AgentState } from "../api/types.js";
import type { Limits } from "../api/limits.js";

/** This greyfolk's version: its package version, which is its GitHub release tag without the `v`. */
export const VERSION = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;

export const HEALTH_CONTENT_TYPE = "application/health+json";

/**
 * The engine account's own usage limits ride in the same health check (`engine:limits`, warn while a
 * limit is reached), not an endpoint of greyfolk's own (intent: agent/operations).
 */
export function toHealth(s: AgentState, limits: Limits | null = null) {
  const check = (observedValue: unknown, observedUnit?: string) => [{ componentType: "component", observedValue, ...(observedUnit ? { observedUnit } : {}), status: "pass" }];
  return {
    status: "pass",
    version: VERSION.split(".")[0],
    releaseId: VERSION,
    serviceId: "greyfolk",
    description: `one agent on the ${s.engine} engine`,
    checks: {
      "agent:busy": check(s.busy),
      "agent:response": check(s.response_id),
      "agent:subagents": check(s.subagents, "running"),
      "agent:approvals": check(s.approvals),
      "engine:conversation": check({ engine: s.engine, model: s.model, conversation: s.conversation }),
      ...(limits ? { "engine:limits": [{ componentType: "component", observedValue: limits, status: limits.blocked ? "warn" : "pass", time: new Date(limits.observed_at * 1000).toISOString() }] } : {}),
    },
  };
}
