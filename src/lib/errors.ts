import { NextFunction } from 'express';

/** Exhaustive set of machine-readable error codes used across the API. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Standard JSON body returned to clients for structured API errors. */
export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
}

/**
 * Structured application error.
 *
 * Only instances of this class are allowed to control client-visible status
 * codes, messages, and optional details. Unknown thrown values are sanitized by
 * the global error handler.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: unknown,
    options?: { expose?: boolean },
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.expose = options?.expose ?? true;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  toResponse(requestId?: string): ErrorResponse {
    const body: ErrorResponse = {
      code: this.code,
      message: this.message,
    };

    if (this.details !== undefined) {
      body.details = this.details;
    }

    if (requestId !== undefined) {
      body.requestId = requestId;
    }

    return body;
  }
}

export function createError(
  code: ErrorCode,
  message: string,
  statusCode: number,
  details?: unknown,
  options?: { expose?: boolean },
): AppError {
  return new AppError(code, message, statusCode, details, options);
}

/** Convenience factories for common error scenarios. */
export const Errors = {
  validationError: (message: string, details?: unknown): AppError =>
    createError(ErrorCode.VALIDATION_ERROR, message, 400, details),

  badRequest: (message: string, details?: unknown): AppError =>
    createError(ErrorCode.BAD_REQUEST, message, 400, details),

  unauthorized: (message = 'Unauthorized'): AppError =>
    createError(ErrorCode.UNAUTHORIZED, message, 401),

  forbidden: (message = 'Forbidden'): AppError =>
    createError(ErrorCode.FORBIDDEN, message, 403),

  notFound: (message = 'Not found'): AppError =>
    createError(ErrorCode.NOT_FOUND, message, 404),

  conflict: (message: string, details?: unknown): AppError =>
    createError(ErrorCode.CONFLICT, message, 409, details),

  serviceUnavailable: (
    message = 'Service unavailable',
    details?: unknown,
  ): AppError => createError(ErrorCode.SERVICE_UNAVAILABLE, message, 503, details),

  internal: (details?: unknown): AppError =>
    createError(
      ErrorCode.INTERNAL_ERROR,
      'Internal server error',
      500,
      details,
      { expose: false },
    ),
};

export function throwError(
  code: ErrorCode,
  message: string,
  statusCode: number,
  details?: unknown,
  options?: { expose?: boolean },
): never {
  throw createError(code, message, statusCode, details, options);
}

export function sendAppError(next: NextFunction, error: AppError): void {
  next(error);
}
