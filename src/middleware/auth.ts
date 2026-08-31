import { Request, Response, NextFunction, RequestHandler } from "express";
import {
  verifyToken,
  JwtPayload,
  getDefaultClaimValidationOptions,
  getJwtSecretsForVerification,
  AdminSignedStatusTransitionPayload,
  AdminSignatureReplayCache,
  InMemoryAdminSignatureReplayCache,
  ADMIN_SIGNATURE_ALLOWED_CLOCK_SKEW_SECONDS,
  isAdminSignatureTimestampFresh,
  loadAdminEd25519PublicKeys,
  verifyAdminStatusTransitionSignature,
} from "../lib/jwt";
import crypto from "crypto";
import {
  AuthContext,
  AuthenticatedRequest as LogoutAuthenticatedRequest,
} from "../auth/logout/types";
import { SessionRepository as DbSessionRepository } from "../db/repositories/sessionRepository";
import { hashSessionToken, isSessionExpired } from "../auth/session";
import { Errors } from "../lib/errors";
import { globalLogger } from "../lib/logger";

export interface AdminSignatureContext {
  kid: string;
  action: AdminSignedStatusTransitionPayload["action"];
  offeringId: string;
  nonce: string;
  timestamp: number;
}

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
  adminSignature?: AdminSignatureContext;
}

// ── authMiddleware (Bearer JWT via lib/jwt) ───────────────────────────────────
export function authMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      globalLogger.warn("Auth failed: Authorization header missing", {
        path: req.path,
      });
      next(Errors.unauthorized("Authorization header missing"));
      return;
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
      globalLogger.warn("Auth failed: Invalid auth header format", {
        path: req.path,
      });
      next(
        Errors.unauthorized(
          "Invalid authorization header format. Expected: Bearer <token>",
        ),
      );
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
      if (error instanceof Error && error.message.includes("JWT_SECRET")) {
        next(Errors.internal("Server configuration error"));
        return;
      }
      globalLogger.warn("Auth failed: JWT verification error", {
        error: error instanceof Error ? error.message : "Unknown error",
        path: req.path,
      });
      next(Errors.unauthorized("Invalid or expired token"));
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

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") {
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
export function verifyJwt(
  token: string,
  secretOrSecrets: string | string[],
): JwtPayloadInternal {
  const secrets = Array.isArray(secretOrSecrets)
    ? secretOrSecrets
    : [secretOrSecrets];
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid token format");

  const [headerB64, payloadB64, signatureB64] = parts;

  let payload: JwtPayloadInternal | null = null;
  for (const secret of secrets) {
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");

    if (expectedSig === signatureB64) {
      try {
        payload = JSON.parse(
          Buffer.from(payloadB64, "base64url").toString("utf8"),
        ) as JwtPayloadInternal;
        break;
      } catch {
        continue;
      }
    }
  }

  if (!payload) throw new Error("Invalid token signature");

  if (
    payload.exp !== undefined &&
    payload.exp < Math.floor(Date.now() / 1000)
  ) {
    throw new Error("Token expired");
  }

  return payload;
}

// ── requireInvestor ───────────────────────────────────────────────────────────
export function requireInvestor(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    globalLogger.warn(
      "Auth failed: Missing or invalid Bearer token for investor route",
      {
        path: req.path,
      },
    );
    next(Errors.unauthorized("Missing or invalid Authorization header"));
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    globalLogger.critical("Server config error: JWT_SECRET missing");
    next(Errors.internal("Server configuration error"));
    return;
  }

  try {
    const secrets = getJwtSecretsForVerification();
    const payload = verifyJwt(token, secrets);
    if (payload.role !== "investor") {
      globalLogger.warn("Auth failed: Forbidden role for investor route", {
        role: payload.role,
        userId: payload.sub,
        path: req.path,
      });
      next(Errors.forbidden("Forbidden: investor role required"));
      return;
    }
    (req as AuthenticatedRequest).user = { id: payload.sub, role: "investor" };
    next();
  } catch (error) {
    globalLogger.warn("Auth failed: Investor token verification failed", {
      error: error instanceof Error ? error.message : "Unknown error",
      path: req.path,
    });
    next(Errors.unauthorized("Invalid or expired token"));
  }
}

// ── requireCompliance ─────────────────────────────────────────────────────────
/**
 * Require the caller to hold the `compliance` or `admin` role.
 *
 * Compliance officers need full access to sanctions changelog endpoints.
 * Admins retain access for operational support purposes.
 *
 * Security assumptions:
 * - JWT is verified by this middleware; no upstream auth is assumed.
 * - Role is read from the verified payload, never from a request header.
 */
