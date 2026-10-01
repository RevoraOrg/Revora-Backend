import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ChangePasswordService } from './changePasswordService';
import { Errors } from '../../lib/errors';

/** Minimal request shape carrying the auth principal set by requireAuth. */
type RequestWithUser = Request & {
  user?: { sub?: string; id?: string };
};

/**
 * Express handler factory for `POST /me/change-password`
 * (alias: `PATCH /me/password`).
 *
 * Reads the authenticated principal from `req.user` (set by createRequireAuth),
 * validates the body shape, delegates to ChangePasswordService, and translates
 * the service's discriminated-union result into HTTP responses:
 *   - `{ ok: true }`                                  → 200
 *   - `{ ok: false, reason: 'VALIDATION_ERROR', ... }` → 400
 *   - `{ ok: false, reason: 'WRONG_PASSWORD', ... }`   → 401
 *   - `{ ok: false, reason: 'USER_NOT_FOUND', ... }`   → 404
 * Unexpected exceptions are forwarded to `next(error)` unchanged.
 */
export const createChangePasswordHandler = (
  changePasswordService: ChangePasswordService,
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Support both sub (JWT) and id (mock auth)
      const user = (req as RequestWithUser).user;
      const userId = user?.sub ?? user?.id;
      if (!userId) {
        throw Errors.unauthorized('User not authenticated');
      }

      const { currentPassword, newPassword } = req.body ?? {};

      if (!currentPassword || !newPassword) {
        throw Errors.badRequest('Both currentPassword and newPassword are required');
      }

      const result = await changePasswordService.execute({
        userId,
        currentPassword,
        newPassword,
      });

      // The service returns a discriminated union rather than throwing for
      // domain failures — map each reason onto the documented HTTP contract.
      if (!result.ok) {
        switch (result.reason) {
          case 'VALIDATION_ERROR':
            throw Errors.validationError(result.message);
          case 'WRONG_PASSWORD':
            throw Errors.unauthorized(result.message);
          case 'USER_NOT_FOUND':
            throw Errors.notFound(result.message);
          default: {
            const exhaustive: never = result;
            throw Errors.internal(
              `Unhandled change-password failure: ${JSON.stringify(exhaustive)}`,
            );
          }
        }
      }

      res.status(200).json({ ok: true, message: 'Password updated successfully' });
    } catch (error) {
      next(error);
    }
  };
};