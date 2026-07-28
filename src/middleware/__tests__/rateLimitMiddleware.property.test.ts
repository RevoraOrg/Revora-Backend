import * as fc from 'fast-check';
import express from 'express';
import request from 'supertest';
import {
  createStartupAuthTierLimiter,
  STARTUP_AUTH_RATE_TIER_HEADER,
  STARTUP_AUTH_TIER_SECRET_HEADER,
  STARTUP_AUTH_RATE_TIER_POLICIES,
  StartupAuthRateTier,
} from '../startupAuthRateTierPolicy';
import { InMemoryRateLimitStore } from '../rateLimit';
import { errorHandler } from '../errorHandler';

const TEST_SECRET = 'property-test-secret';

function makeApp(secret?: string) {
  const store = new InMemoryRateLimitStore();
  const limiter = createStartupAuthTierLimiter({ store });
  if (secret) process.env.STARTUP_AUTH_TIER_SECRET = secret;
  const app = express();
  app.use(express.json());
  app.post('/startup/register', limiter.middleware, (_req, res) => {
    res.status(201).json({ ok: true });
  });
  app.use(errorHandler);
  return { app, limiter, store };
}

function tierHeaders(tier: StartupAuthRateTier, secret: string) {
  if (tier === 'standard') return {};
  return {
    [STARTUP_AUTH_RATE_TIER_HEADER]: tier,
    [STARTUP_AUTH_TIER_SECRET_HEADER]: secret,
  };
}

