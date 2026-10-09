/**
 * `GET /health`: the agent's state in the common health check format for HTTP APIs
 * (`application/health+json`, draft-inadarei-api-health-check). Busy is not unhealthy.
 */
import type { AgentState } from "../api/types.js";

export const HEALTH_CONTENT_TYPE = "application/health+json";

export function toHealth(s: AgentState) {
  const check = (observedValue: unknown, observedUnit?: string) => [{ componentType: "component", observedValue, ...(observedUnit ? { observedUnit } : {}), status: "pass" }];
  return {
    status: "pass",
    serviceId: "greyfolk",
    description: `one agent on the ${s.engine} engine`,
    checks: {
      "agent:busy": check(s.busy),
      "agent:response": check(s.response_id),
      "agent:subagents": check(s.subagents, "running"),
      "agent:approvals": check(s.approvals),
      "engine:conversation": check({ engine: s.engine, model: s.model, conversation: s.conversation }),
    },
  };
}
