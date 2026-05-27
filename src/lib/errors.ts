/** Exhaustive set of machine-readable error codes used across the API. */
export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
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
 * Creates a structured error object.
 */
function createError(
  code: ErrorCode,
  message: string,
  statusCode: number,
  details?: unknown,
  options?: { expose?: boolean; isOperational?: boolean }
): AppError {
  return new AppError(code, statusCode, message, details, options);
}

/**
 * Base class for all application-specific errors.
 * Provides a consistent structure for error handling, including HTTP status codes.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;
  public readonly expose: boolean;
  public readonly isOperational: boolean;

  constructor(
    code: ErrorCode,
    statusCode: number,
    message: string,
    details?: unknown,
    options: { expose?: boolean; isOperational?: boolean } = {},
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.expose = options.expose ?? true;
    this.isOperational = options.isOperational ?? true;
    Error.captureStackTrace(this, this.constructor);
  }

  public toResponse(requestId?: string): ErrorResponse {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Not Found') {
    super(ErrorCode.NOT_FOUND, 404, message);
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(ErrorCode.UNAUTHORIZED, 401, message);
    this.name = 'UnauthorizedError';
  }
}

/** Convenience factories for common error scenarios. */
export const Errors = {
  validationError: (message: string, details?: unknown): AppError =>
    createError(ErrorCode.VALIDATION_ERROR, message, 400, details),

  badRequest: (message: string, details?: unknown): AppError =>
    createError(ErrorCode.BAD_REQUEST, message, 400, details),

  unauthorized: (message = "Unauthorized"): AppError =>
    createError(ErrorCode.UNAUTHORIZED, message, 401),

  forbidden: (message = "Forbidden"): AppError =>
    createError(ErrorCode.FORBIDDEN, message, 403),

  notFound: (message = "Not found"): AppError =>
    createError(ErrorCode.NOT_FOUND, message, 404),

  conflict: (message: string, details?: unknown): AppError =>
    createError(ErrorCode.CONFLICT, message, 409, details),

  serviceUnavailable: (
    message = "Service unavailable",
    details?: unknown,
  ): AppError =>
    createError(ErrorCode.SERVICE_UNAVAILABLE, message, 503, details),

  internal: (messageOrDetails?: unknown, details?: unknown): AppError => {
    const hasCustomMessage = typeof messageOrDetails === "string";
    return createError(
      ErrorCode.INTERNAL_ERROR,
      hasCustomMessage ? messageOrDetails : "Internal server error",
      500,
      hasCustomMessage ? details : messageOrDetails,
      { expose: false },
    );
  },

  tooManyRequests: (
    message = "Too many requests",
    details?: unknown,
  ): AppError =>
    createError(ErrorCode.TOO_MANY_REQUESTS, message, 429, details),
};

export function createError(
  code: ErrorCode,
  message: string,
  statusCode: number,
  details?: unknown,
  options?: { expose?: boolean },
): AppError {
  return new AppError(code, statusCode, message, details, options);
}

export function throwError(
  code: ErrorCode,
  message: string,
  statusCode: number,
  details?: unknown,
  options?: { expose?: boolean },
): never {
  throw createError(code, message, statusCode, details, options);
}

export class BadRequestError extends AppError {
  constructor(message: string = 'Bad Request') {
    super(ErrorCode.BAD_REQUEST, 400, message);
    this.name = 'BadRequestError';
  }
}
