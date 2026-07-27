import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyToken, JwtPayload, getDefaultClaimValidationOptions, getJwtSecretsForVerification } from '../lib/jwt';
import crypto from 'crypto';
import { AuthContext, AuthenticatedRequest as LogoutAuthenticatedRequest } from '../auth/logout/types';
import { SessionRepository as DbSessionRepository } from '../db/repositories/sessionRepository';
import { hashSessionToken, isSessionExpired } from '../auth/session';
import { Errors } from '../lib/errors';
import { globalLogger } from '../lib/logger';

// ── AuthenticatedRequest (JWT / sub-based) ────────────────────────────────────
export interface AuthenticatedRequest extends Request {
  user?: {
    sub?: string;
    id?: string;
    email?: string;
    role?: string;
    sessionToken?: string;
    [key: string]: unknown;
  };
}

// ── authMiddleware (Bearer JWT via lib/jwt) ───────────────────────────────────
export function authMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      globalLogger.warn('Auth failed: Authorization header missing', { path: req.path });
      next(Errors.unauthorized('Authorization header missing'));
      return;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      globalLogger.warn('Auth failed: Invalid auth header format', { path: req.path });
      next(Errors.unauthorized('Invalid authorization header format. Expected: Bearer <token>'));
      return;
    }

    const token = parts[1];

    try {
      const claimOpts = getDefaultClaimValidationOptions();
      const payload = verifyToken(token, claimOpts);
      (req as AuthenticatedRequest).user = {
        ...payload,
        sub: payload.sub,
        email: payload.email,
      };
      next();
    } catch (error) {
      if (error instanceof Error && error.message.includes('JWT_SECRET')) {
        next(Errors.internal('Server configuration error'));
        return;
      }
      globalLogger.warn('Auth failed: JWT verification error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        path: req.path,
      });
      next(Errors.unauthorized('Invalid or expired token'));
    }
  };
}

// ── optionalAuthMiddleware ────────────────────────────────────────────────────
export function optionalAuthMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      (req as AuthenticatedRequest).user = undefined;
      next();
      return;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      (req as AuthenticatedRequest).user = undefined;
      next();
      return;
    }

    try {
      const claimOpts = getDefaultClaimValidationOptions();
      const payload = verifyToken(parts[1], claimOpts);
      (req as AuthenticatedRequest).user = {
        ...payload,
        sub: payload.sub,
        email: payload.email,
      };
    } catch {
      (req as AuthenticatedRequest).user = undefined;
    }

    next();
  };
}

// ── verifyJwt (HS256 via crypto) ──────────────────────────────────────────────
interface JwtPayloadInternal {
  sub: string;
  role: string;
  sid?: string;
  iat?: number;
  exp?: number;
}

/**
 * @notice Verify a JWT using raw HMAC-SHA256 with key rotation support.
 * @dev Accepts a single secret or an array of secrets (current first, previous second).
 *      The first secret that produces a valid signature wins.
 * @param token JWT string to verify.
 * @param secretOrSecrets One or more HMAC secrets to try, in priority order.
 * @returns Decoded payload if signature and expiry are valid.
 * @throws {Error} If the token format, signature, or expiry is invalid.
 */
export function verifyJwt(token: string, secretOrSecrets: string | string[]): JwtPayloadInternal {
  const secrets = Array.isArray(secretOrSecrets) ? secretOrSecrets : [secretOrSecrets];
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const [headerB64, payloadB64, signatureB64] = parts;

  let payload: JwtPayloadInternal | null = null;
  for (const secret of secrets) {
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    if (expectedSig === signatureB64) {
      try {
        payload = JSON.parse(
          Buffer.from(payloadB64, 'base64url').toString('utf8'),
        ) as JwtPayloadInternal;
        break;
      } catch {
        continue;
      }
    }
  }

  if (!payload) throw new Error('Invalid token signature');

  if (payload.exp !== undefined && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return payload;
}

// ── requireInvestor ───────────────────────────────────────────────────────────
export function requireInvestor(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    globalLogger.warn('Auth failed: Missing or invalid Bearer token for investor route', {
      path: req.path,
    });
    next(Errors.unauthorized('Missing or invalid Authorization header'));
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    globalLogger.critical('Server config error: JWT_SECRET missing');
    next(Errors.internal('Server configuration error'));
    return;
  }

  try {
    const secrets = getJwtSecretsForVerification();
    const payload = verifyJwt(token, secrets);
    if (payload.role !== 'investor') {
      globalLogger.warn('Auth failed: Forbidden role for investor route', {
        role: payload.role,
        userId: payload.sub,
        path: req.path,
      });
      next(Errors.forbidden('Forbidden: investor role required'));
      return;
    }
    (req as AuthenticatedRequest).user = { id: payload.sub, role: 'investor' };
    next();
  } catch (error) {
    globalLogger.warn('Auth failed: Investor token verification failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      path: req.path,
    });
    next(Errors.unauthorized('Invalid or expired token'));
  }
}

