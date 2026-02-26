import { NextFunction, RequestHandler, Response } from 'express';
import { ChangePasswordService, ChangePasswordError } from './changePasswordService';
import { AuthenticatedRequest, ChangePasswordBody } from './types';

function isValidBody(body: unknown): body is ChangePasswordBody {
  if (typeof body !== 'object' || body === null) return false;
  const { currentPassword, newPassword } = body as Record<string, unknown>;
  return (
    typeof currentPassword === 'string' &&
    currentPassword.length > 0 &&
    typeof newPassword === 'string' &&
    newPassword.length >= 8
  );
}

export const createChangePasswordHandler = (
  changePasswordService: ChangePasswordService
): RequestHandler => {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      const userId = req.auth?.userId;
      const sessionId = req.auth?.sessionId;

      if (!userId || !sessionId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (!isValidBody(req.body)) {
        res.status(400).json({
          error:
            'Invalid request body. currentPassword and newPassword (min 8 chars) are required.',
        });
        return;
      }

      const { currentPassword, newPassword } = req.body;

      await changePasswordService.changePassword(
        userId,
        sessionId,
        currentPassword,
        newPassword
      );

      res.status(200).json({ message: 'Password changed successfully' });
    } catch (error) {
      if (error instanceof ChangePasswordError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      next(error);
    }
  };
};