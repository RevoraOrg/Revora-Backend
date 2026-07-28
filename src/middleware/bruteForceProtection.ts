import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Errors } from "../lib/errors";
import { globalLogger } from "../lib/logger";
import { InMemoryRateLimitStore, RateLimitStore } from "./rateLimit";

/**
 * Rate tier configuration for different user types/routes
 */
export interface RateTier {
  /** Maximum requests per window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
  /** Description of this tier */
  description: string;
}

/**
 * Pre-configured rate tiers for different use cases
 */
export const RateTiers = {
  /** Strict tier for authentication endpoints (brute force protection) */
  AUTH: {
    limit: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
    description: "Authentication attempts",
  },
  /** Standard tier for general API usage */
  STANDARD: {
    limit: 100,
    windowMs: 60 * 1000, // 1 minute
    description: "Standard API requests",
  },
  /** High-volume tier for authenticated users */
  HIGH_VOLUME: {
    limit: 1000,
    windowMs: 60 * 1000, // 1 minute
    description: "High-volume requests",
  },
} as const;

/**
 * Brute force protection options
 */
export interface BruteForceProtectionOptions {
  /** Rate tier to use */
  tier?: RateTier;
  /** Optional custom store */
  store?: RateLimitStore;
  /** Key prefix for isolation */
  keyPrefix?: string;
  /** Custom message when limit exceeded */
  message?: string;
}

/**
 * Creates middleware for brute force protection on authentication endpoints.
 *
 * This middleware uses a strict rate limit to prevent brute force attacks on
 * authentication endpoints like login, registration, and password reset.
 *
 * Security assumptions:
 * - Keys are derived from client IP to prevent distributed attacks
 * - Limits are per-window with exponential backoff recommendations
 * - Failed attempts are logged for security monitoring
 *
 * @example
 * ```ts
 * import { createStartupAuthBruteForceProtection } from './middleware/bruteForceProtection';
 *
 * const authLimiter = createStartupAuthBruteForceProtection();
 * app.post('/api/auth/login', authLimiter, loginHandler);
 * ```
 */
export function createStartupAuthBruteForceProtection(
  options: BruteForceProtectionOptions = {},
): RequestHandler {
  const {
    tier = RateTiers.AUTH,
    store = new InMemoryRateLimitStore(),
    keyPrefix = "auth_brute_force",
    message = "Too many authentication attempts. Please try again later.",
  } = options;

  const logger = globalLogger.child({ component: "BruteForceProtection" });

  return (req: Request, res: Response, next: NextFunction): void => {
    // Derive key from client IP
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${keyPrefix}:${ip}`;

    // Check and increment counter
    const { count, resetAt } = store.increment(key, tier.windowMs);
    const remaining = Math.max(0, tier.limit - count);
    const resetSecs = Math.ceil(resetAt / 1000);

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", String(tier.limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetSecs));

    if (count > tier.limit) {
      const retryAfter = resetSecs - Math.ceil(Date.now() / 1000);

      logger.warn("Brute force protection triggered", {
        ip,
        count,
        limit: tier.limit,
        path: req.path,
        retryAfter,
      });

      res.setHeader("Retry-After", String(retryAfter));
      return next(Errors.tooManyRequests(message, { retryAfter }));
    }

    // Log authentication attempts for monitoring
    if (count === 1 || count % 5 === 0) {
      logger.info("Authentication attempt", {
        ip,
        count,
        limit: tier.limit,
        path: req.path,
      });
    }

    next();
  };
}

/**
 * Creates middleware for rate limiting based on tier boundaries.
 *
 * This allows different rate limits for different types of users or routes.
 *
 * @example
 * ```ts
 * import { createRateTierMiddleware, RateTiers } from './middleware/bruteForceProtection';
 *
 * const standardLimiter = createRateTierMiddleware(RateTiers.STANDARD);
 * const highVolumeLimiter = createRateTierMiddleware(RateTiers.HIGH_VOLUME);
 *
 * app.use('/api/public', standardLimiter, publicRouter);
 * app.use('/api/premium', highVolumeLimiter, premiumRouter);
 * ```
 */
export function createRateTierMiddleware(
  tier: RateTier,
  options: Omit<BruteForceProtectionOptions, "tier"> = {},
): RequestHandler {
  const {
    store = new InMemoryRateLimitStore(),
    keyPrefix = `tier_${tier.description.toLowerCase().replace(/\s+/g, "_")}`,
    message = `Rate limit exceeded for ${tier.description}. Please try again later.`,
  } = options;

  const logger = globalLogger.child({
    component: "RateTier",
    tier: tier.description,
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    // Derive key from IP or user ID if authenticated
    const user = (req as any).user as { sub?: string } | undefined;
    const identifier =
      user?.sub || req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${keyPrefix}:${identifier}`;

    // Check and increment counter
    const { count, resetAt } = store.increment(key, tier.windowMs);
    const remaining = Math.max(0, tier.limit - count);
    const resetSecs = Math.ceil(resetAt / 1000);

    // Set rate limit headers
    res.setHeader("X-RateLimit-Limit", String(tier.limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(resetSecs));
    res.setHeader("X-RateLimit-Tier", tier.description);

    if (count > tier.limit) {
      const retryAfter = resetSecs - Math.ceil(Date.now() / 1000);

      logger.warn("Rate limit exceeded", {
        identifier,
        count,
        limit: tier.limit,
        tier: tier.description,
        path: req.path,
        retryAfter,
      });

      res.setHeader("Retry-After", String(retryAfter));
      return next(Errors.tooManyRequests(message, { retryAfter }));
    }

    next();
  };
}
