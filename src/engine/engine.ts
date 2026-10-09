/**
 * The engine strategy: one engine program (the vessel) carrying one continuing session.
 * The service picks one and calls it; the engine writes its output straight into the running
 * turn in Responses vocabulary (`Turn`), so there is no event model of its own. Converting the
 * engine's native events happens inside the engine and nowhere else.
 *
 * Spec: greyfolk.md §1 (soul / vessel / memory), §3 (session), §4 (tools), §5 (subagents).
 */
import type { HistoryMessage } from "../api/types.js";
import type { InputMessage } from "../api/input.js";
import type { McpAttachment } from "../mcp/translate.js";
import type { Turn, TurnEnd } from "../common/turn.js";
import type { QueuedSteer } from "../common/steer-queue.js";
import type { SubagentProfile } from "./subagent-profile.js";
import type { OptionValues, ToolKind } from "../options.js";

/** What every engine is started with (spec §8). Nothing here names a greyzone. */
export interface EngineOptions {
  agentDir: string;
  /** Soul text (the agent's instruction file body). */
  soul: string;
  /** Kinds of the engine's own tools that are off (spec §4, §8); all kinds = no host tools. */
  disabledTools: ReadonlySet<ToolKind>;
  /** Launcher prefix the engine is started through (empty = greyfolk starts it itself). */
  exec: string[];
  /** Every resolved start option, for the engine's own options (`EngineDefinition.options`). */
  values: OptionValues;
  /** The starter's subagent profile (spec §5), or null. */
  subagentProfile: SubagentProfile | null;
}

/** What one turn gives the engine. */
export interface EngineTurn {
  /** New input, oldest first. */
  input: InputMessage[];
  /** Per-response guidance on top of the soul; never written into the soul. */
  instructions: string | null;
  /** Model within the engine's family, or null for the agent's setting. */
  model: string | null;
  /** This turn's MCP servers, already translated to transports. */
  mcp: McpAttachment[];
}

export interface EngineState {
  /** A turn is running. */
  running: boolean;
  sessionId: string | null;
  model: string | null;
  /** Native subagents still running (the agent stays busy) and those the engine lost. A result that arrives after its turn is the engine's to carry, as the SDK does. */
  subagents: { running: number; lost: string[] };
  /** The subagent profile is applied by this engine. */
  subagentProfileApplied: boolean;
}

export interface Engine {
  readonly name: string;
  /** Model names of this engine's family; under `--model request` a request's `model` must match. */
  readonly modelFamily: RegExp;
  /** The engine can ask the caller before an MCP tool runs (`require_approval: "always"`). */
  readonly canAskApproval: boolean;

  /**
   * Checks the agent folder, resumes `sessionId` (null = new session) and confirms the tool kinds
   * it was told to turn off are off; throws if greyfolk must refuse to start (fail closed).
   */
  start(sessionId: string | null): Promise<void>;

  /** Runs one turn, writing its output into `turn`; resolves with how it ended. Only one at a time. */
  run(turn: Turn, req: EngineTurn): Promise<TurnEnd>;

  /**
   * Hands steer input to the running turn. True when the engine took it; it then calls
   * `turn.steerTakenIn(id)` at the model step that receives it. False when it cannot.
   */
  steer(turn: Turn, steer: QueuedSteer): Promise<boolean>;

  /** Stops the running turn and kills the process group of its commands; `run` then resolves. */
  cancel(): Promise<void>;

  state(): EngineState;

  /** Reads the conversation back from the engine's own session file. */
  history(): Promise<HistoryMessage[]>;

  /** Paths (relative to the agent folder) an export leaves out because the engine rebuilds them. */
  exportExcludes(): string[];

  /** Paths (relative to the agent folder) that hold the session; moved away by a reset. */
  sessionPaths(): string[];

  /** Releases the engine process. */
  stop(): Promise<void>;
}
