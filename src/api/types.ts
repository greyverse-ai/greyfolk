/**
 * The protocol: the OpenAI Responses API, with the official SDK's types (npm `openai`).
 * greyfolk adds nothing of its own to it; its state is read through a standard health check.
 */
import type { Limits } from "./limits.js";
import type { Response, ResponseCreateParamsBase, ResponseStreamEvent, ResponseSteerAcceptedEvent, ResponseSteerErrorCode, ResponseSteerFailedEvent, ResponseSteerInput, Tool } from "openai/resources/responses/responses";
import type { ConversationItemList } from "openai/resources/conversations/items";

export type * from "openai/resources/responses/responses";
export type { ConversationItemList };

/** The MCP tool entry of a request (the only tool type greyfolk takes). */
export type McpTool = Tool.Mcp;

/** `POST /v1/responses` body. */
export type CreateParams = ResponseCreateParamsBase & { stream?: boolean | null };

/** A response object as greyfolk serves it: the SDK's, with an engine failure's own message. */
export type AgentResponse = Omit<Response, "error"> & { error: { code: string; message: string } | null };

/** Every event on a response's stream (lifecycle events carry `AgentResponse`; steer acceptance is the WebSocket mode's). */
export type StreamEvent =
  | ResponseSteerAcceptedEvent
  | Exclude<ResponseStreamEvent, { response: Response }>
  | { [K in Extract<ResponseStreamEvent, { response: Response }>["type"]]: Omit<Extract<ResponseStreamEvent, { type: K }>, "response"> & { response: AgentResponse } }[Extract<ResponseStreamEvent, { response: Response }>["type"]];

/** A stream event before the log numbers it. */
export type UnnumberedEvent = StreamEvent extends infer E ? (E extends unknown ? Omit<E, "sequence_number"> : never) : never;

/** A response ends the stream with one of these (a cancelled one ends `incomplete`, status `cancelled`). */
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["response.completed", "response.failed", "response.incomplete"]);

export type StreamListener = (event: StreamEvent) => void;

/** Why steering input was not committed (the standard `response.steer.failed` error). */
export interface SteerFailure {
  code: ResponseSteerErrorCode;
  message: string;
}

export interface SteerOutcome {
  /** The steer's id once accepted (`response.steer.accepted` went out on the live response), else null. */
  id: string | null;
  /** Taken into the running turn (a successor response continues it), or why it was not. */
  result: Promise<"taken_in" | SteerFailure>;
}

/** The agent's state, for the health check. */
export interface AgentState {
  busy: boolean;
  engine: string;
  model: string | null;
  conversation: string | null;
  /** The live response of the running turn. */
  response_id: string | null;
  subagents: number;
  /** Approval requests waiting for an `mcp_approval_response`. */
  approvals: string[];
}

/** What the controller depends on (nothing else): the Responses API. */
export interface ResponsesApi {
  create(params: CreateParams): Promise<AgentResponse>;
  /** Streams a response from `startingAfter`, then its successors in the same turn. Returns unsubscribe. */
  stream(responseId: string, startingAfter: number, listener: StreamListener): () => void;
  retrieve(responseId: string): AgentResponse;
  steer(previousResponseId: string, input: ResponseSteerInput): Promise<SteerOutcome>;
  cancel(responseId: string): Promise<AgentResponse>;
  /** Cancels when the stream that created the turn closed and it is not `background`. */
  cancelIfForeground(responseId: string): Promise<void>;
  /** `GET /v1/conversations/{id}/items`, read by the engine from its own session. */
  conversationItems(conversationId: string): Promise<ConversationItemList>;
  state(): AgentState;
  /** `GET /limits`: the engine account's own usage limits (null when the engine reports none). */
  limits(refresh: boolean): Promise<Limits | null>;
  close(): Promise<void>;
}
