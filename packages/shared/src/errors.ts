export type ApiErrorCode =
  | "bad_request"
  | "invalid_credentials"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "lore_unavailable"
  | "internal";

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: ApiErrorCode,
    status: number,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError("bad_request", 400, message, details);

export const unauthorized = (message = "Authentication required") =>
  new AppError("unauthorized", 401, message);

export const forbidden = (message = "You do not have access to this resource") =>
  new AppError("forbidden", 403, message);

export const notFound = (message = "Not found") =>
  new AppError("not_found", 404, message);

export const conflict = (message: string) =>
  new AppError("conflict", 409, message);
