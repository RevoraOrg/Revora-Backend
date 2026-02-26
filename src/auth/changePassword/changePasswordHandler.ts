import { Request, Response, NextFunction } from 'express';
import { ChangePasswordService } from './changePasswordService';

// Re-use the AuthenticatedRequest shape already in the codebase.
// req.user.sub  → set by the JWT authMiddleware (src/middleware/auth.ts, line 35)
// req.user.id   → set by the mock requireAuth stub in src/index.ts (line 103)
interface AuthedReq extends Request {
  user?: { sub?: string; id?: string; [key: string]: unknown };
}

export function createChangePasswordHandler(service: ChangePasswordService) {
  return async function changePasswordHandler(
    req: AuthedReq,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // Support both middleware conventions present in the codebase
      const userId = (req.user?.sub ?? req.user?.id) as string | undefined;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized', message: 'No authenticated user.' });
        return;
      }

      const { currentPassword, newPassword } = req.body as Record<string, unknown>;

      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Body must include currentPassword and newPassword as strings.',
        });
        return;
      }

      const result = await service.execute({ userId, currentPassword, newPassword });

      if (result.ok) {
        res.status(200).json({ message: 'Password updated successfully.' });
        return;
      }

      switch (result.reason) {
        case 'VALIDATION_ERROR':
          res.status(400).json({ error: 'Validation Error', message: result.message });
          break;
        case 'WRONG_PASSWORD':
          res.status(401).json({ error: 'Unauthorized', message: result.message });
          break;
        case 'USER_NOT_FOUND':
          res.status(404).json({ error: 'Not Found', message: result.message });
          break;
        default:
          res.status(500).json({ error: 'Internal Server Error', message: 'Unexpected error.' });
      }
    } catch (err) {
      next(err);
    }
  };
}