import { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { AppError, ErrorCode, ErrorResponse, Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';

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
  return req.requestId;
}

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
  
  // REQUIREMENT: Route through the contextual request-scoped logger if present
  const activeLogger = req.logger ?? globalLogger;
  
  if (mapped.statusCode >= 500) {
    activeLogger.error(mapped.message, {
      requestId,
      code: mapped.code,
      statusCode: mapped.statusCode,
      details: mapped.details,
      error: err,
      path: req.path,
      method: req.method,
    });
  } else {
    activeLogger.warn(mapped.message, {
      requestId,
      code: mapped.code,
      statusCode: mapped.statusCode,
      details: mapped.details,
      path: req.path,
      method: req.method,
    });
  }

  // REQUIREMENT: Include validation tracking parameters inside headers and responses
  if (requestId) {
    res.setHeader('X-Request-Id', requestId);
  }

  const finalError = mapped.expose ? mapped : Errors.internal();
  res.status(finalError.statusCode).json(finalError.toResponse(requestId));
};