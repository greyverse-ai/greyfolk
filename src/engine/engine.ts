/**
 * The engine strategy: one engine's SDK, carrying the agent's session. The service picks one and
 * calls it; the engine writes its output into the turn in Responses vocabulary and maps nothing
 * else. Every harness feature (sessions, compaction, tools, subagents, late results) stays the
 * SDK's own (intent: agent/operations).
 */
import type { Limits } from "../api/limits.js";
import type { InputMessage } from "../api/input.js";
import type { McpAttachment } from "../mcp/translate.js";
import type { OptionValues } from "../options.js";
import type { Turn, TurnEnd } from "../service/turn.js";

export interface EngineOptions {
  agentDir: string;
  /**
   * Instructions added to the engine's own (from `--soul FILE`), or null. The agent's instruction file
   * in the folder (CLAUDE.md / AGENTS.md) is read by the engine itself, as usual.
   */
  extraInstructions: string | null;
  /** The engine's own options (after `--`), handed to its SDK as they are. */
  engineArgs: string[];
  /** Launcher prefix the engine is started through (empty = greyfolk starts it itself). */
  exec: string[];
  /** Every resolved start option, for the engine's own options. */
  values: OptionValues;
}

export interface EngineTurn {
  /** The conversation (engine session) to continue, or null for a new one. */
  conversation: string | null;
  input: InputMessage[];
  instructions: string | null;
  /** Model within the engine's family, or null for the agent's setting. */
  model: string | null;
  mcp: McpAttachment[];
}

export interface EngineState {
  running: boolean;
  conversation: string | null;
  model: string | null;
  /** The engine's own background tasks still running, subagents among them (the agent stays busy). */
  subagents: number;
}

/** One message of a conversation as the engine's session holds it. */
export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

export interface Engine {
  readonly name: string;
  readonly modelFamily: RegExp;
  /** The engine can ask before an MCP tool runs (`require_approval: "always"`). */
  readonly canAskApproval: boolean;
  /** The engine takes input into a turn in progress (steer). */
  readonly canSteer: boolean;
  /** Checks the folder and the engine options before serving. */
  start(): Promise<void>;
  run(turn: Turn, req: EngineTurn): Promise<TurnEnd>;
  /** Hands mid-turn input to the engine; it calls `turn.steerTakenIn(id)` when a step takes it. False if it cannot. */
  steer(turn: Turn, id: string, input: InputMessage[]): Promise<boolean>;
  cancel(): Promise<void>;
  state(): EngineState;
  /** The conversation as the engine's session holds it, or null if unknown. */
  conversation(id: string): Promise<ConversationMessage[] | null>;
  /** The account's usage limits as last reported; refresh asks the engine again when it is up. */
  limits?(refresh: boolean): Promise<Limits | null>;
  stop(): Promise<void>;
}
