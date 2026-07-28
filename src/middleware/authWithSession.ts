import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyToken } from '../lib/jwt';
import { SessionRepository } from '../db/repositories/sessionRepository';
import { UserRole } from '../auth/login/types';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';
import { isSessionExpired } from '../auth/session';

export interface AuthContext {
  userId: string;
  sessionId: string;
  role: UserRole;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}

/**
 * Middleware that verifies the JWT AND checks the session in the database.
 * If the session is revoked or expired, it returns 401 using lib/errors.
 */
export const createRequireAuthWithSession = (
  sessionRepository: SessionRepository,
): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      globalLogger.warn('Authentication failed: Missing or malformed token', {
        path: req.path,
        method: req.method,
        ip: req.ip,
      });
      next(Errors.unauthorized('Missing or invalid token'));
      return;
    }

    const token = authHeader.slice(7);

    try {
      const payload = verifyToken(token);
      const sessionId = payload.sid as string;
      const userId = payload.sub;

      if (!sessionId) {
        globalLogger.warn('Authentication failed: Token missing session identifier', {
          userId,
          path: req.path,
        });
        next(Errors.unauthorized('Invalid token payload: missing session identifier'));
        return;
      }

      // Check session in DB
      const session = await sessionRepository.findById(sessionId);

      if (!session) {
        globalLogger.warn('Authentication failed: Session not found', {
          sessionId,
          userId,
          path: req.path,
        });
        next(Errors.unauthorized('Session not found'));
        return;
      }

      if (session.revoked_at) {
        globalLogger.warn('Authentication failed: Session revoked', {
          sessionId,
          userId,
          path: req.path,
        });
        next(Errors.unauthorized('Session has been revoked'));
        return;
      }

      if (isSessionExpired(session.expires_at)) {
        globalLogger.warn('Authentication failed: Session expired', {
          sessionId,
          userId,
          path: req.path,
        });
        next(Errors.unauthorized('Session has expired'));
        return;
      }

      (req as AuthenticatedRequest).auth = {
        userId,
        sessionId,
        role: payload.role as UserRole,
      };

      next();
    } catch (error) {
      globalLogger.warn('Authentication failed: Invalid or expired token', {
        error: error instanceof Error ? error.message : 'Unknown error',
        path: req.path,
      });
      next(Errors.unauthorized('Invalid or expired token'));
    }
  };
};
