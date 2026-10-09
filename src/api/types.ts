/**
 * The service's surface: the OpenAI Responses API itself (create, stream, steer, cancel, retrieve).
 * The controller (server) speaks it outward; engines write into it with the same types; there is
 * no other model.
 *
 * Requests, items, response objects and stream events are the official SDK types
 * (`openai/resources/responses/responses`). Only greyfolk's own extensions (`greyfolk.*`)
 * are defined here, as small additions on top.
 */
import type {
  Response,
  ResponseCreateParamsBase,
  ResponseSteerInput,
  ResponseStreamEvent,
  ResponseSteerAcceptedEvent,
  ResponseSteerFailedEvent,
  Tool,
} from "openai/resources/responses/responses";

export type * from "openai/resources/responses/responses";

/** The MCP tool entry of a request (the only tool type greyfolk takes). */
export type McpTool = Tool.Mcp;

// ---- greyfolk.* extensions -------------------------------------------------

/** `POST /v1/responses` body: the SDK params. */
export type CreateParams = ResponseCreateParamsBase & {
  stream?: boolean | null;
};

/**
 * A response object as greyfolk serves it. Same as the SDK's, except that failure codes and
 * incomplete reasons may be greyfolk's own (`engine_error`, `instance_stopped`).
 */
export type AgentResponse = Omit<Response, "error" | "incomplete_details"> & {
  error: { code: string; message: string } | null;
  incomplete_details: { reason: string } | null;
};

/** Outcome of a steer: the input reached the model step, or the response ended first. */
export type SteerResult = "taken_in" | "response_ended";

export type PermissionDecision = "allow" | "deny";

/** Stream events greyfolk adds to the Responses stream. */
export type AgentStreamEvent =
  | { type: "response.cancelled"; sequence_number: number; response: AgentResponse }
  | { type: "greyfolk.steer_taken_in"; sequence_number: number; steer: { id: string; previous_response_id: string }; next_response_id: string }
  | { type: "greyfolk.permission_request"; sequence_number: number; id: string; response_id: string; tool: string; operation: unknown }

/**
 * Every event on a response's stream. Lifecycle events carry `AgentResponse` (the SDK
 * `Response` with greyfolk's wider error codes), so they are re-typed here.
 */
export type StreamEvent =
  | Exclude<ResponseStreamEvent, { response: Response }>
  | { [K in Extract<ResponseStreamEvent, { response: Response }>["type"]]: Omit<Extract<ResponseStreamEvent, { type: K }>, "response"> & { response: AgentResponse } }[Extract<ResponseStreamEvent, { response: Response }>["type"]]
  | ResponseSteerAcceptedEvent
  | ResponseSteerFailedEvent
  | AgentStreamEvent;

/** A stream event before the log numbers it. */
export type UnnumberedEvent = StreamEvent extends infer E ? (E extends unknown ? Omit<E, "sequence_number"> : never) : never;

export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["response.completed", "response.failed", "response.cancelled"]);

export interface SteerOutcome {
  steerId: string;
  /** The response that was live when the steer arrived (null if none was). */
  liveResponseId: string | null;
  result: Promise<SteerResult>;
}

/** The agent's state; served as the checks of the standard health check (`GET /health`). */
export interface AgentStatus {
  state: "idle" | "busy";
  engine: string;
  model: string | null;
  session_id: string | null;
  turn: { id: string; response_id: string; responses: string[] } | null;
  subagents: { running: number; lost: string[] };
  subagent_profile: { name: string | null; applied: boolean };
  permission_requests: { id: string; response_id: string }[];
}

/** `GET /greyfolk/history` entry, read back from the engine's own session file. */
export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  text: string;
  at: string | null;
}

export type StreamListener = (event: StreamEvent) => void;

/** The service the controller depends on (nothing else): the Responses API plus `greyfolk.*`. */
export interface ResponsesApi {
  /** The engine's name. */
  readonly engine: string;

  /** Prepares the agent folder and resumes the recorded session; throws if greyfolk must refuse to start. */
  init(): Promise<void>;
  close(): Promise<void>;

  // ---- Responses API --------------------------------------------------------
  /** Opens a turn; returns its first response (in progress). */
  create(params: CreateParams): Promise<AgentResponse>;
  /** Streams a response from `startingAfter`, then its successors in the same turn (steer). Returns unsubscribe. */
  stream(responseId: string, startingAfter: number, listener: StreamListener): () => void;
  /** Adds input to the running turn (`response.steer`). */
  steer(previousResponseId: string, input: ResponseSteerInput): Promise<SteerOutcome>;
  /** Cancels the response's turn if it is running; returns the response. */
  cancel(responseId: string): Promise<AgentResponse>;
  /** Cancels when the creating stream closed and the response is not `background`. */
  cancelIfForeground(responseId: string): Promise<void>;
  retrieve(responseId: string): AgentResponse;

  // ---- greyfolk.* extensions ---------------------------------------------------
  decidePermission(id: string, decision: PermissionDecision): { id: string; decision: PermissionDecision };
  status(): AgentStatus;
  history(): Promise<HistoryMessage[]>;
  export(dest: string): Promise<{ dest: string; excluded: string[] }>;
  reset(): Promise<{ archived_to: string }>;
}
