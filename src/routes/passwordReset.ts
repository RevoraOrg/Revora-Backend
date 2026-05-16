import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { PasswordResetService, EmailSender } from '../services/passwordResetService';
import { createPasswordResetRateLimiter } from '../middleware/passwordResetRateLimiter';
import { Errors } from '../lib/errors';

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().length(64).regex(/^[0-9a-fA-F]{64}$/),
  password: z.string().min(12),
});

const NEUTRAL_FORGOT_RESPONSE = {
  message: 'If the email exists, a password reset link has been sent',
};

export interface PasswordResetRouterOptions {
  emailSender?: EmailSender;
  appUrl?: string;
}

export function createPasswordResetRouter(db: Pool, opts?: PasswordResetRouterOptions): Router {
  const router = Router();
  const service = new PasswordResetService(db, {
    emailSender: opts?.emailSender,
    appUrl: opts?.appUrl,
  });

  router.post(
    '/api/auth/forgot-password',
    createPasswordResetRateLimiter(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { email } = forgotPasswordSchema.parse(req.body);
        await service.requestPasswordReset(email);
        return res.status(200).json(NEUTRAL_FORGOT_RESPONSE);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(200).json(NEUTRAL_FORGOT_RESPONSE);
        }
        return next(error);
      }
    },
  );

  router.post(
    '/api/auth/reset-password',
    createPasswordResetRateLimiter(),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { token, password } = resetPasswordSchema.parse(req.body);
        await service.resetPassword(token, password);
        return res.status(200).json({ message: 'Password has been reset' });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return next(Errors.validationError('Invalid password reset payload', error.issues));
        }
        return next(error);
      }
    },
  );

  return router;
}
