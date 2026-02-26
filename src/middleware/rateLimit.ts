import type { Request, Response, NextFunction, RequestHandler } from 'express';

export interface RateLimitOptions {
  /** Maximum number of requests allowed within the window. Default: 100 */
  limit?: number;
  /** Time window in milliseconds. Default: 60_000 (1 minute) */
  windowMs?: number;
  /** If true, key is derived from req.user?.sub (authenticated routes).
   *  If false (default), key is derived from the client IP (public routes). */
  perUser?: boolean;
  /** Optional message to send when limit is exceeded. */
  message?: string;
}

interface WindowEntry {
  count: number;
  resetAt: number; // epoch ms when the window resets
}

/**
 * In-memory store for rate-limit counters.
 *
 * Uses a simple fixed-window algorithm keyed by an arbitrary string.
 * Each instance is independent — create one store per distinct limit policy
 * if you need different windows for different route groups.
 *
 * NOTE: This store is process-local. In a multi-instance deployment, replace
 * it with a shared backing store (e.g. Redis using ioredis + INCR/EXPIRE)
 * by implementing the same RateLimitStore interface.
 */
export interface RateLimitStore {
  /** Increment the counter for `key` and return the updated state. */
  increment(key: string, windowMs: number): { count: number; resetAt: number };
  /** Reset the counter for `key` (useful in tests). */
  reset(key: string): void;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, WindowEntry>();

  increment(key: string, windowMs: number): { count: number; resetAt: number } {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (!existing || now >= existing.resetAt) {
      // Start a new window
      const entry: WindowEntry = { count: 1, resetAt: now + windowMs };
      this.windows.set(key, entry);
      return { count: 1, resetAt: entry.resetAt };
    }

    existing.count += 1;
    return { count: existing.count, resetAt: existing.resetAt };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }
}

// Module-level default store shared across middleware instances that don't
// supply their own (avoids unbounded store proliferation for the common case).
const defaultStore = new InMemoryRateLimitStore();

/**
 * Creates a rate-limiting Express middleware using a fixed-window algorithm.
 *
 * - For **public routes** (default): keyed by client IP.
 * - For **authenticated routes** (`perUser: true`): keyed by `req.user.sub`.
 *   Mount this middleware *after* your auth middleware so that `req.user` is
 *   already populated.
 *
 * Sets the following response headers on every request:
 *   - `X-RateLimit-Limit`     — the configured maximum
 *   - `X-RateLimit-Remaining` — requests remaining in the current window
 *   - `X-RateLimit-Reset`     — UTC epoch seconds when the window resets
 *
 * Returns **429 Too Many Requests** with a JSON body when the limit is exceeded.
 *
 * @example — public route (per IP)
 * ```ts
 * import { createRateLimitMiddleware } from './middleware/rateLimit';
 *
 * const publicLimiter = createRateLimitMiddleware({ limit: 60, windowMs: 60_000 });
 * app.use('/api/public', publicLimiter, publicRouter);
 * ```
 *
 * @example — authenticated route (per user)
 * ```ts
 * const userLimiter = createRateLimitMiddleware({ limit: 200, windowMs: 60_000, perUser: true });
 * app.use('/api/me', authMiddleware(), userLimiter, meRouter);
 * ```
 *
 * @example — custom store (e.g. Redis-backed for multi-instance deployments)
 * ```ts
 * // Implement RateLimitStore against your Redis client and pass it here.
 * const redisLimiter = createRateLimitMiddleware({ store: myRedisStore });
 * ```
 */
export function createRateLimitMiddleware(options: RateLimitOptions & { store?: RateLimitStore } = {}): RequestHandler {
  const {
    limit = 100,
    windowMs = 60_000,
    perUser = false,
    message = 'Too many requests, please try again later.',
    store = defaultStore,
  } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    // ── Resolve the rate-limit key ────────────────────────────────────────
    let key: string | undefined;

    if (perUser) {
      // Relies on upstream auth middleware having set req.user
      const user = (req as any).user as { sub?: string } | undefined;
      key = user?.sub;

      if (!key) {
        // No authenticated user found — fail open and let auth middleware
        // handle the 401; rate-limiting is not applicable here.
        next();
        return;
      }
      key = `user:${key}`;
    } else {
      // Prefer the de-proxied IP when running behind a trusted proxy
      // (set `app.set('trust proxy', 1)` in your Express bootstrap).
      const ip =
        (req.ip) ||
        (req.socket?.remoteAddress) ||
        'unknown';
      key = `ip:${ip}`;
    }

    // ── Check & increment the counter ─────────────────────────────────────
    const { count, resetAt } = store.increment(key, windowMs);
    const remaining = Math.max(0, limit - count);
    const resetSecs = Math.ceil(resetAt / 1000);

    // ── Set standard rate-limit headers ───────────────────────────────────
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetSecs));

    if (count > limit) {
      res.setHeader('Retry-After', String(resetSecs - Math.ceil(Date.now() / 1000)));
      res.status(429).json({
        error: 'TooManyRequests',
        message,
        retryAfter: resetSecs,
      });
      return;
    }

    next();
  };
}