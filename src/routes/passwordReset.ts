import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { PasswordResetService, PasswordResetRateLimitedError } from '../services/passwordResetService';
import { PasswordResetRateLimiter } from '../services/passwordResetRateLimiter';
import { EmailService } from '../services/emailService';
import { logger } from '../lib/logger';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreatePasswordResetRouterOptions {
  db: Pool;
  emailService: EmailService;
}

export function createPasswordResetRouter(options: CreatePasswordResetRouterOptions): Router {
  const { db, emailService } = options;
  const router = Router();
  const rateLimiter = new PasswordResetRateLimiter(db, {
    maxRequests: 3,
    windowMinutes: 60,
    blockMinutes: 15,
  });
  const service = new PasswordResetService(db, {
    emailSender: async (to, subject, body) => {
      // Use EmailService to send the reset email
      await emailService.sendMail(to, subject, body);
    },
    rateLimiter,
  });

  router.post('/api/auth/forgot-password', async (req: Request, res: Response) => {
    const { email } = req.body ?? {};
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
      res.status(200).json({
        message: 'If the email exists, a password reset link has been sent',
      });
      return;
    }
    try {
      await service.requestPasswordReset(email);
    } catch (err) {
      if (err instanceof PasswordResetRateLimitedError) {
        const retryAfter = Math.max(0, Math.ceil(err.retryAfter));
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({
          error: err.message,
          retryAfter,
        });
        return;
      }
      logger.error('[password-reset] Error processing request:', err);
    }
    res.status(200).json({
      message: 'If the email exists, a password reset link has been sent',
    });
  });

  router.post('/api/auth/reset-password', async (req: Request, res: Response) => {
    const { token, password } = req.body ?? {};
    if (typeof token !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Invalid token or password' });
      return;
    }
    try {
      const result = await service.resetPassword(token, password);
      if (!result.ok) {
        if (result.reason === 'weak_password') {
          res.status(400).json({ error: 'Password does not meet strength requirements', errors: result.errors });
          return;
        }
        res.status(400).json({ error: 'Invalid or expired token' });
        return;
      }
      res.status(200).json({ message: 'Password updated' });
    } catch (err) {
      // Log error without exposing token
      logger.error('[password-reset] Reset password error');
      res.status(400).json({ error: 'Invalid or expired token' });
    }
  });

  return router;
}
