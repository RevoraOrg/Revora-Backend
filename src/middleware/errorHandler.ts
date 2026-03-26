import { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode, ErrorResponse, Errors } from '../lib/errors';

interface StructuredErrorLogEntry {
  type: 'error';
  requestId?: string;
  code: ErrorCode;
  statusCode: number;
  message: string;
  expose: boolean;
  details?: unknown;
  stack?: string;
}

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

function getRequestId(req: Request): string | undefined {
  return (req as Request & { requestId?: string }).requestId;
}

/**
 * Maps arbitrary thrown values to a structured application error.
 *
 * Security boundary:
 * - AppError instances are trusted to carry client-visible messages/details.
 * - Unknown values are always downgraded to a generic INTERNAL_ERROR.
 */
export function mapUnknownErrorToAppError(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }

  return Errors.internal();
}

export function createStructuredErrorLogEntry(
  err: unknown,
  requestId?: string,
): StructuredErrorLogEntry {
  const mapped = mapUnknownErrorToAppError(err);
  const isMappedAppError = err instanceof AppError;
  const entry: StructuredErrorLogEntry = {
    type: 'error',
    requestId,
    code: mapped.code,
    statusCode: mapped.statusCode,
    message: mapped.message,
    expose: mapped.expose,
  };

  if (mapped.details !== undefined && isMappedAppError) {
    entry.details = mapped.details;
  }

  if (!isProduction() && err instanceof Error && err.stack) {
    entry.stack = err.stack;
  }

  return entry;
}

/** Express 4-argument global error handler. Mount after all routes. */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  const requestId = getRequestId(req);
  const mapped = mapUnknownErrorToAppError(err);
  const logEntry = createStructuredErrorLogEntry(err, requestId);

  console.error(JSON.stringify(logEntry));

  const body: ErrorResponse = mapped.expose
    ? mapped.toResponse(requestId)
    : Errors.internal().toResponse(requestId);

  res.status(mapped.statusCode).json(body);
};
