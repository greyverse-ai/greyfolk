/**
 * The Harness interface: one engine program (the "vessel") carrying one
 * continuing session. Everything engine-specific sits behind this interface;
 * the OpenAI-profile layer above it knows nothing about Claude or Codex.
 *
 * Spec: greyfolk.md §1 (soul / vessel / memory), §3 (session), §4 (tools), §5 (subagents).
 */

/** One MCP server a request names, already translated to a transport the engine can attach. */
export type McpAttachment =
  | {
      kind: "http";
      label: string;
      url: string;
      headers: Record<string, string>;
      requireApproval: "never" | "always";
    }
  | {
      kind: "stdio";
      label: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      requireApproval: "never" | "always";
    };

/** A text input item the harness receives (only text is supported; see SPEC_GAPS). */
export interface HarnessInputItem {
  role: "user" | "system" | "developer";
  text: string;
}

export interface TurnRequest {
  /** Identifies the response this turn opens (for permission requests). */
  responseId: string;
  input: HarnessInputItem[];
  /** Per-response guidance on top of the soul; never written into the soul. */
  instructions: string | null;
  /** Model within the engine's family, or null for the agent's setting. */
  model: string | null;
  mcp: McpAttachment[];
  /** Fires when the engine asks for a tool permission; resolves to the decision. */
  onPermissionRequest: PermissionRequestHandler;
}

export type PermissionDecision = "allow" | "deny";

export type PermissionRequestHandler = (req: {
  tool: string;
  operation: unknown;
  signal: AbortSignal;
}) => Promise<PermissionDecision>;

export type HarnessUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

/** Events a harness emits while a turn runs. */
export type HarnessEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "message_done"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; server: string | null; arguments: unknown }
  | { type: "tool_result"; id: string; output: string; error: string | null }
  | { type: "steer_taken_in"; steerId: string }
  | { type: "subagent_started"; id: string; description: string | null }
  | { type: "subagent_finished"; result: SubagentResult }
  | { type: "done"; status: "completed" | "cancelled" | "failed"; error: string | null; usage: HarnessUsage | null };

export type SteerResult = "taken_in" | "response_ended";

/** The outcome of one native subagent run (spec §5). */
export interface SubagentResult {
  /** The engine's id for the subagent/task. */
  id: string;
  status: "completed" | "failed" | "stopped";
  /** The result text as the engine reports it (may be a summary). */
  output: string;
}

export interface HarnessStatus {
  /** Engine process alive and able to take a turn. */
  state: "idle" | "running";
  sessionId: string | null;
  subagents: { running: number; lost: string[] };
  model: string | null;
  /** The starter's subagent profile and whether this engine applies it (spec §5). */
  subagentProfile: { name: string | null; applied: boolean };
}

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  text: string;
  /** Engine-provided timestamp when known (ISO 8601). */
  at: string | null;
}

export interface HarnessCapabilities {
  /** The engine can take input into a running turn (steer). */
  midTurnInput: boolean;
  /** The engine surfaces interactive permission requests. */
  permissionRequests: boolean;
  /** The engine runs native subagents whose state greyfolk can observe. */
  subagents: boolean;
}

export interface Harness {
  readonly name: string;
  readonly capabilities: HarnessCapabilities;
  /** Model names of this engine's family; under `--model request` a request's `model` must match (else 400). */
  readonly modelFamily: RegExp;

  /** Checks the agent folder and engine paths; throws if greyfolk must refuse to start. */
  prepare(): Promise<void>;

  /** Starts a turn. The iterable ends with a `done` event. Only one turn at a time. */
  startTurn(req: TurnRequest): AsyncIterable<HarnessEvent>;

  /** Adds input to the running turn. `response_ended` if there is none or the engine cannot. */
  steer(steerId: string, input: HarnessInputItem[]): Promise<SteerResult>;

  /** Stops the running turn and kills the process group of its commands. */
  cancel(): Promise<void>;

  /**
   * Registers the listener for subagent results that arrive while no turn runs (spec §5):
   * the engine still has them in hand, greyfolk holds them keyed by the turn that spawned them.
   * Results that arrive inside a turn come through `startTurn` as `subagent_finished`.
   */
  onLateSubagentResult(listener: (result: SubagentResult) => void): void;

  status(): HarnessStatus;

  /** Current session id as the engine names it (null before the first turn). */
  sessionId(): string | null;

  /** Reads the conversation back from the engine's own session file. */
  history(): Promise<HistoryMessage[]>;

  /** Paths (relative to the agent folder) that an export leaves out because the engine rebuilds them. */
  exportExcludes(): string[];

  /** Paths (relative to the agent folder) that hold the session; moved away by a reset. */
  sessionPaths(): string[];

  /** Releases the engine process (fully idle only). */
  close(): Promise<void>;
}

/** What every harness is started with (spec §8). */
export interface HarnessStartOptions {
  agentDir: string;
  /** Soul text (the agent's instruction file body). */
  soul: string;
  /** Session id to resume, or null for a new session. */
  sessionId: string | null;
  /** Launcher prefix; the engine is started only through it. */
  harnessExec: string[];
  /** Fixed model (null = the engine's own setting). */
  model: string | null;
  /** Subagent profile name as the starter set it (applied as far as the engine allows). */
  subagentProfile: string | null;
  /** Called when the engine names (or renames) its session. */
  onSessionId: (id: string) => void;
}
