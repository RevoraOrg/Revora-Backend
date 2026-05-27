import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode } from '../lib/errors';

/**
 * In-process sliding-window rate limiter for the STARTUP_REGISTER endpoint.
 *
 * Each unique key (default: IP address) is allowed at most `maxRequests`
 * registration attempts within a rolling `windowMs` window.  Counters are
 * stored in-process (Map) — suitable for single-instance deployments.  For
 * multi-instance deployments, swap the store for a Redis-backed equivalent
 * that satisfies {@link RateLimitStore}.
 *
 * Security assumptions
 * ────────────────────
 * • IP-based keying can be spoofed behind a misconfigured proxy.  Set
 *   `trust proxy` on the Express app and ensure `req.ip` reflects the real
 *   client IP when deployed behind a load-balancer / reverse proxy.
 * • In-process state is lost on restart; a brief burst is possible across a
 *   rolling deploy.  Acceptable for abuse-deterrence; not a hard security
 *   boundary.
 * • The 429 response body follows the lib/errors ErrorResponse shape so
 *   clients receive a consistent, machine-readable error code.
 */

// ── Store interface ───────────────────────────────────────────────────────────

export interface RateLimitEntry {
  /** Timestamps (ms) of requests within the current window. */
  timestamps: number[];
}

export interface RateLimitStore {
  /** Return the current entry for a key, or undefined if none. */
  get(key: string): RateLimitEntry | undefined;
  /** Persist an updated entry. */
  set(key: string, entry: RateLimitEntry): void;
}

// ── In-process store ──────────────────────────────────────────────────────────

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly map = new Map<string, RateLimitEntry>();

  get(key: string): RateLimitEntry | undefined {
    return this.map.get(key);
  }

  set(key: string, entry: RateLimitEntry): void {
    this.map.set(key, entry);
  }

  /** Exposed for testing — clears all state. */
  clear(): void {
    this.map.clear();
  }
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface StartupRegisterRateLimitOptions {
  /** Rolling window duration in milliseconds. Default: 15 minutes. */
  windowMs?: number;
  /** Maximum requests allowed per key per window. Default: 5. */
  maxRequests?: number;
  /** Derive the rate-limit key from the request. Default: req.ip. */
  keyFn?: (req: Request) => string;
  /** Backing store. Default: a new InMemoryRateLimitStore. */
  store?: RateLimitStore;
  /**
   * When true, the middleware is bypassed entirely (useful for tests that
   * exercise the route without triggering the limiter).
   */
  skip?: boolean;
}

// ── Middleware factory ────────────────────────────────────────────────────────

/**
 * Returns an Express middleware that enforces the STARTUP_REGISTER sliding-
 * window rate limit.
 *
 * @example
 * router.post(
 *   '/api/auth/startup/register',
 *   createStartupRegisterRateLimit({ maxRequests: 5, windowMs: 15 * 60_000 }),
 *   handler,
 * );
 */
export function createStartupRegisterRateLimit(
  options: StartupRegisterRateLimitOptions = {},
): RequestHandler {
  const windowMs = options.windowMs ?? 15 * 60_000; // 15 min
  const maxRequests = options.maxRequests ?? 5;
  const keyFn = options.keyFn ?? ((req: Request) => req.ip ?? 'unknown');
  const store = options.store ?? new InMemoryRateLimitStore();
  const skip = options.skip ?? false;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (skip) {
      next();
      return;
    }

    const key = keyFn(req);
    const now = Date.now();
    const windowStart = now - windowMs;

    // Retrieve and prune stale timestamps
    const entry = store.get(key) ?? { timestamps: [] };
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    const remaining = Math.max(0, maxRequests - entry.timestamps.length);
    const windowEnd = now + windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil(windowEnd / 1000) - Math.ceil(now / 1000));

    // Set rate limit headers on every request
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(windowEnd / 1000)));

    if (entry.timestamps.length >= maxRequests) {
      // Structured log — never expose internal details to the client
      console.warn(
        JSON.stringify({
          type: 'rate_limit',
          event: 'STARTUP_REGISTER_BLOCKED',
          key,
          count: entry.timestamps.length,
          windowMs,
          maxRequests,
          timestamp: new Date(now).toISOString(),
        }),
      );

      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        code: ErrorCode.FORBIDDEN,
        message: 'Too many registration attempts. Please try again later.',
      });
      return;
    }

    // Record this attempt
    entry.timestamps.push(now);
    store.set(key, entry);

    // Structured log for every attempt (aids monitoring)
    console.info(
      JSON.stringify({
        type: 'rate_limit',
        event: 'STARTUP_REGISTER_ATTEMPT',
        key,
        count: entry.timestamps.length,
        windowMs,
        maxRequests,
        timestamp: new Date(now).toISOString(),
      }),
    );

    next();
  };
}
