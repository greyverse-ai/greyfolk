/**
 * `GET /health`: the agent's state in the common health check format for HTTP APIs
 * (`application/health+json`, draft-inadarei-api-health-check): `status` pass | warn | fail and
 * one entry per check. The service's `status()` is the source; this only shapes it.
 */
import type { AgentStatus } from "../api/types.js";

export const HEALTH_CONTENT_TYPE = "application/health+json";

interface Check {
  componentType: "component";
  observedValue: unknown;
  observedUnit?: string;
  status: "pass" | "warn" | "fail";
  output?: string;
}

export interface Health {
  status: "pass" | "warn" | "fail";
  serviceId: "greyfolk";
  description: string;
  checks: Record<string, Check[]>;
}

export function toHealth(s: AgentStatus): Health {
  const pass = (observedValue: unknown, observedUnit?: string): Check[] => [{ componentType: "component", observedValue, ...(observedUnit ? { observedUnit } : {}), status: "pass" }];
  const lost = s.subagents.lost.length;
  return {
    // Busy is not unhealthy; subagents the engine lost are worth a warning.
    status: lost > 0 ? "warn" : "pass",
    serviceId: "greyfolk",
    description: `one agent on the ${s.engine} engine`,
    checks: {
      "agent:state": pass(s.state),
      "agent:turn": pass(s.turn),
      "agent:subagents": [{ componentType: "component", observedValue: s.subagents.running, observedUnit: "running", status: lost > 0 ? "warn" : "pass", ...(lost > 0 ? { output: `lost: ${s.subagents.lost.join(", ")}` } : {}) }],
      "agent:permission_requests": pass(s.permission_requests),
      "engine:session": pass({ engine: s.engine, model: s.model, session_id: s.session_id }),
      "engine:subagent_profile": pass(s.subagent_profile),
    },
  };
}
