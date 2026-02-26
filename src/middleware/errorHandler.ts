import { ErrorRequestHandler, NextFunction, Request, Response } from 'express';

/**
 * Typed application error that carries an HTTP status code.
 *
 * Throw an AppError (or pass one to next()) from any route handler when
 * you want the global error handler to respond with a specific HTTP status
 * and message without leaking internal details.
 *
 * @example
 *   throw new AppError(404, 'Offering not found');
 *   next(new AppError(403, 'Forbidden'));
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
    // Restore prototype chain after TypeScript's `extends Error` transpilation.
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Global Express error-handling middleware.
 *
 * Register this **after all routes**:
 *   app.use(errorHandler);
 *
 * Behaviour:
 *  - `AppError` instances → their statusCode + message.
 *  - Unknown errors in production → 500 "Internal Server Error" (no leakage).
 *  - Unknown errors in non-production → 500 with the actual error message
 *    (aids local debugging).
 *  - Stack traces are included in console.error output only in non-production.
 *  - If `requestLogMiddleware` is mounted earlier in the stack it stamps
 *    `req.requestId`; this value is forwarded in the JSON response body.
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // Express requires the fourth argument for the function to be recognised
  // as an error handler, even when it is unused.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  const requestId: string | undefined = (req as any).requestId;

  let statusCode = 500;
  let message = 'Internal Server Error';

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
  } else if (!isProduction() && err instanceof Error) {
    // Expose message in development / test to ease debugging.
    message = err.message;
  }

  // ── Structured log ───────────────────────────────────────────────────────
  const logEntry: Record<string, unknown> = {
    type: 'error',
    requestId,
    statusCode,
    message,
  };

  if (!isProduction() && err instanceof Error && err.stack) {
    logEntry.stack = err.stack;
  }

  console.error(JSON.stringify(logEntry));

  // ── Response ─────────────────────────────────────────────────────────────
  const body: { error: string; requestId?: string } = { error: message };
  if (requestId !== undefined) body.requestId = requestId;

  res.status(statusCode).json(body);
};
import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode, ErrorResponse } from '../lib/errors';

/**
 * Express 4-argument global error handler.
 *
 * Mount **after** all routes so unhandled errors bubble up here:
 * ```ts
 * app.use(errorHandler);
 * ```
 *
 * - {@link AppError} instances are serialised via {@link AppError.toResponse}
 *   and the correct HTTP status code is used.
 * - Any other thrown value is treated as an unexpected server error (500),
 *   logged, and returned as `{ code: 'INTERNAL_ERROR', message: 'Internal server error' }`.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toResponse());
    return;
  }

  // Unknown / unexpected error — log and return an opaque 500.
  console.error('[errorHandler] Unhandled error:', err);

  const body: ErrorResponse = {
    code: ErrorCode.INTERNAL_ERROR,
    message: 'Internal server error',
  };
  res.status(500).json(body);
}
