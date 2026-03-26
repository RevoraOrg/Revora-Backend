import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyToken } from '../lib/jwt';
import { SessionRepository } from '../db/repositories/sessionRepository';
import { UserRole } from '../auth/login/types';

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
 * If the session is revoked or expired, it returns 401.
 */
export const createRequireAuthWithSession = (
    sessionRepository: SessionRepository,
): RequestHandler => {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid token' });
            return;
        }

        const token = authHeader.slice(7);

        try {
            const payload = verifyToken(token);
            const sessionId = payload.sid as string;
            const userId = payload.sub;

            if (!sessionId) {
                res.status(401).json({ error: 'Unauthorized', message: 'Token missing session identifier' });
                return;
            }

            // Check session in DB
            const session = await sessionRepository.findById(sessionId);

            if (!session) {
                res.status(401).json({ error: 'Unauthorized', message: 'Session not found' });
                return;
            }

            if (session.revoked_at) {
                res.status(401).json({ error: 'Unauthorized', message: 'Session has been revoked' });
                return;
            }

            if (new Date(session.expires_at) < new Date()) {
                res.status(401).json({ error: 'Unauthorized', message: 'Session has expired' });
                return;
            }

            (req as AuthenticatedRequest).auth = {
                userId,
                sessionId,
                role: payload.role as UserRole,
            };

            next();
        } catch (error) {
            res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token' });
        }
    };
};
