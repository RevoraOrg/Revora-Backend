
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

export interface AuthenticatedRequest extends Request {
    user?: {
        id: string;
        role: 'issuer' | 'investor' | 'admin';
    };
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
) => {
    const issuerId = req.header('X-Issuer-Id');

    if (!issuerId) {
        return res.status(401).json({ error: 'Unauthorized: Missing Issuer ID' });
    }

    // Simulate user object injection
    req.user = {
        id: issuerId,
        role: 'issuer', // For this task, we simulate the issuer role
    };

    next();
};

