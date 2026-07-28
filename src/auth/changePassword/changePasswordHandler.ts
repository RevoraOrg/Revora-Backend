import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ChangePasswordService } from './changePasswordService';
import { Errors } from '../../lib/errors';

/**
 * Express handler factory for `POST /api/auth/change-password`.
 */
export const createChangePasswordHandler = (
  changePasswordService: ChangePasswordService,
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Support both sub (JWT) and id (mock auth)
      const userId = (req as any).user?.sub ?? (req as any).user?.id;
      if (!userId) {
        throw Errors.unauthorized('User not authenticated');
      }

      const { currentPassword, newPassword } = req.body ?? {};

      if (!currentPassword || !newPassword) {
        throw Errors.badRequest('Both currentPassword and newPassword are required');
      }

      await changePasswordService.execute({
        userId,
        currentPassword,
        newPassword,
      });

      res.status(200).json({ ok: true, message: 'Password updated successfully' });
    } catch (error) {
      next(error);
    }
  };
};