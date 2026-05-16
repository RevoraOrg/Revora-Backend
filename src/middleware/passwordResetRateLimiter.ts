import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import { PasswordResetRateLimitError } from '../lib/errors';
import { logger } from '../lib/logger';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS = 5;

export function createPasswordResetRateLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    max: MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req: Request, _res: Response, next: NextFunction) => {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      logger.warn('Password reset rate limit exceeded', { ip });
      next(new PasswordResetRateLimitError());
    },
  });
}

export const passwordResetRateLimiter = createPasswordResetRateLimiter();