export function requireCompliance(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    globalLogger.warn(
      "Auth failed: Missing or invalid Bearer token for compliance route",
      {
        path: req.path,
      },
    );
    next(Errors.unauthorized("Missing or invalid Authorization header"));
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    globalLogger.critical("Server config error: JWT_SECRET missing");
    next(Errors.internal("Server configuration error"));
    return;
  }

  try {
    const secrets = getJwtSecretsForVerification();
    const payload = verifyJwt(token, secrets);
    const allowedRoles = ["compliance", "admin"];
    if (!allowedRoles.includes(payload.role)) {
      globalLogger.warn("Auth failed: Forbidden role for compliance route", {
        role: payload.role,
        userId: payload.sub,
        path: req.path,
      });
      next(Errors.forbidden("Forbidden: compliance role required"));
      return;
    }
    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      role: payload.role,
    };
    next();
  } catch (error) {
    globalLogger.warn("Auth failed: Compliance token verification failed", {
      error: error instanceof Error ? error.message : "Unknown error",
      path: req.path,
    });
    next(Errors.unauthorized("Invalid or expired token"));
  }
}

// ── requireAdmin ──────────────────────────────────────────────────────────────
export function requireAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    globalLogger.warn(
      "Auth failed: Missing or invalid Bearer token for admin route",
      {
        path: req.path,
      },
    );
    next(Errors.unauthorized("Missing or invalid Authorization header"));
    return;
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    globalLogger.critical("Server config error: JWT_SECRET missing");
    next(Errors.internal("Server configuration error"));
    return;
  }

  try {
    const secrets = getJwtSecretsForVerification();
    const payload = verifyJwt(token, secrets);
    if (payload.role !== "admin") {
      globalLogger.warn("Auth failed: Forbidden role for admin route", {
        role: payload.role,
        userId: payload.sub,
        path: req.path,
      });
      next(Errors.forbidden("Forbidden: admin role required"));
      return;
    }
    // Attribute admin actions (e.g. signed audit-log CSV export) to a concrete
    // principal. `sub` is populated alongside `id` for parity with the other
    // auth middlewares so downstream audit logging can record the acting admin.
    (req as AuthenticatedRequest).user = {
      sub: payload.sub,
      id: payload.sub,
      role: "admin",
      ...(payload.sid ? { sessionToken: payload.sid } : {}),
    };
    next();
  } catch (error) {
    globalLogger.warn("Auth failed: Admin token verification failed", {
      error: error instanceof Error ? error.message : "Unknown error",
      path: req.path,
    });
    next(Errors.unauthorized("Invalid or expired token"));
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
  const issuerId = req.header("X-Issuer-Id");
  if (!issuerId) {
    globalLogger.warn("Auth failed: Missing Issuer ID header", {
      path: req.path,
    });
    next(Errors.unauthorized("Unauthorized: Missing Issuer ID"));
    return;
  }
  req.user = { id: issuerId, role: "issuer" };
  next();
};

