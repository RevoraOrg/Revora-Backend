
import {Request, Response, NextFunction, RequestHandler} from "express";
import {verifyToken, JwtPayload} from "../lib/jwt";

/**
 * Extended Request interface to include user
 */
export interface AuthenticatedRequest extends Request {
  user?: {
    sub: string;
    email?: string;
    [key: string]: unknown;
  };
}

/**
 * Authentication middleware
 *
 * Reads Bearer token from Authorization header, verifies signature and expiry,
 * and attaches the decoded user to req.user.
 *
 * @returns 401 Unauthorized if:
 *   - Authorization header is missing
 *   - Token is malformed
 *   - Token has invalid signature
 *   - Token has expired
 *
 * @example
 * // Using as Express middleware
 * app.get('/protected', authMiddleware, (req, res) => {
 *   const user = (req as AuthenticatedRequest).user;
 *   res.json({ userId: user?.sub });
 * });
 */
export function authMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    // Check if Authorization header exists
    if (!authHeader) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Authorization header missing",
      });
      return;
    }

    // Check if it's a Bearer token
    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      res.status(401).json({
        error: "Unauthorized",
        message:
          "Invalid authorization header format. Expected: Bearer <token>",
      });
      return;
    }

    const token = parts[1];

    // Verify and decode the token
    try {
      const payload = verifyToken(token);

      // Attach user to request
      (req as AuthenticatedRequest).user = {
        sub: payload.sub,
        email: payload.email,
        ...payload,
      };

      next();
    } catch (error) {
      // Determine error type for appropriate message
      let errorMessage = "Invalid or expired token";

      if (error instanceof Error) {
        if (error.name === "TokenExpiredError") {
          errorMessage = "Token has expired";
        } else if (error.name === "JsonWebTokenError") {
          errorMessage = "Invalid token signature";
        }
      }

      res.status(401).json({
        error: "Unauthorized",
        message: errorMessage,
      });
    }
  };
}

/**
 * Optional authentication middleware
 *
 * Similar to authMiddleware but does not return 401 if token is missing.
 * Attaches user if valid token present, otherwise sets req.user to undefined.
 *
 * Useful for routes that have different behavior for authenticated vs unauthenticated users.
 */
export function optionalAuthMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      (req as AuthenticatedRequest).user = undefined;
      next();
      return;
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      (req as AuthenticatedRequest).user = undefined;
      next();
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
    } catch {
      // Silently continue without user for optional auth
      (req as AuthenticatedRequest).user = undefined;
    }

    next();
  };
}

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: 'issuer' | 'investor' | 'admin';
  };
}

interface JwtPayload {
  sub: string;
  role: string;
  iat?: number;
  exp?: number;
}

/**
 * Verify a HS256 JWT using Node.js built-in crypto.
 * @throws Error if the token is malformed, has an invalid signature, or is expired.
 */
export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token format');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  if (expectedSig !== signatureB64) {
    throw new Error('Invalid token signature');
  }

  const payload: JwtPayload = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf8')
  );

  if (payload.exp !== undefined && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return payload;
}

/**
 * Express middleware that requires a valid JWT with role=investor.
 * Reads the Bearer token from the Authorization header and attaches
 * the decoded payload to req.user.
 */
export function requireInvestor(
  req: Request,
  res: Response,
  next: NextFunction
): void {
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

    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      role: 'investor',
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Mock authentication middleware.
 * In a real application, this would verify a JWT or session.
 * For this task, we assume the issuer ID is provided in the 'X-Issuer-Id' header.
 */
export const authMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  const issuerId = req.header('X-Issuer-Id');

  if (!issuerId) {
    res.status(401).json({ error: 'Unauthorized: Missing Issuer ID' });
    return;
  }

  req.user = {
    id: issuerId,
    role: 'issuer',
  };

  next();
};

