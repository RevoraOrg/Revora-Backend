/**
 * @file socialAntiEnumerationMiddleware.ts
 *
 * @notice Middleware that hardens the social-login endpoint against timing-based
 *         account-enumeration attacks.
 *
 * @dev    Two complementary defences are layered here:
 *
 *         1. **Per-provider-sub rate bucket** — After the provider + subject are
 *            extracted from the unverified JWT header/payload, a fixed-window
 *            counter is incremented for the key `"<provider>:<sub>"`.  An
 *            attacker who probes the same account repeatedly exhausts *that
 *            identity's* bucket (not just their own IP bucket), regardless of
 *            how many IPs they rotate through.
 *
 *         2. **Constant-time lookup** — The service layer is required to call
 *            `constantTimeLookup` so that the response latency for a
 *            "not found" path matches that of a "found" path, removing the
 *            timing oracle that would otherwise allow enumeration.
 *
 * Security assumptions
 * ───────────────────
 * - The subject extracted here is **unverified** (signature check happens
 *   inside `SocialAuthService`).  An attacker can supply any subject value.
 *   The defence-in-depth is that:
 *     a. The bucket key is `provider:sub`, so a random sub exhausts a bucket
 *        that does not correspond to a real account — no information is leaked.
 *     b. The IP-fallback limiter still fires when no subject can be parsed.
 * - Full signature verification (RS256 + JWKS) remains in `providerVerifiers.ts`.
 * - The store is in-process; replace with a Redis-backed store for multi-instance
 *   deployments (see `rateLimit.ts` `RateLimitStore` interface).
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createRateLimitMiddleware, InMemoryRateLimitStore, RateLimitStore } from './rateLimit';
import { SocialAuthProvider } from '../auth/social/types';
import { Errors } from '../lib/errors';

// ── Module-level metrics counters ──────────────────────────────────────────────

/** Total number of social login attempts seen by this middleware. */
let _socialLoginAttempts = 0;
/** Total number of attempts rejected by the per-provider-sub limiter. */
let _socialLoginRejections = 0;

/**
 * Returns a snapshot of anti-enumeration metrics.
 *
 * @returns `{ attempts, rejections }` — total counts since process start.
 *
 * @dev Expose these via your Prometheus `/metrics` endpoint or structured logs
 *      to alert on abnormal enumeration spikes.
 */
export function getSocialAntiEnumerationMetrics(): {
  attempts: number;
  rejections: number;
} {
  return { attempts: _socialLoginAttempts, rejections: _socialLoginRejections };
}

/** Reset metrics counters.  Test-only helper — do not call in production. */
export function resetSocialAntiEnumerationMetrics(): void {
  _socialLoginAttempts = 0;
  _socialLoginRejections = 0;
}

// ── JWT subject extraction (unverified) ────────────────────────────────────────

const VALID_PROVIDERS = new Set<SocialAuthProvider>(['google', 'apple']);

/**
 * Attempts to extract `provider` and `sub` from an **unverified** compact JWT.
 *
 * This is intentionally low-effort — we only need the payload's `sub` field to
 * seed the rate-limit bucket.  Full verification happens later in the service.
 *
 * @param provider  The provider name from the URL param (already trusted as one
 *                  of the configured values).
 * @param idToken   The raw compact JWT string from the request body.
 * @returns         `"<provider>:<sub>"` or `null` if parsing fails.
 *
 * @dev No crypto is performed here; the result is used only for keying the
 *      rate-limit bucket.  A forged/malformed sub simply creates a spurious
 *      bucket that does not correspond to a real account — harmless.
 */
export function extractProviderSub(
  provider: string,
  idToken: string,
): string | null {
  if (!VALID_PROVIDERS.has(provider as SocialAuthProvider)) return null;
  if (typeof idToken !== 'string') return null;

  const parts = idToken.split('.');
  if (parts.length !== 3) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    const sub = payload['sub'];
    if (typeof sub !== 'string' || sub.length === 0) return null;

    return `${provider}:${sub}`;
  } catch {
    return null;
  }
}

// ── Middleware factory ─────────────────────────────────────────────────────────

export interface SocialAntiEnumerationOptions {
  /**
   * Maximum login attempts per provider-subject per window.
   * Default: 10 attempts per 15-minute window.
   *
   * Rationale: a legitimate user retrying due to a network error should not be
   * blocked, but 10 attempts in 15 minutes is well above normal interactive use.
   */
  limit?: number;
  /** Window duration in milliseconds.  Default: 15 minutes. */
  windowMs?: number;
  /**
   * Soft-cap applied per IP when no provider subject can be parsed
   * (e.g. completely malformed request body).
   * Default: 20 per window — slightly looser than the per-sub bucket so that
   * legitimate scan traffic on a shared IP (e.g. NAT) is still handled.
   */
  ipFallbackLimit?: number;
  /** Optional backing store.  Defaults to a shared InMemoryRateLimitStore. */
  store?: RateLimitStore;
  /** Message returned in the 429 body.  Generic to avoid information leakage. */
  message?: string;
}

