import { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

function pickHeaderId(val: undefined | string | string[]): string | undefined {
  if (typeof val === 'string') return val.trim() || undefined;
  if (Array.isArray(val)) {
    for (const v of val) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return undefined;
}

export function requestIdMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const fromHeader = pickHeaderId(req.headers['x-request-id']);
    const existing = req.requestId;
    const id = fromHeader ?? existing ?? randomUUID();
    if (!req.requestId) req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

