import { NextFunction, Request, RequestHandler, Response } from 'express';
import { Errors, UniqueConstraintError } from '../../lib/errors';
import { DuplicateEmailError, RegisterService } from './registerService';
import { RegisterRequestBody } from './types';

/** Minimal RFC-5322-ish email pattern – same rigour used across the auth module. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Express handler factory for `POST /api/auth/investor/register`.
 *
 * Validates the request body, delegates to `RegisterService`, and returns:
 *   201  { user: { id, email, role } }   – successful registration
 *   400  { error, message }              – missing or invalid email or password
 *   409  { error, message }              – duplicate email: thrown as
 *                                          `DuplicateEmailError` (application-layer
 *                                          pre-query check) or `UniqueConstraintError`
 *                                          (database-layer 23505 violation); both
 *                                          paths return the same body so callers
 *                                          cannot distinguish them
 *   500  (delegated to Express error handler) – unexpected server error
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
        throw Errors.badRequest('Both "email" and "password" are required.');
      }

      // ── Type guards ──────────────────────────────────────────────────────
      if (typeof email !== 'string' || typeof password !== 'string') {
        throw Errors.badRequest('"email" and "password" must be strings.');
      }

      // ── Email format ─────────────────────────────────────────────────────
      if (!EMAIL_RE.test(email)) {
        throw Errors.badRequest('Invalid email address.');
      }

      const user = await registerService.register(email, password);

      // Structured log for successful registration (no PII in production logs)
      console.info(
        JSON.stringify({
          type: 'auth',
          event: 'STARTUP_REGISTER_SUCCESS',
          userId: user.id,
          role: user.role,
          timestamp: new Date().toISOString(),
        }),
      );

      res.status(201).json({
        user: { id: user.id, email: user.email, role: user.role },
      });
    } catch (error) {
      if (error instanceof DuplicateEmailError) {
        next(Errors.conflict('Email already registered'));
        return;
      }
      if (error instanceof UniqueConstraintError) {
        next(Errors.conflict('Email already registered'));
        return;
      }
      next(error);
    }
  };
};
