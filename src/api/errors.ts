/** OpenAI-style error conventions (spec §2 "Errors"). */

export type ApiErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "server_error";

export class ApiError extends Error {
  readonly status: number;
  readonly type: ApiErrorType;
  readonly code: string | null;
  readonly param: string | null;

  constructor(status: number, type: ApiErrorType, message: string, code: string | null = null, param: string | null = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }

  toBody(): { error: { type: ApiErrorType; code: string | null; message: string; param: string | null } } {
    return { error: { type: this.type, code: this.code, message: this.message, param: this.param } };
  }

  static invalid(message: string, code: string | null = null, param: string | null = null): ApiError {
    return new ApiError(400, "invalid_request_error", message, code, param);
  }

  static notFound(message: string, param: string | null = null): ApiError {
    return new ApiError(404, "invalid_request_error", message, "not_found", param);
  }

  static unauthorized(): ApiError {
    return new ApiError(401, "authentication_error", "Missing or invalid bearer key.", "invalid_api_key");
  }

  static busy(message: string, code = "turn_in_progress"): ApiError {
    return new ApiError(409, "invalid_request_error", message, code);
  }

  static from(err: unknown): ApiError {
    if (err instanceof ApiError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new ApiError(500, "server_error", message);
  }
}