/**
 * Shared default store so all instances share counters when no custom store
 * is supplied (mirrors the pattern used in `rateLimit.ts`).
 */
const defaultAntiEnumStore = new InMemoryRateLimitStore();

/**
 * Creates Express middleware that:
 *   1. Parses `provider` (URL param) and `idToken` (request body).
 *   2. Extracts the unverified provider subject from the JWT payload.
 *   3. Attaches the composite key to `req.socialProviderSub`.
 *   4. Enforces a per-provider-sub fixed-window rate limit.
 *   5. Falls back to a per-IP limit when the subject cannot be extracted.
 *   6. Increments the `attempts` and (on rejection) `rejections` metrics counters.
 *
 * **Mount this before** your main `createSocialLoginHandler` middleware so that
 * `req.socialProviderSub` is available to downstream middlewares.
 *
 * @example
 * ```ts
 * const antiEnum = createSocialAntiEnumerationMiddleware();
 * router.post(
 *   '/api/auth/social/:provider/login',
 *   antiEnum,
 *   createSocialLoginHandler(service),
 * );
 * ```
 */
export function createSocialAntiEnumerationMiddleware(
  options: SocialAntiEnumerationOptions = {},
): RequestHandler {
  const {
    limit = 10,
    windowMs = 15 * 60 * 1000,
    ipFallbackLimit = 20,
    store = defaultAntiEnumStore,
    message = 'Too many requests, please try again later.',
  } = options;

  /**
   * Per-provider-sub limiter.
   * The `perProviderSub` flag instructs `createRateLimitMiddleware` to read
   * `req.socialProviderSub` as the bucket key.
   */
  const providerSubLimiter = createRateLimitMiddleware({
    limit,
    windowMs,
    perProviderSub: true,
    keyPrefix: 'social-anti-enum:sub',
    message,
    store,
  });

  /**
   * IP-fallback limiter applied when a subject cannot be extracted.
   * Uses the `ipFallbackLimit` (slightly looser) to tolerate NAT/shared IPs.
   */
  const ipFallbackLimiter = createRateLimitMiddleware({
    limit: ipFallbackLimit,
    windowMs,
    keyPrefix: 'social-anti-enum:ip',
    message,
    store,
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    _socialLoginAttempts += 1;

    // Extract provider + subject from the unverified token
    const provider = (req.params as Record<string, string>)?.['provider'] ?? '';
    const idToken = (req.body as Record<string, unknown>)?.['idToken'];
    const providerSub = extractProviderSub(provider, typeof idToken === 'string' ? idToken : '');

    if (providerSub) {
      // Seed the property that `createRateLimitMiddleware({ perProviderSub })` reads
      (req as any).socialProviderSub = providerSub;

      // Wrap next to intercept rejections and increment the rejection counter
      const wrappedNext: NextFunction = (errOrRoute?: unknown) => {
        if (errOrRoute instanceof Error || (errOrRoute !== undefined && errOrRoute !== null && errOrRoute !== 'router' && errOrRoute !== 'route')) {
          // A non-route/non-layer error => rate-limit rejection
          _socialLoginRejections += 1;
        }
        next(errOrRoute);
      };

      providerSubLimiter(req, res, wrappedNext);
    } else {
      // Could not parse a subject — apply IP-based fallback guard
      const wrappedNext: NextFunction = (errOrRoute?: unknown) => {
        if (errOrRoute instanceof Error || (errOrRoute !== undefined && errOrRoute !== null && errOrRoute !== 'router' && errOrRoute !== 'route')) {
          _socialLoginRejections += 1;
        }
        next(errOrRoute);
      };

      ipFallbackLimiter(req, res, wrappedNext);
    }
  };
}

// ── Convenience factory with injectable store (test helper) ───────────────────

/**
 * Creates a social anti-enumeration middleware with an explicit store.
 * Prefer this signature in tests to avoid shared state between test cases.
 */
export function createSocialAntiEnumerationMiddlewareWithStore(
  store: RateLimitStore,
  options: Omit<SocialAntiEnumerationOptions, 'store'> = {},
): RequestHandler {
  return createSocialAntiEnumerationMiddleware({ ...options, store });
}
