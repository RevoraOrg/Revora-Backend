/**
 * Rate limiting middleware for security and abuse prevention
 * 
 * Provides configurable rate limiting with different strategies
 * for various types of requests and security events.
 */

import { Request, Response, NextFunction } from 'express';
import { RateLimitConfig, RateLimitError, SecurityContext } from './types';
import { recordAuditEvent } from './auth';

/**
 * Rate limit store interface for different storage backends
 */
export interface RateLimitStore {
  get(key: string): Promise<number | null>;
  set(key: string, value: number, ttlMs: number): Promise<void>;
  increment(key: string, ttlMs: number): Promise<number>;
  reset(key: string): Promise<void>;
}

/**
 * In-memory rate limit store for development
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, { count: number; expiry: number }>();

  private cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.store.entries()) {
      if (value.expiry <= now) {
        this.store.delete(key);
      }
    }
  }

  async get(key: string): Promise<number | null> {
    this.cleanup();
    const entry = this.store.get(key);
    return entry ? entry.count : null;
  }

  async set(key: string, value: number, ttlMs: number): Promise<void> {
    this.cleanup();
    this.store.set(key, {
      count: value,
      expiry: Date.now() + ttlMs,
    });
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    this.cleanup();
    const entry = this.store.get(key);
    
    if (entry && entry.expiry > Date.now()) {
      entry.count++;
      return entry.count;
    }
    
    this.store.set(key, {
      count: 1,
      expiry: Date.now() + ttlMs,
    });
    
    return 1;
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * Redis-backed rate limit store for production
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private redis: any) {}

  async get(key: string): Promise<number | null> {
    const value = await this.redis.get(key);
    return value ? parseInt(value, 10) : null;
  }

  async set(key: string, value: number, ttlMs: number): Promise<void> {
    await this.redis.setex(key, Math.ceil(ttlMs / 1000), value.toString());
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    const result = await this.redis.incr(key);
    if (result === 1) {
      await this.redis.expire(key, Math.ceil(ttlMs / 1000));
    }
    return result;
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

/**
 * Rate limiting middleware options
 */
export interface RateLimitOptions {
  config: RateLimitConfig;
  store: RateLimitStore;
  keyGenerator?: (req: Request) => string;
  onLimitReached?: (req: Request, res: Response, retryAfter: number) => void;
  auditRepository?: any;
}

/**
 * Default key generator for rate limiting
 */
export const defaultKeyGenerator = (req: Request): string => {
  const securityContext = (req as any).securityContext as SecurityContext;
  const userId = securityContext?.user?.id || req.ip || 'anonymous';
  const path = req.route?.path || req.path;
  return `rate_limit:${userId}:${path}`;
};

/**
 * Creates rate limiting middleware
 */
export const createRateLimitMiddleware = (options: RateLimitOptions) => {
  const {
    config,
    store,
    keyGenerator = defaultKeyGenerator,
    onLimitReached,
    auditRepository,
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = keyGenerator(req);
    const securityContext = (req as any).securityContext as SecurityContext;

    try {
      const currentCount = await store.increment(key, config.windowMs);
      
      if (currentCount > config.maxRequests) {
        const retryAfter = Math.ceil(config.windowMs / 1000);
        
        // Record rate limit violation
        if (auditRepository && securityContext) {
          await recordAuditEvent(
            auditRepository,
            'SECURITY_VIOLATION',
            'rate_limit_exceeded',
            'rate_limiter',
            'BLOCKED',
            securityContext,
            {
              key,
              currentCount,
              maxRequests: config.maxRequests,
              windowMs: config.windowMs,
              retryAfter,
            }
          );
        }

        if (onLimitReached) {
          onLimitReached(req, res, retryAfter);
        } else {
          res.set('Retry-After', retryAfter.toString());
          res.status(429).json({
            error: 'Rate limit exceeded',
            retryAfter,
            requestId: securityContext?.requestId,
          });
        }
        return;
      }

      // Set rate limit headers for clients
      res.set({
        'X-RateLimit-Limit': config.maxRequests.toString(),
        'X-RateLimit-Remaining': Math.max(0, config.maxRequests - currentCount).toString(),
        'X-RateLimit-Reset': new Date(Date.now() + config.windowMs).toISOString(),
      });

      next();
    } catch (error) {
      // Fail open - don't block requests if rate limiter fails
      console.error('Rate limiter error:', error);
      next();
    }
  };
};

/**
 * Pre-configured rate limiters for different use cases
 */
export const createValidationRateLimit = (store: RateLimitStore, auditRepository?: any) => {
  return createRateLimitMiddleware({
    config: {
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 10, // 10 validations per minute
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
    },
    store,
    keyGenerator: (req: Request) => {
      const securityContext = (req as any).securityContext as SecurityContext;
      const userId = securityContext?.user?.id || req.ip || 'anonymous';
      return `validation:${userId}`;
    },
    auditRepository,
  });
};

export const createAuthRateLimit = (store: RateLimitStore, auditRepository?: any) => {
  return createRateLimitMiddleware({
    config: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 100, // 100 auth attempts per 15 minutes
      skipSuccessfulRequests: true, // Only count failed attempts
      skipFailedRequests: false,
    },
    store,
    keyGenerator: (req: Request) => {
      const ip = req.ip || req.connection?.remoteAddress || 'unknown';
      return `auth:${ip}`;
    },
    auditRepository,
  });
};

export const createAuditRateLimit = (store: RateLimitStore) => {
  return createRateLimitMiddleware({
    config: {
      windowMs: 60 * 1000, // 1 minute
      maxRequests: 1000, // 1000 audit reads per minute
    },
    store,
    keyGenerator: (req: Request) => {
      const securityContext = (req as any).securityContext as SecurityContext;
      const userId = securityContext?.user?.id || req.ip || 'anonymous';
      return `audit:${userId}`;
    },
  });
};

/**
 * Factory function to create rate limit store based on environment
 */
export const createRateLimitStore = (redis?: any): RateLimitStore => {
  if (redis && process.env.NODE_ENV === 'production') {
    return new RedisRateLimitStore(redis);
  }
  
  return new InMemoryRateLimitStore();
};

/**
 * Sliding window rate limiter for more precise rate limiting
 */
export class SlidingWindowRateLimiter {
  constructor(private store: RateLimitStore) {}

  async isAllowed(
    key: string,
    windowMs: number,
    maxRequests: number
  ): Promise<{ allowed: boolean; currentCount: number; resetTime: number }> {
    const now = Date.now();
    const windowStart = now - windowMs;
    
    // Get current count
    const currentCount = await this.store.get(key) || 0;
    
    const allowed = currentCount < maxRequests;
    const resetTime = now + windowMs;
    
    return {
      allowed,
      currentCount,
      resetTime,
    };
  }

  async recordRequest(key: string, windowMs: number): Promise<void> {
    await this.store.increment(key, windowMs);
  }
}
