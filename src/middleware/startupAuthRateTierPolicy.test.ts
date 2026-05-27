import express, { Request } from 'express';
import request from 'supertest';
import {
  createStartupAuthTierLimiter,
  STARTUP_AUTH_RATE_TIER_HEADER,
  STARTUP_AUTH_RATE_TIER_POLICIES,
  STARTUP_AUTH_TIER_SECRET_HEADER,
} from './startupAuthRateTierPolicy';
import { InMemoryRateLimitStore } from './rateLimit';
import { errorHandler } from './errorHandler';

describe('startupAuthRateTierPolicy', () => {
  const tierSecret = 'tier-secret-test';

  beforeEach(() => {
    delete process.env.STARTUP_AUTH_TIER_SECRET;
  });

  afterEach(() => {
    delete process.env.STARTUP_AUTH_TIER_SECRET;
  });

  function makeRequest(headers: Record<string, string> = {}): Request {
    return {
      header(name: string): string | undefined {
        return headers[name.toLowerCase()];
      },
    } as unknown as Request;
  }

  function makeApp() {
    const limiter = createStartupAuthTierLimiter();
    const app = express();
    app.use(express.json());
    app.post('/startup/register', limiter.middleware, (_req, res) => {
      res.status(201).json({ ok: true });
    });
    app.use(errorHandler);
    return { app, limiter };
  }

  it('resolves standard for missing tier header', () => {
    const limiter = createStartupAuthTierLimiter();
    const req = makeRequest();

    expect(limiter.resolveTier(req)).toBe('standard');
  });

  it('resolves standard for unknown requested tier', () => {
    const limiter = createStartupAuthTierLimiter();
    const req = makeRequest({ [STARTUP_AUTH_RATE_TIER_HEADER]: 'vip' });

    expect(limiter.resolveTier(req)).toBe('standard');
  });

  it('resolves trusted only when tier secret is valid', () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const limiter = createStartupAuthTierLimiter();

    const valid = makeRequest({
      [STARTUP_AUTH_RATE_TIER_HEADER]: 'trusted',
      [STARTUP_AUTH_TIER_SECRET_HEADER]: tierSecret,
    });
    const spoofed = makeRequest({
      [STARTUP_AUTH_RATE_TIER_HEADER]: 'trusted',
      [STARTUP_AUTH_TIER_SECRET_HEADER]: 'wrong',
    });

    expect(limiter.resolveTier(valid)).toBe('trusted');
    expect(limiter.resolveTier(spoofed)).toBe('standard');
  });

  it('sets X-RateLimit-Tier response header', async () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const { app } = makeApp();

    const res = await request(app)
      .post('/startup/register')
      .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
      .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
      .send({});

    expect(res.status).toBe(201);
    expect(res.headers['x-ratelimit-tier']).toBe('trusted');
  });

  it('enforces standard tier quota (6th request blocked)', async () => {
    const { app } = makeApp();

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/startup/register').send({});
      expect(res.status).toBe(201);
      expect(res.headers['x-ratelimit-tier']).toBe('standard');
    }

    const blocked = await request(app).post('/startup/register').send({});
    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-tier']).toBe('standard');
    expect(blocked.headers['x-ratelimit-limit']).toBe('5');
  });

  it('enforces trusted tier quota (11th request blocked)', async () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const { app } = makeApp();

    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post('/startup/register')
        .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
        .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
        .send({});
      expect(res.status).toBe(201);
      expect(res.headers['x-ratelimit-tier']).toBe('trusted');
    }

    const blocked = await request(app)
      .post('/startup/register')
      .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
      .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
      .send({});

    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-tier']).toBe('trusted');
    expect(blocked.headers['x-ratelimit-limit']).toBe('10');
  });

  it('enforces internal tier quota (26th request blocked)', async () => {
    process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
    const { app } = makeApp();

    for (let i = 0; i < 25; i += 1) {
      const res = await request(app)
        .post('/startup/register')
        .set(STARTUP_AUTH_RATE_TIER_HEADER, 'internal')
        .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
        .send({});
      expect(res.status).toBe(201);
      expect(res.headers['x-ratelimit-tier']).toBe('internal');
    }

    const blocked = await request(app)
      .post('/startup/register')
      .set(STARTUP_AUTH_RATE_TIER_HEADER, 'internal')
      .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
      .send({});

    expect(blocked.status).toBe(429);
    expect(blocked.headers['x-ratelimit-tier']).toBe('internal');
    expect(blocked.headers['x-ratelimit-limit']).toBe('25');
  });

  it('reset clears rate-limit counters', async () => {
    const { app, limiter } = makeApp();

    for (let i = 0; i < 6; i += 1) {
      await request(app).post('/startup/register').send({});
    }

    limiter.reset();

    const res = await request(app).post('/startup/register').send({});
    expect(res.status).toBe(201);
  });

  // ─── Task 2.1: resolveTier unit tests ──────────────────────────────────────

  describe('resolveTier', () => {
    // Req 2.3 — trusted tier header without secret falls back to standard
    it("returns 'standard' when tier header is 'trusted' but secret header is absent", () => {
      process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
      const limiter = createStartupAuthTierLimiter();
      const req = makeRequest({ [STARTUP_AUTH_RATE_TIER_HEADER]: 'trusted' });
      expect(limiter.resolveTier(req)).toBe('standard');
    });

    // Req 2.3 — internal tier header without secret falls back to standard
    it("returns 'standard' when tier header is 'internal' but secret header is absent", () => {
      process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
      const limiter = createStartupAuthTierLimiter();
      const req = makeRequest({ [STARTUP_AUTH_RATE_TIER_HEADER]: 'internal' });
      expect(limiter.resolveTier(req)).toBe('standard');
    });

    // Req 2.2 — internal tier with matching secret resolves to internal
    it("returns 'internal' when tier header is 'internal' and secret matches", () => {
      process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
      const limiter = createStartupAuthTierLimiter();
      const req = makeRequest({
        [STARTUP_AUTH_RATE_TIER_HEADER]: 'internal',
        [STARTUP_AUTH_TIER_SECRET_HEADER]: tierSecret,
      });
      expect(limiter.resolveTier(req)).toBe('internal');
    });

    // Req 2.6 — no env var set means all elevated requests fall back to standard
    it("returns 'standard' when STARTUP_AUTH_TIER_SECRET env var is not set", () => {
      delete process.env.STARTUP_AUTH_TIER_SECRET;
      const limiter = createStartupAuthTierLimiter();
      const req = makeRequest({
        [STARTUP_AUTH_RATE_TIER_HEADER]: 'trusted',
        [STARTUP_AUTH_TIER_SECRET_HEADER]: 'any-secret',
      });
      expect(limiter.resolveTier(req)).toBe('standard');
    });

    // Req 12.4 — env var value is trimmed before comparison
    it('trims whitespace from env var value before comparison', () => {
      process.env.STARTUP_AUTH_TIER_SECRET = '  mysecret  ';
      const limiter = createStartupAuthTierLimiter();
      const req = makeRequest({
        [STARTUP_AUTH_RATE_TIER_HEADER]: 'trusted',
        [STARTUP_AUTH_TIER_SECRET_HEADER]: 'mysecret',
      });
      expect(limiter.resolveTier(req)).toBe('trusted');
    });

    // Req 12.5 — secret header value is trimmed before comparison
    it('trims whitespace from secret header value before comparison', () => {
      process.env.STARTUP_AUTH_TIER_SECRET = 'mysecret';
      const limiter = createStartupAuthTierLimiter();
      const req = makeRequest({
        [STARTUP_AUTH_RATE_TIER_HEADER]: 'trusted',
        [STARTUP_AUTH_TIER_SECRET_HEADER]: '  mysecret  ',
      });
      expect(limiter.resolveTier(req)).toBe('trusted');
    });

    // Req 12.3 — custom tierSecretEnvName is used when provided
    describe('custom tierSecretEnvName', () => {
      afterEach(() => {
        delete process.env.MY_CUSTOM_SECRET;
      });

      it('uses a custom tierSecretEnvName when provided', () => {
        process.env.MY_CUSTOM_SECRET = 'abc';
        const limiter = createStartupAuthTierLimiter({ tierSecretEnvName: 'MY_CUSTOM_SECRET' });
        const req = makeRequest({
          [STARTUP_AUTH_RATE_TIER_HEADER]: 'trusted',
          [STARTUP_AUTH_TIER_SECRET_HEADER]: 'abc',
        });
        expect(limiter.resolveTier(req)).toBe('trusted');
      });
    });

    // Req 12.2 — defaults to STARTUP_AUTH_TIER_SECRET when tierSecretEnvName is not provided
    it("defaults to 'STARTUP_AUTH_TIER_SECRET' env var name when tierSecretEnvName is not provided", () => {
      process.env.STARTUP_AUTH_TIER_SECRET = 'abc';
      const limiter = createStartupAuthTierLimiter();
      const req = makeRequest({
        [STARTUP_AUTH_RATE_TIER_HEADER]: 'trusted',
        [STARTUP_AUTH_TIER_SECRET_HEADER]: 'abc',
      });
      expect(limiter.resolveTier(req)).toBe('trusted');
    });
  });

  // ─── Task 2.2: middleware integration tests ────────────────────────────────

  describe('middleware integration', () => {
    // Req 4.1, 4.2, 4.3 — rate-limit headers present on 201
    it('X-RateLimit-Limit, X-RateLimit-Remaining, and X-RateLimit-Reset headers are all present on a 201 response', async () => {
      const { app } = makeApp();
      const res = await request(app).post('/startup/register').send({});
      expect(res.status).toBe(201);
      expect(res.headers['x-ratelimit-limit']).toBeDefined();
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });

    // Req 4.4 — X-RateLimit-Tier is 'standard' when no tier header is sent
    it("X-RateLimit-Tier header is 'standard' when no tier header is sent", async () => {
      const { app } = makeApp();
      const res = await request(app).post('/startup/register').send({});
      expect(res.status).toBe(201);
      expect(res.headers['x-ratelimit-tier']).toBe('standard');
    });

    // Req 8.2 — 429 body message for standard tier
    it('429 response body contains the exact message string for standard tier', async () => {
      const { app } = makeApp();
      // Exhaust the standard limit (5 requests)
      for (let i = 0; i < 5; i += 1) {
        await request(app).post('/startup/register').send({});
      }
      const blocked = await request(app).post('/startup/register').send({});
      expect(blocked.status).toBe(429);
      expect(blocked.body.message).toBe(
        'Too many registration attempts, please try again after 15 minutes.',
      );
    });

    // Req 8.3 — 429 body message for trusted tier
    it('429 response body contains the exact message string for trusted tier', async () => {
      process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
      const { app } = makeApp();
      // Exhaust the trusted limit (10 requests)
      for (let i = 0; i < 10; i += 1) {
        await request(app)
          .post('/startup/register')
          .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
          .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
          .send({});
      }
      const blocked = await request(app)
        .post('/startup/register')
        .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
        .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
        .send({});
      expect(blocked.status).toBe(429);
      expect(blocked.body.message).toBe(
        'Too many trusted-tier registration attempts, please try again after 15 minutes.',
      );
    });

    // Req 8.4 — 429 body message for internal tier
    it('429 response body contains the exact message string for internal tier', async () => {
      process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
      const { app } = makeApp();
      // Exhaust the internal limit (25 requests)
      for (let i = 0; i < 25; i += 1) {
        await request(app)
          .post('/startup/register')
          .set(STARTUP_AUTH_RATE_TIER_HEADER, 'internal')
          .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
          .send({});
      }
      const blocked = await request(app)
        .post('/startup/register')
        .set(STARTUP_AUTH_RATE_TIER_HEADER, 'internal')
        .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
        .send({});
      expect(blocked.status).toBe(429);
      expect(blocked.body.message).toBe(
        'Too many internal registration attempts, please try again after 15 minutes.',
      );
    });

    // Req 2.4, 1.6 — spoofed trusted request is downgraded to standard counter
    it('spoofed trusted-tier request (valid tier header, wrong secret) is downgraded and consumes from the standard counter', async () => {
      process.env.STARTUP_AUTH_TIER_SECRET = tierSecret;
      const { app } = makeApp();

      // Send 5 spoofed trusted requests (wrong secret) — all treated as standard
      for (let i = 0; i < 5; i += 1) {
        const res = await request(app)
          .post('/startup/register')
          .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
          .set(STARTUP_AUTH_TIER_SECRET_HEADER, 'wrong-secret')
          .send({});
        expect(res.status).toBe(201);
        expect(res.headers['x-ratelimit-tier']).toBe('standard');
      }

      // 6th spoofed request should be blocked (standard counter exhausted)
      const blocked = await request(app)
        .post('/startup/register')
        .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
        .set(STARTUP_AUTH_TIER_SECRET_HEADER, 'wrong-secret')
        .send({});
      expect(blocked.status).toBe(429);
      expect(blocked.headers['x-ratelimit-tier']).toBe('standard');

      // A real trusted request (correct secret) should still be allowed — trusted counter is untouched
      const trustedRes = await request(app)
        .post('/startup/register')
        .set(STARTUP_AUTH_RATE_TIER_HEADER, 'trusted')
        .set(STARTUP_AUTH_TIER_SECRET_HEADER, tierSecret)
        .send({});
      expect(trustedRes.status).toBe(201);
      expect(trustedRes.headers['x-ratelimit-tier']).toBe('trusted');
    });

    // Req 7.5 — /health endpoint is unaffected when /startup/register is rate-limited
    it('/health endpoint is unaffected when /startup/register is rate-limited', async () => {
      const limiter = createStartupAuthTierLimiter();
      const app = express();
      app.use(express.json());
      // Health endpoint — not behind the rate limiter
      app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
      // Register endpoint — behind the rate limiter
      app.post('/startup/register', limiter.middleware, (_req, res) => {
        res.status(201).json({ ok: true });
      });
      app.use(errorHandler);

      // Exhaust the standard limit
      for (let i = 0; i < 6; i += 1) {
        await request(app).post('/startup/register').send({});
      }

      // /health should still return 200
      const healthRes = await request(app).get('/health');
      expect(healthRes.status).toBe(200);
    });

    // Req 11.1 — custom store passed to createStartupAuthTierLimiter is used
    it('a custom store passed to createStartupAuthTierLimiter is used instead of the default', async () => {
      const customStore = new InMemoryRateLimitStore();
      const limiter = createStartupAuthTierLimiter({ store: customStore });
      const app = express();
      app.use(express.json());
      app.post('/startup/register', limiter.middleware, (_req, res) => {
        res.status(201).json({ ok: true });
      });
      app.use(errorHandler);

      // Exhaust the standard limit
      for (let i = 0; i < 5; i += 1) {
        await request(app).post('/startup/register').send({});
      }
      const blocked = await request(app).post('/startup/register').send({});
      expect(blocked.status).toBe(429);

      // Reset via limiter.reset() which calls store.clear()
      limiter.reset();

      // Next request should be allowed again
      const afterReset = await request(app).post('/startup/register').send({});
      expect(afterReset.status).toBe(201);
    });
  });

  // ─── Task 2.3: STARTUP_AUTH_RATE_TIER_POLICIES constant assertions ─────────

  describe('STARTUP_AUTH_RATE_TIER_POLICIES constants', () => {
    // Req 1.2, 8.2
    it('standard policy has limit: 5, windowMs: 900_000, and the correct message', () => {
      expect(STARTUP_AUTH_RATE_TIER_POLICIES.standard).toEqual({
        limit: 5,
        windowMs: 900_000,
        message: 'Too many registration attempts, please try again after 15 minutes.',
      });
    });

    // Req 1.3, 8.3
    it('trusted policy has limit: 10, windowMs: 900_000, and the correct message', () => {
      expect(STARTUP_AUTH_RATE_TIER_POLICIES.trusted).toEqual({
        limit: 10,
        windowMs: 900_000,
        message: 'Too many trusted-tier registration attempts, please try again after 15 minutes.',
      });
    });

    // Req 1.4, 8.4
    it('internal policy has limit: 25, windowMs: 900_000, and the correct message', () => {
      expect(STARTUP_AUTH_RATE_TIER_POLICIES.internal).toEqual({
        limit: 25,
        windowMs: 900_000,
        message: 'Too many internal registration attempts, please try again after 15 minutes.',
      });
    });
  });
});