// ── createRequireAuth (session-hardened)
export function createRequireAuth(
  sessionRepository: DbSessionRepository,
): RequestHandler {
  return async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      globalLogger.warn(
        "Auth failed: Missing or invalid Authorization header",
        { path: req.path },
      );
      next(
        Errors.unauthorized(
          "Unauthorized: Missing or invalid Authorization header",
        ),
      );
      return;
    }

    const token = authHeader.slice(7);
    let payload: JwtPayload;

    try {
      const claimOpts = getDefaultClaimValidationOptions();
      payload = verifyToken(token, claimOpts);
    } catch (err) {
      globalLogger.warn("Auth failed: JWT verification error", {
        error: err instanceof Error ? err.message : "Unknown error",
        path: req.path,
      });
      next(Errors.unauthorized("Unauthorized: invalid or expired token"));
      return;
    }

    if (!payload.sub || !payload.sid) {
      globalLogger.warn("Auth failed: Token missing sub or sid", {
        path: req.path,
      });
      next(
        Errors.unauthorized("Unauthorized: token missing subject or session"),
      );
      return;
    }

    const session = await sessionRepository.findById(payload.sid);

    if (!session || session.user_id !== payload.sub) {
      globalLogger.warn("Auth failed: Session not found or user mismatch", {
        sessionId: payload.sid,
        userId: payload.sub,
        path: req.path,
      });
      next(
        Errors.unauthorized("Unauthorized: session not found or user mismatch"),
      );
      return;
    }

    if (isSessionExpired(session.expires_at)) {
      globalLogger.warn("Auth failed: Session expired", {
        sessionId: payload.sid,
        userId: payload.sub,
        path: req.path,
      });
      next(Errors.unauthorized("Unauthorized: session expired"));
      return;
    }

    if (hashSessionToken(token) !== session.token_hash) {
      globalLogger.warn("Auth failed: Token hash mismatch", {
        sessionId: payload.sid,
        userId: payload.sub,
        path: req.path,
      });
      next(Errors.unauthorized("Unauthorized: token mismatch"));
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

export function requireAuth(
  sessionRepository: DbSessionRepository,
): RequestHandler {
  return createRequireAuth(sessionRepository);
}

// ── Shared replay cache for admin signatures (module-level singleton) ────────
const defaultAdminSignatureReplayCache: AdminSignatureReplayCache =
  new InMemoryAdminSignatureReplayCache();

// ── Lazy-loaded admin public keys (cached after first read) ──────────────────
let adminPubKeysCache: ReturnType<typeof loadAdminEd25519PublicKeys> | null =
  null;
function getAdminPubKeys(): ReturnType<
  typeof loadAdminEd25519PublicKeys
> | null {
  if (adminPubKeysCache) return adminPubKeysCache;
  try {
    adminPubKeysCache = loadAdminEd25519PublicKeys();
    return adminPubKeysCache;
  } catch (err) {
    globalLogger.critical("[AdminEd25519] Failed to load admin public keys", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Action → expected HTTP route segment map (for cross-checking) ────────────
const ACTION_TO_PATH_SEGMENT: Record<
  AdminSignedStatusTransitionPayload["action"],
  string
> = {
  approve: "approve",
  reject: "reject",
  publish: "publish",
  archive: "archive",
  close: "close",
  cancel: "cancel",
};

/**
 * @notice Middleware factory: require admin JWT session **plus** a valid
 *         Ed25519 signature over the status-transition payload.
 *
 * Security assumptions:
 * - Re-runs the session/role check defensively before verifying the signature.
 * - The signed `action` and `offeringId` match the values the handler will
 *   actually execute; the middleware attaches `req.adminSignature` so
 *   downstream code can enforce a second cross-check.
 * - Nonces are unique per kid within the replay-cache window (300 s default).
 * - Timestamps must fall within ±30 s of server time (clock skew tolerance).
 * - Public keys come from `ADMIN_ED25519_PUBKEYS` env; an unknown kid is rejected.
 *
 * Request contract:
 *   Headers:
 *     x-admin-kid         : key id referencing ADMIN_ED25519_PUBKEYS
 *     x-admin-signature   : base64url Ed25519 signature
 *   Body (JSON):
 *     action      : "approve" | "reject" | "publish" | "archive" | "close" | "cancel"
 *     offeringId  : UUID or offering identifier
 *     nonce       : random unique string (≥16 chars recommended)
 *     timestamp   : Unix seconds integer
 *
 * @param replayCache Optional replay cache (default: module-level in-memory).
 * @param expectedAction If provided, additionally asserts that the signed
 *                       `action` matches this value. Prevents replaying a
 *                       "reject" signature against an "approve" route.
 */
export function requireAdminWithEd25519Signature(options?: {
  replayCache?: AdminSignatureReplayCache;
  expectedAction?: AdminSignedStatusTransitionPayload["action"];
}): RequestHandler {
  const replayCache = options?.replayCache ?? defaultAdminSignatureReplayCache;
  const expectedAction = options?.expectedAction;

  return (req: Request, _res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      globalLogger.warn("[AdminEd25519] Missing/invalid Bearer token", {
        path: req.path,
      });
      return next(
        Errors.unauthorized("Missing or invalid Authorization header"),
      );
    }
    const token = authHeader.slice(7);
    try {
      const secrets = getJwtSecretsForVerification();
      const adminPayload = verifyJwt(token, secrets);
      if (adminPayload.role !== "admin") {
        globalLogger.warn("[AdminEd25519] Session role is not admin", {
          role: adminPayload.role,
          userId: adminPayload.sub,
          path: req.path,
        });
        return next(Errors.forbidden("Forbidden: admin role required"));
      }
      (req as AuthenticatedRequest).user = {
        sub: adminPayload.sub,
        id: adminPayload.sub,
        role: "admin",
        ...(adminPayload.sid ? { sessionToken: adminPayload.sid } : {}),
      };
    } catch (error) {
      globalLogger.warn("[AdminEd25519] Admin token verification failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        path: req.path,
      });
      return next(Errors.unauthorized("Invalid or expired admin token"));
    }

    const kid = req.header("x-admin-kid");
    const signatureB64 = req.header("x-admin-signature");
    if (!kid || !signatureB64) {
      globalLogger.warn("[AdminEd25519] Missing required signature headers", {
        path: req.path,
      });
      return next(
        Errors.unauthorized(
          "Missing required Ed25519 signature headers: x-admin-kid, x-admin-signature",
        ),
      );
    }

    const body = req.body ?? {};
    const { action, offeringId, nonce, timestamp } = body;

    if (!action || typeof action !== "string") {
      return next(
        Errors.badRequest("Signed body missing required field: action"),
      );
    }
    if (!offeringId || typeof offeringId !== "string") {
      return next(
        Errors.badRequest("Signed body missing required field: offeringId"),
      );
    }
    if (!nonce || typeof nonce !== "string" || nonce.length < 8) {
      return next(
        Errors.badRequest("Signed body missing valid nonce (>=8 chars)"),
      );
    }
    if (
      timestamp === undefined ||
      timestamp === null ||
      !Number.isFinite(Number(timestamp))
    ) {
      return next(
        Errors.badRequest("Signed body missing valid numeric Unix timestamp"),
      );
    }
    const tsNum = Number(timestamp);

    const knownActions = Object.keys(ACTION_TO_PATH_SEGMENT);
    if (!knownActions.includes(action)) {
      globalLogger.warn("[AdminEd25519] Unknown action in signed payload", {
        action,
        path: req.path,
      });
      return next(
        Errors.badRequest(
          `Invalid action. Must be one of: ${knownActions.join(", ")}`,
        ),
      );
    }
    const typedAction = action as AdminSignedStatusTransitionPayload["action"];

    if (expectedAction && typedAction !== expectedAction) {
      globalLogger.warn(
        "[AdminEd25519] Signed action does not match route expected action",
        {
          signed: typedAction,
          expected: expectedAction,
          path: req.path,
        },
      );
      return next(
        Errors.badRequest(
          `Signed action "${typedAction}" does not match route expected action "${expectedAction}"`,
        ),
      );
    }

    const pathSegment = ACTION_TO_PATH_SEGMENT[typedAction];
    if (
      !req.path.endsWith(`/${pathSegment}`) &&
      !req.path.includes(`/${pathSegment}/`)
    ) {
      globalLogger.warn("[AdminEd25519] Route/action mismatch", {
        action: typedAction,
        path: req.path,
        expectedSegment: pathSegment,
      });
      return next(
        Errors.badRequest("Signed action does not correspond to request route"),
      );
    }

    if (
      !isAdminSignatureTimestampFresh(
        tsNum,
        ADMIN_SIGNATURE_ALLOWED_CLOCK_SKEW_SECONDS,
      )
    ) {
      globalLogger.warn("[AdminEd25519] Stale timestamp", {
        timestamp: tsNum,
        skew: ADMIN_SIGNATURE_ALLOWED_CLOCK_SKEW_SECONDS,
        path: req.path,
      });
      return next(
        Errors.unauthorized(
          "Request timestamp outside allowed clock-skew window",
        ),
      );
    }

    const replayed = replayCache.checkAndMark(kid, nonce, tsNum);
    if (replayed) {
      globalLogger.warn("[AdminEd25519] Replay detected", {
        kid,
        nonce,
        path: req.path,
      });
      return next(
        Errors.conflict(
          "Replay detected: nonce already used within the allowed window",
        ),
      );
    }

    const knownKeys = getAdminPubKeys();
    if (!knownKeys) {
      return next(
        Errors.internal(
          "Server configuration error: admin public keys unavailable",
        ),
      );
    }

    const signedPayload: AdminSignedStatusTransitionPayload = {
      action: typedAction,
      offeringId,
      nonce,
      timestamp: tsNum,
    };

    const verification = verifyAdminStatusTransitionSignature(
      signedPayload,
      signatureB64,
      kid,
      knownKeys,
    );

    if (!verification.valid || !verification.payload) {
      return next(
        Errors.unauthorized(verification.error ?? "Invalid admin signature"),
      );
    }

    const routeOfferingId = req.params?.id;
    if (routeOfferingId && routeOfferingId !== offeringId) {
      globalLogger.warn(
        "[AdminEd25519] offeringId mismatch between route param and signed payload",
        {
          routeId: routeOfferingId,
          signedId: offeringId,
        },
      );
      return next(
        Errors.badRequest(
          "Signed offeringId does not match the route offering ID",
        ),
      );
    }

    (req as AuthenticatedRequest).adminSignature = {
      kid: verification.kid!,
      action: verification.payload.action,
      offeringId: verification.payload.offeringId,
      nonce: verification.payload.nonce,
      timestamp: verification.payload.timestamp,
    };

    globalLogger.info("[AdminEd25519] Signature verified", {
      kid: verification.kid,
      action: typedAction,
      offeringId,
      adminSub: (req as AuthenticatedRequest).user?.sub,
    });

    next();
  };
}
