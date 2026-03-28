/**
 * @module middleware/session
 * @description
 * Session-aware authentication middleware for the Revora backend.
 *
 * Replaces the original header-only auth check with a two-step process:
 *   1. Extract the session token from the `Authorization: Bearer <token>` header.
 *   2. Validate the token against the SessionStore (which enforces TTL).
 *
 * Backward-compatibility note:
 *   The original index.ts read `x-user-id` and `x-user-role` headers directly.
 *   This middleware supersedes that approach; the headers are no longer trusted
 *   as auth credentials.  They may still be forwarded by internal services but
 *   are NOT checked here.
 *
 * @security
 *  - The session token is the only auth credential accepted.
 *  - Expired sessions are indistinguishable from unknown ones (both → 401).
 *  - The `req.user` object is populated exclusively from the server-side
 *    session record — never from request headers or body.
 *  - Logout invalidates the server-side record immediately; token replay after
 *    logout returns 401.
 */

import type { Request, Response, NextFunction } from "express";
import { Router }                               from "express";
import type { SessionStore }                    from "../lib/sessionStore";

// ─── Augment Express Request ──────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: string; sessionToken: string };
    }
  }
}

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Returns an Express middleware that authenticates requests via session token.
 *
 * @param store - The SessionStore instance to validate tokens against.
 *
 * @example
 * app.use("/api", createSessionAuth(sessionStore));
 */
export function createSessionAuth(store: SessionStore) {
  return async function sessionAuth(
    req:  Request,
    res:  Response,
    next: NextFunction
  ): Promise<void> {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or malformed Authorization header." });
      return;
    }

    const token   = authHeader.slice(7);
    const session = await store.get(token);

    if (!session) {
      // Expired and unknown sessions are both 401 — no observable difference.
      res.status(401).json({ error: "Session not found or expired." });
      return;
    }

    // Attach the server-side record to the request — never trust header claims.
    req.user = {
      id:           session.userId,
      role:         session.role,
      sessionToken: session.token,
    };

    next();
  };
}

// ─── Session management routes ────────────────────────────────────────────────

/**
 * Creates a router that exposes session lifecycle endpoints:
 *   POST /session/login   — exchange credentials for a session token
 *   POST /session/logout  — invalidate the current session
 *   GET  /session/me      — return the current session's user context
 *
 * @param store - The SessionStore instance.
 *
 * @security
 *  - Login validates the `x-user-id` and `x-user-role` headers as stand-in
 *    credentials (matches the original index.ts pattern).  In production these
 *    should be replaced with real credential verification (password hash check,
 *    OAuth token exchange, etc.).
 *  - The session token returned by login is the ONLY credential for subsequent
 *    requests.  Headers are not re-read after login.
 */
export function createSessionRouter(store: SessionStore): Router {
  const router = Router();
  const auth   = createSessionAuth(store);

  /**
   * POST /session/login
   * Body: none — reads x-user-id and x-user-role headers (stub credentials).
   * Response: { token, expiresAt }
   *
   * @security Credentials should be verified against a real store in production.
   */
  router.post("/session/login", async (req: Request, res: Response) => {
    const userId = req.header("x-user-id");
    const role   = req.header("x-user-role");

    if (!userId || !role) {
      res.status(401).json({ error: "Missing x-user-id or x-user-role header." });
      return;
    }

    const session = await store.create(userId, role);

    res.status(201).json({
      token:     session.token,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });

  /**
   * POST /session/logout
   * Requires: Authorization: Bearer <token>
   * Response: 204 No Content
   */
  router.post("/session/logout", auth, async (req: Request, res: Response) => {
    await store.delete(req.user!.sessionToken);
    res.status(204).send();
  });

  /**
   * GET /session/me
   * Requires: Authorization: Bearer <token>
   * Response: { userId, role }
   */
  router.get("/session/me", auth, (req: Request, res: Response) => {
    res.json({ userId: req.user!.id, role: req.user!.role });
  });

  return router;
}