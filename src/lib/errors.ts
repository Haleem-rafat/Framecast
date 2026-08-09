/**
 * Typed error hierarchy. Services throw these; the action/route boundary maps
 * them to a serialisable shape. `isOperational` marks errors that are expected
 * business outcomes and therefore safe to surface to the user verbatim.
 */

export type AppErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "INTERNAL";

export interface SerializedError {
  code: AppErrorCode;
  message: string;
  details?: Record<string, string[]>;
}

export abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
  abstract readonly httpStatus: number;
  readonly isOperational: boolean = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }

  serialize(): SerializedError {
    return { code: this.code, message: this.message };
  }
}

export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED" as const;
  readonly httpStatus = 401;

  constructor(message = "You must be signed in to do that.") {
    super(message);
  }
}

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN" as const;
  readonly httpStatus = 403;

  constructor(message = "You do not have access to this resource.") {
    super(message);
  }
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const;
  readonly httpStatus = 404;

  constructor(resource: string) {
    super(`${resource} was not found.`);
  }
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION" as const;
  readonly httpStatus = 422;

  constructor(
    message = "The submitted data is invalid.",
    readonly details?: Record<string, string[]>,
  ) {
    super(message);
  }

  override serialize(): SerializedError {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT" as const;
  readonly httpStatus = 409;
}

export class RateLimitedError extends AppError {
  readonly code = "RATE_LIMITED" as const;
  readonly httpStatus = 429;

  constructor(readonly retryAfterSeconds: number) {
    super(`Too many requests. Try again in ${retryAfterSeconds}s.`);
  }
}

/** An upstream AI/YouTube provider failed. Retryable errors are worth re-queuing. */
export class ProviderError extends AppError {
  readonly code = "PROVIDER_ERROR" as const;
  readonly httpStatus = 502;

  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Unexpected failure. The message is deliberately generic — details go to logs only. */
export class InternalError extends AppError {
  readonly code = "INTERNAL" as const;
  readonly httpStatus = 500;
  override readonly isOperational = false;

  constructor(message = "Something went wrong on our end.", options?: { cause?: unknown }) {
    super(message, options);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Normalises any thrown value into a client-safe shape. Non-`AppError` throws
 * are collapsed to a generic internal error so stack traces and driver messages
 * never reach the browser.
 */
export function toSerializedError(error: unknown): SerializedError {
  if (isAppError(error)) {
    return error.serialize();
  }

  return new InternalError().serialize();
}
