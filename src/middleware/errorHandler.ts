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
