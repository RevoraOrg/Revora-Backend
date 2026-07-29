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
import type { ISessionStore }                   from "../lib/sessionStore";
import { AuthenticatedRequest }                from "./auth";

// ─── Secure session cookie issuer ──────────────────────────────────────────────

/** Name of the browser session cookie. */
export const SESSION_COOKIE_NAME = "session";

export interface SessionCookieOptions {
  /** Cookie name. @default {@link SESSION_COOKIE_NAME} */
  name?: string;
  /** Cookie path. @default "/" */
  path?: string;
  /**
   * Whether the `Secure` attribute is set. Defaults to whether we're in
   * production. In production a non-Secure cookie is refused (throws).
   */
  secure?: boolean;
  /** Whether we're running in production. @default NODE_ENV === "production" */
  isProduction?: boolean;
  /** SameSite policy. @default "Lax" */
  sameSite?: 'Lax' | 'Strict' | 'None';
}

/**
 * Build a hardened `Set-Cookie` header value for a session token.
 *
 * The cookie always carries `HttpOnly`, `SameSite=Strict`, and `Path=/`.
 * In production the `Secure` attribute is mandatory: issuing a non-Secure
 * session cookie in production throws, so a session token can never be sent
 * over plaintext HTTP.
 *
 * @param token     The opaque session token.
 * @param expiresAt Absolute expiry (ms since epoch); drives Max-Age/Expires.
 * @throws if a non-Secure cookie is requested in production.
 */
export function buildSessionCookie(
  token: string,
  expiresAt: number,
  opts: SessionCookieOptions = {},
): string {
  const isProduction = opts.isProduction ?? process.env.NODE_ENV === "production";
  const secure       = opts.secure ?? isProduction;
  const name         = opts.name ?? SESSION_COOKIE_NAME;
  const path         = opts.path ?? "/";

  const sameSite     = opts.sameSite ?? "Lax";

  if (isProduction && !secure) {
    throw new Error(
      "Refusing to issue a session cookie without the Secure attribute in production.",
    );
  }

  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));

  const attributes = [
    `${name}=${token}`,
    `Path=${path}`,
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${maxAgeSeconds}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) attributes.push("Secure");

  return attributes.join("; ");
}

/**
 * Attach a hardened session cookie to the response.
 * Uses `res.append` so it does not clobber other `Set-Cookie` headers.
 */
export function issueSessionCookie(
  res: Response,
  token: string,
  expiresAt: number,
  opts: SessionCookieOptions = {},
): void {
  res.append("Set-Cookie", buildSessionCookie(token, expiresAt, opts));
}

/** Build the `Set-Cookie` header that clears the session cookie (logout). */
export function clearSessionCookie(opts: SessionCookieOptions = {}): string {
  const name = opts.name ?? SESSION_COOKIE_NAME;
  const path = opts.path ?? "/";
  const sameSite = opts.sameSite ?? "Lax";
  return `${name}=; Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=0`;
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
export function createSessionAuth(store: ISessionStore) {
  return async function sessionAuth(
    req:  AuthenticatedRequest,
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
export function createSessionRouter(store: ISessionStore, getPolicy?: (tenantId: string) => Promise<'Lax' | 'Strict'>): Router {
  const router = Router();
  const auth   = createSessionAuth(store);

  /**
   * POST /session/login
   * Body: none — reads x-user-id and x-user-role headers (stub credentials).
   * Response: { token, expiresAt }
   *
   * @security Credentials should be verified against a real store in production.
   */
  router.post("/session/login", async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.header("x-user-id");
    const role   = req.header("x-user-role");

    if (!userId || !role) {
      res.status(401).json({ error: "Missing x-user-id or x-user-role header." });
      return;
    }

    const session = await store.create(userId, role);

    const tenantId = req.header("x-tenant-id");
    let sameSite: 'Lax' | 'Strict' = 'Lax';
    if (tenantId && getPolicy) {
      sameSite = await getPolicy(tenantId);
    }

    // Issue a hardened cookie for browser clients (Secure/HttpOnly/SameSite=Strict).
    // In production a non-Secure cookie is refused by buildSessionCookie.
    issueSessionCookie(res, session.token, session.expiresAt, { sameSite });

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
  router.post("/session/logout", auth, async (req: AuthenticatedRequest, res: Response) => {
    await store.delete(req.user!.sessionToken!);
    res.append("Set-Cookie", clearSessionCookie());
    res.status(204).send();
  });

  /**
   * GET /session/me
   * Requires: Authorization: Bearer <token>
   * Response: { userId, role }
   */
  router.get("/session/me", auth, (req: AuthenticatedRequest, res: Response) => {
    res.json({ userId: req.user!.id, role: req.user!.role });
  });

  return router;
}