import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyJwt } from '../utils/jwt';
import { AuthContext, AuthenticatedRequest } from '../auth/logout/types';

/**
 * JWT authentication middleware.
 *
 * - Reads Authorization: Bearer <token>
 * - Verifies signature and expiry
 * - Populates req.auth with { userId, sessionId }
 * - Returns 401 if token is absent or invalid
 *
 * This is the requireAuth dependency consumed by logoutRoute and changePasswordRoute.
 */
export const requireAuth: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyJwt(token);

  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const authContext: AuthContext = {
    userId: payload.sub,
    sessionId: payload.sid,
    tokenId: token,
  };

  (req as AuthenticatedRequest).auth = authContext;
  next();
};