import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { PasswordResetService } from '../services/passwordResetService';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

export function createPasswordResetRouter(db: Pool): Router {
  const router = Router();
  const service = new PasswordResetService(db, {
    emailSender: async (to, subject, body) => {
      console.log(`[email] to=${to} subject="${subject}" body="${body}"`);
    },
  });

  router.post('/api/auth/forgot-password', async (req: Request, res: Response) => {
    const { email } = req.body ?? {};
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
      res.status(200).json({
        message: 'If the email exists, a password reset link has been sent',
      });
      return;
    }
    await service.requestPasswordReset(email);
    res.status(200).json({
      message: 'If the email exists, a password reset link has been sent',
    });
  });

  router.post('/api/auth/reset-password', async (req: Request, res: Response) => {
    const { token, password } = req.body ?? {};
    if (typeof token !== 'string' || typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: 'Invalid token or password' });
      return;
    }
    try {
      const ok = await service.resetPassword(token, password);
      if (!ok) {
        res.status(400).json({ error: 'Invalid or expired token' });
        return;
      }
      res.status(200).json({ message: 'Password updated' });
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
