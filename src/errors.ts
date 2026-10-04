export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_REWARD"
  | "EXPERIMENT_NOT_FOUND"
  | "DECISION_NOT_FOUND"
  | "DUPLICATE_FEEDBACK"
  | "BAD_REQUEST";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function toErrorBody(err: unknown): {
  status: number;
  body: { error: { code: string; message: string } };
} {
  if (err instanceof ApiError) {
    return { status: err.httpStatus, body: { error: { code: err.code, message: err.message } } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: { code: "INTERNAL", message } } };
}
