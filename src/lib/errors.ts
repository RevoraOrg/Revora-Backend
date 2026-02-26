import { NextFunction } from 'express';

// ─── Error codes ──────────────────────────────────────────────────────────────

/** Exhaustive set of machine-readable error codes used across the API. */
export const ErrorCode = {
  /** One or more input fields failed validation (HTTP 400). */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Generic malformed or unacceptable request (HTTP 400). */
  BAD_REQUEST: 'BAD_REQUEST',
  /** Authentication is required or the supplied credentials are invalid (HTTP 401). */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Authenticated but not permitted to access the resource (HTTP 403). */
  FORBIDDEN: 'FORBIDDEN',
  /** The requested resource does not exist (HTTP 404). */
  NOT_FOUND: 'NOT_FOUND',
  /** Resource-state conflict, e.g. duplicate entry (HTTP 409). */
  CONFLICT: 'CONFLICT',
  /** Unexpected server-side failure (HTTP 500). */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── Wire shape ───────────────────────────────────────────────────────────────

/**
 * Standard JSON body returned to the client for every error response.
 *
 * ```json
 * { "code": "VALIDATION_ERROR", "message": "limit must be a positive integer", "details": { "field": "limit" } }
 * ```
 */
export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

// ─── AppError ─────────────────────────────────────────────────────────────────

/**
 * Structured application error.  Throw this (or pass it to `next()`) anywhere
 * in the request lifecycle; the global error handler will serialise it using
 * {@link ErrorResponse} and set the correct HTTP status code.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    // Restore prototype chain so `instanceof AppError` works after transpilation.
    Object.setPrototypeOf(this, AppError.prototype);
  }

  /** Serialise to the standard {@link ErrorResponse} wire shape. */
  toResponse(): ErrorResponse {
    const body: ErrorResponse = { code: this.code, message: this.message };
    if (this.details !== undefined) {
      body.details = this.details;
    }
    return body;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build an {@link AppError} with an explicit status code.
 * Prefer the {@link Errors} convenience object for common cases.
 */
export function createError(
  code: ErrorCode,
  message: string,
  statusCode: number,
  details?: unknown,
): AppError {
  return new AppError(code, message, statusCode, details);
}

// ─── Convenience factories ────────────────────────────────────────────────────

/**
 * Pre-built factories for the most common error scenarios.
 *
 * @example
 *   throw Errors.notFound('Offering not found');
 *   next(Errors.unauthorized());
 */
export const Errors = {
  /** Input validation failed – HTTP 400. */
  validationError: (message: string, details?: unknown): AppError =>
    createError(ErrorCode.VALIDATION_ERROR, message, 400, details),

  /** Generic bad request – HTTP 400. */
  badRequest: (message: string, details?: unknown): AppError =>
    createError(ErrorCode.BAD_REQUEST, message, 400, details),

  /** Authentication required or credentials invalid – HTTP 401. */
  unauthorized: (message = 'Unauthorized'): AppError =>
    createError(ErrorCode.UNAUTHORIZED, message, 401),

  /** Authenticated but not permitted – HTTP 403. */
  forbidden: (message = 'Forbidden'): AppError =>
    createError(ErrorCode.FORBIDDEN, message, 403),

  /** Resource not found – HTTP 404. */
  notFound: (message: string): AppError =>
    createError(ErrorCode.NOT_FOUND, message, 404),

  /** Resource-state conflict – HTTP 409. */
  conflict: (message: string): AppError =>
    createError(ErrorCode.CONFLICT, message, 409),

  /** Unexpected server error – HTTP 500. */
  internal: (message = 'Internal server error', details?: unknown): AppError =>
    createError(ErrorCode.INTERNAL_ERROR, message, 500, details),
};

// ─── Route helpers ────────────────────────────────────────────────────────────

/**
 * Throw an {@link AppError} immediately.  Use inside `try/catch` blocks or
 * async route handlers where Express will catch the thrown error.
 *
 * @example
 *   if (!offering) throwError(ErrorCode.NOT_FOUND, 'Offering not found', 404);
 */
export function throwError(
  code: ErrorCode,
  message: string,
  statusCode: number,
  details?: unknown,
): never {
  throw createError(code, message, statusCode, details);
}

/**
 * Forward a structured error to Express's `next()` so the global error
 * handler returns the standard JSON response.  Use when you need to exit
 * a middleware without throwing (e.g. inside a callback-style flow).
 *
 * @example
 *   if (!user) return sendAppError(next, Errors.unauthorized());
 */
export function sendAppError(next: NextFunction, error: AppError): void {
  next(error);
}
