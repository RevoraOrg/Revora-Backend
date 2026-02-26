import { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export interface RequestIdOptions {
  headerName?: string;
  onAssign?: (info: { requestId: string; req: Request }) => void;
}

const DEFAULT_HEADER = 'x-request-id';

function toHeaderString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) return String(value[0]);
  return undefined;
}

export function createRequestIdMiddleware(
  options: RequestIdOptions = {}
): RequestHandler {
  const sourceHeader = (options.headerName ?? DEFAULT_HEADER).toLowerCase();

  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = toHeaderString(req.header(sourceHeader));
    const requestId = (incoming && incoming.trim()) || randomUUID();

    (req as any).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    if (options.onAssign) {
      try {
        options.onAssign({ requestId, req });
      } catch {
        /* noop */
      }
    }

    next();
  };
}

export default createRequestIdMiddleware;