describe('rateLimitMiddleware — property-based tests', () => {
  beforeEach(() => {
    delete process.env.STARTUP_AUTH_TIER_SECRET;
  });
  afterEach(() => {
    delete process.env.STARTUP_AUTH_TIER_SECRET;
  });

  // Property 2: Counter isolation across tiers
  it('Property 2: Counter isolation across tiers', async () => {
    // Feature: rate-limiter-tier-policies, Property 2: Counter isolation across tiers
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('standard' as const, 'trusted' as const, 'internal' as const),
        fc.constantFrom('standard' as const, 'trusted' as const, 'internal' as const),
        async (tier1, tier2) => {
          fc.pre(tier1 !== tier2);
          process.env.STARTUP_AUTH_TIER_SECRET = TEST_SECRET;
          const { app } = makeApp();
          const limit1 = STARTUP_AUTH_RATE_TIER_POLICIES[tier1].limit;
          const headers1 = tierHeaders(tier1, TEST_SECRET);
          const headers2 = tierHeaders(tier2, TEST_SECRET);

          // Exhaust tier1
          for (let i = 0; i < limit1; i++) {
            await request(app).post('/startup/register').set(headers1).send({});
          }
          const blocked = await request(app).post('/startup/register').set(headers1).send({});
          expect(blocked.status).toBe(429);

          // tier2 should still be allowed on its first request
          const tier2Res = await request(app).post('/startup/register').set(headers2).send({});
          expect(tier2Res.status).toBe(201);
        }
      ),
      { numRuns: 6 } // 6 combinations of distinct tier pairs
    );
  });

  // Property 5: Rate limit headers present and correct on every response
  it('Property 5: Rate limit headers are present and correct on every response', async () => {
    // Feature: rate-limiter-tier-policies, Property 5: Rate limit headers are present and correct on every response
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('standard' as const, 'trusted' as const, 'internal' as const),
        fc.integer({ min: 1, max: 30 }),
        async (tier, count) => {
          process.env.STARTUP_AUTH_TIER_SECRET = TEST_SECRET;
          const { app } = makeApp();
          const policy = STARTUP_AUTH_RATE_TIER_POLICIES[tier];
          const headers = tierHeaders(tier, TEST_SECRET);

          for (let n = 1; n <= count; n++) {
            const res = await request(app).post('/startup/register').set(headers).send({});
            const expectedRemaining = Math.max(0, policy.limit - n);
            expect(res.headers['x-ratelimit-limit']).toBe(String(policy.limit));
            expect(res.headers['x-ratelimit-remaining']).toBe(String(expectedRemaining));
            expect(parseInt(res.headers['x-ratelimit-reset'], 10)).toBeGreaterThan(0);
            expect(res.headers['x-ratelimit-tier']).toBe(tier);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  // Property 6: The (limit+1)th request is always blocked with a structured 429
  it('Property 6: The (limit+1)th request is always blocked with a structured 429', async () => {
    // Feature: rate-limiter-tier-policies, Property 6: The (limit+1)th request is always blocked with a structured 429
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('standard' as const, 'trusted' as const, 'internal' as const),
        async (tier) => {
          process.env.STARTUP_AUTH_TIER_SECRET = TEST_SECRET;
          const { app } = makeApp();
          const policy = STARTUP_AUTH_RATE_TIER_POLICIES[tier];
          const headers = tierHeaders(tier, TEST_SECRET);

          // Send exactly limit requests — all should be 201
          for (let i = 0; i < policy.limit; i++) {
            const res = await request(app).post('/startup/register').set(headers).send({});
            expect(res.status).toBe(201);
          }

          // (limit+1)th request must be 429
          const blocked = await request(app).post('/startup/register').set(headers).send({});
          expect(blocked.status).toBe(429);
          expect(blocked.body.message).toBe(policy.message);
          expect(parseInt(blocked.headers['retry-after'], 10)).toBeGreaterThan(0);
        }
      ),
      { numRuns: 3 } // one per tier
    );
  });

  // Property 7: Requests within the limit always call next() without error
  it('Property 7: Requests within the limit always call next() without error', async () => {
    // Feature: rate-limiter-tier-policies, Property 7: Requests within the limit always call next() without error
    const minLimit = STARTUP_AUTH_RATE_TIER_POLICIES.standard.limit; // 5 — most restrictive
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('standard' as const, 'trusted' as const, 'internal' as const),
        fc.integer({ min: 1, max: minLimit }),
        async (tier, count) => {
          process.env.STARTUP_AUTH_TIER_SECRET = TEST_SECRET;
          const { app } = makeApp();
          const headers = tierHeaders(tier, TEST_SECRET);

          for (let i = 0; i < count; i++) {
            const res = await request(app).post('/startup/register').set(headers).send({});
            expect(res.status).toBe(201);
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  // Property 9: IP key derivation is consistent and namespaced
  it('Property 9: IP key derivation is consistent and namespaced', () => {
    // Feature: rate-limiter-tier-policies, Property 9: IP key derivation is consistent and namespaced
    fc.assert(
      fc.property(
        fc.ipV4(),
        fc.constantFrom('standard' as const, 'trusted' as const, 'internal' as const),
        (ip, tier) => {
          process.env.STARTUP_AUTH_TIER_SECRET = TEST_SECRET;
          const store = new InMemoryRateLimitStore();
          const capturedKeys: string[] = [];
          const spyStore: typeof store = {
            increment: (key, windowMs) => {
              capturedKeys.push(key);
              return store.increment(key, windowMs);
            },
            reset: (key) => store.reset(key),
            clear: () => store.clear(),
          };

          const limiter = createStartupAuthTierLimiter({ store: spyStore as any });
          const req = {
            ip,
            socket: { remoteAddress: ip },
            header: (name: string) => {
              const h: Record<string, string> = {};
              if (tier !== 'standard') {
                h[STARTUP_AUTH_RATE_TIER_HEADER] = tier;
                h[STARTUP_AUTH_TIER_SECRET_HEADER] = TEST_SECRET;
              }
              return h[name.toLowerCase()];
            },
          } as any;
          const res = {
            setHeader: () => {},
            getHeader: () => undefined,
          } as any;
          const next = jest.fn();

          limiter.middleware(req, res, next);

          expect(capturedKeys.length).toBeGreaterThan(0);
          const key = capturedKeys[0];
          expect(key).toContain(`startup-auth:${tier}`);
          expect(key).toContain('ip:');
          expect(key).toContain(ip);
        }
      ),
      { numRuns: 50 }
    );
  });
});