// ── requireAdmin ──────────────────────────────────────────────────────────────
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    globalLogger.warn('Auth failed: Missing or invalid Bearer token for admin route', {
      path: req.path,
    });
    next(Errors.unauthorized('Missing or invalid Authorization header'));
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    globalLogger.critical('Server config error: JWT_SECRET missing');
    next(Errors.internal('Server configuration error'));
    return;
  }

  try {
    const secrets = getJwtSecretsForVerification();
    const payload = verifyJwt(token, secrets);
    if (payload.role !== 'admin') {
      globalLogger.warn('Auth failed: Forbidden role for admin route', {
        role: payload.role,
        userId: payload.sub,
        path: req.path,
      });
      next(Errors.forbidden('Forbidden: admin role required'));
      return;
    }
    (req as AuthenticatedRequest).user = { id: payload.sub, role: 'admin' };
    next();
  } catch (error) {
    globalLogger.warn('Auth failed: Admin token verification failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      path: req.path,
    });
    next(Errors.unauthorized('Invalid or expired token'));
  }
}

// ── authMiddleware (mock — X-Issuer-Id header) ────────────────────────────────
// NOTE: named export collision with authMiddleware() above is intentional —
// this const shadows the factory fn for issuer-only routes.
export const requireIssuerAuth = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void => {
  const issuerId = req.header('X-Issuer-Id');
  if (!issuerId) {
    globalLogger.warn('Auth failed: Missing Issuer ID header', { path: req.path });
    next(Errors.unauthorized('Unauthorized: Missing Issuer ID'));
    return;
  }
  req.user = { id: issuerId, role: 'issuer' };
  next();
};

// ── createRequireAuth (session-hardened)
export function createRequireAuth(sessionRepository: DbSessionRepository): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      globalLogger.warn('Auth failed: Missing or invalid Authorization header', { path: req.path });
      next(Errors.unauthorized('Unauthorized: Missing or invalid Authorization header'));
      return;
    }

    const token = authHeader.slice(7);
    let payload: JwtPayload;

    try {
      const claimOpts = getDefaultClaimValidationOptions();
      payload = verifyToken(token, claimOpts);
    } catch (err) {
      globalLogger.warn('Auth failed: JWT verification error', {
        error: err instanceof Error ? err.message : 'Unknown error',
        path: req.path,
      });
      next(Errors.unauthorized('Unauthorized: invalid or expired token'));
      return;
    }

    if (!payload.sub || !payload.sid) {
      globalLogger.warn('Auth failed: Token missing sub or sid', { path: req.path });
      next(Errors.unauthorized('Unauthorized: token missing subject or session'));
      return;
    }

    const session = await sessionRepository.findById(payload.sid);

    if (!session || session.user_id !== payload.sub) {
      globalLogger.warn('Auth failed: Session not found or user mismatch', {
        sessionId: payload.sid,
        userId: payload.sub,
        path: req.path,
      });
      next(Errors.unauthorized('Unauthorized: session not found or user mismatch'));
      return;
    }

    if (isSessionExpired(session.expires_at)) {
      globalLogger.warn('Auth failed: Session expired', {
        sessionId: payload.sid,
        userId: payload.sub,
        path: req.path,
      });
      next(Errors.unauthorized('Unauthorized: session expired'));
      return;
    }

    if (hashSessionToken(token) !== session.token_hash) {
      globalLogger.warn('Auth failed: Token hash mismatch', {
        sessionId: payload.sid,
        userId: payload.sub,
        path: req.path,
      });
      next(Errors.unauthorized('Unauthorized: token mismatch'));
      return;
    }

    (req as any).auth = {
      userId: payload.sub,
      sessionId: payload.sid,
      tokenId: token,
    } as AuthContext;

    (req as AuthenticatedRequest).user = {
      sub: payload.sub,
      id: payload.sub,
      role: payload.role as string,
    };

    next();
  };
}

export function requireAuth(sessionRepository: DbSessionRepository): RequestHandler {
  return createRequireAuth(sessionRepository);
}