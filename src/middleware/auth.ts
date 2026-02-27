import { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyToken, JwtPayload } from '../lib/jwt';
import crypto from 'crypto';
import { AuthContext, AuthenticatedRequest as LogoutAuthenticatedRequest } from '../auth/logout/types';

// ── AuthenticatedRequest (JWT / sub-based) ────────────────────────────────────
export interface AuthenticatedRequest extends Request {
  user?: {
    sub?: string;
    id?: string;
    email?: string;
    role?: string;
    [key: string]: unknown;
  };
}

// ── authMiddleware (Bearer JWT via lib/jwt) ───────────────────────────────────
export function authMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Unauthorized', message: 'Authorization header missing' });
      return;
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid authorization header format. Expected: Bearer <token>',
      });
      return;
    }

    const token = parts[1];

    try {
      const payload = verifyToken(token);
      (req as AuthenticatedRequest).user = {
        sub: payload.sub,
        email: payload.email,
        ...payload,
      };
      next();
    } catch (error) {
      let errorMessage = 'Invalid or expired token';
      if (error instanceof Error) {
        if (error.name === 'TokenExpiredError') errorMessage = 'Token has expired';
        else if (error.name === 'JsonWebTokenError') errorMessage = 'Invalid token signature';
      }
      res.status(401).json({ error: 'Unauthorized', message: errorMessage });
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
      const payload = verifyToken(parts[1]);
      (req as AuthenticatedRequest).user = { sub: payload.sub, email: payload.email, ...payload };
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

export function verifyJwt(token: string, secret: string): JwtPayloadInternal {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const [headerB64, payloadB64, signatureB64] = parts;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  if (expectedSig !== signatureB64) throw new Error('Invalid token signature');

  const payload: JwtPayloadInternal = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf8'),
  );

  if (payload.exp !== undefined && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return payload;
}

// ── requireInvestor ───────────────────────────────────────────────────────────
export function requireInvestor(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  try {
    const payload = verifyJwt(token, secret);
    if (payload.role !== 'investor') {
      res.status(403).json({ error: 'Forbidden: investor role required' });
      return;
    }
    (req as AuthenticatedRequest).user = { id: payload.sub, role: 'investor' };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── authMiddleware (mock — X-Issuer-Id header) ────────────────────────────────
// NOTE: named export collision with authMiddleware() above is intentional —
// this const shadows the factory fn for issuer-only routes.
export const requireIssuerAuth = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const issuerId = req.header('X-Issuer-Id');
  if (!issuerId) {
    res.status(401).json({ error: 'Unauthorized: Missing Issuer ID' });
    return;
  }
  req.user = { id: issuerId, role: 'issuer' };
  next();
};

// ── requireAuth (feature/change-password-api) ─────────────────────────────────
// Verifies HS256 Bearer JWT, populates req.auth with { userId, sessionId, tokenId }.
// Consumed by logoutRoute and changePasswordRoute via src/middleware/auth.ts.
export const requireAuth: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  try {
    const payload = verifyJwt(token, secret);
    const authContext: AuthContext = {
      userId: payload.sub,
      sessionId: payload.sid ?? '',
      tokenId: token,
    };
    (req as LogoutAuthenticatedRequest).auth = authContext;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
};