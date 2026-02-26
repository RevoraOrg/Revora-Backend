import { NextFunction, Request, RequestHandler, Response } from 'express';
import { DuplicateEmailError, RegisterService } from './registerService';
import { RegisterRequestBody } from './types';

/** Minimal RFC-5322-ish email pattern – same rigour used across the auth module. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/**
 * Express handler factory for `POST /api/auth/investor/register`.
 *
 * Validates the request body, delegates to `RegisterService`, and returns:
 *   201  { user: { id, email, role } }   – created
 *   400  { error, message }              – validation failure
 *   409  { error, message }              – email already registered
 */
export const createRegisterHandler = (
  registerService: RegisterService,
): RequestHandler => {
  return async (
    req: Request<unknown, unknown, RegisterRequestBody>,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const { email, password } = req.body ?? {};

      // ── Presence ────────────────────────────────────────────────────────
      if (!email || !password) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Both "email" and "password" are required.',
        });
        return;
      }

      // ── Type guards ──────────────────────────────────────────────────────
      if (typeof email !== 'string' || typeof password !== 'string') {
        res.status(400).json({
          error: 'Bad Request',
          message: '"email" and "password" must be strings.',
        });
        return;
      }

      // ── Email format ─────────────────────────────────────────────────────
      if (!EMAIL_RE.test(email)) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Invalid email address.',
        });
        return;
      }

      // ── Password length ──────────────────────────────────────────────────
      if (password.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({
          error: 'Bad Request',
          message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
        return;
      }

      const user = await registerService.register(email, password);

      res.status(201).json({
        user: { id: user.id, email: user.email, role: user.role },
      });
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        res.status(409).json({ error: 'Conflict', message: error.message });
        return;
      }
      next(error);
    }
  };
};
