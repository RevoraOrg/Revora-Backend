/**
 * Tests for socialAntiEnumerationMiddleware.ts
 *
 * Covers:
 *   - extractProviderSub: valid/invalid inputs, provider validation, base64 edge cases
 *   - createSocialAntiEnumerationMiddleware: per-sub bucketing, IP fallback,
 *     req.socialProviderSub population, metrics, 429 responses, header correctness
 *   - Legitimate high-frequency user sees soft-cap only (not hard-blocked below limit)
 *   - Independent buckets across different provider-sub pairs
 *   - Cross-provider isolation (same sub, different provider = different bucket)
 */

import { Request, Response, NextFunction } from 'express';
import {
  extractProviderSub,
  createSocialAntiEnumerationMiddleware,
  createSocialAntiEnumerationMiddlewareWithStore,
  getSocialAntiEnumerationMetrics,
  resetSocialAntiEnumerationMetrics,
} from './socialAntiEnumerationMiddleware';
import { InMemoryRateLimitStore } from './rateLimit';
import { AppError } from '../lib/errors';

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

function makeReq(overrides: Partial<Request> & { body?: Record<string, unknown>; params?: Record<string, string> } = {}): Request {
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    body: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    getHeader: jest.fn((k: string) => headers[k.toLowerCase()]),
    get headers() {
      return headers;
    },
  };
  return res as Response & { headers: Record<string, string> };
}

// ── extractProviderSub ───────────────────────────────────────────────────────

describe('extractProviderSub', () => {
  it('returns provider:sub for a well-formed Google JWT', () => {
    const token = makeJwt({ sub: 'google-user-123', email: 'user@example.com' });
    expect(extractProviderSub('google', token)).toBe('google:google-user-123');
  });

  it('returns provider:sub for a well-formed Apple JWT', () => {
    const token = makeJwt({ sub: 'apple-user-456' });
    expect(extractProviderSub('apple', token)).toBe('apple:apple-user-456');
  });

  it('returns null for an unknown provider', () => {
    const token = makeJwt({ sub: 'sub-123' });
    expect(extractProviderSub('github', token)).toBeNull();
  });

  it('returns null when idToken is not a string', () => {
    expect(extractProviderSub('google', null as any)).toBeNull();
  });

  it('returns null when idToken has fewer than 3 parts', () => {
    expect(extractProviderSub('google', 'only.twoparts')).toBeNull();
  });

  it('returns null when idToken has more than 3 parts', () => {
    expect(extractProviderSub('google', 'a.b.c.d')).toBeNull();
  });

  it('returns null when payload is not valid base64url JSON', () => {
    expect(extractProviderSub('google', 'header.!!!notbase64.sig')).toBeNull();
  });

  it('returns null when payload JSON has no sub field', () => {
    const token = makeJwt({ email: 'no-sub@example.com' });
    expect(extractProviderSub('google', token)).toBeNull();
  });

  it('returns null when sub is an empty string', () => {
    const token = makeJwt({ sub: '' });
    expect(extractProviderSub('google', token)).toBeNull();
  });

  it('returns null when sub is not a string', () => {
    const token = makeJwt({ sub: 12345 });
    expect(extractProviderSub('google', token)).toBeNull();
  });

  it('handles a sub that contains colons without confusion', () => {
    const token = makeJwt({ sub: 'some:complex:sub' });
    expect(extractProviderSub('google', token)).toBe('google:some:complex:sub');
  });

  it('returns null for an empty provider string', () => {
    const token = makeJwt({ sub: 'sub-abc' });
    expect(extractProviderSub('', token)).toBeNull();
  });
});

// ── createSocialAntiEnumerationMiddleware ─────────────────────────────────────

describe('createSocialAntiEnumerationMiddleware — per-provider-sub buckets', () => {
  beforeEach(() => resetSocialAntiEnumerationMetrics());

  it('passes through when under the per-sub limit', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 3 });
    const token = makeJwt({ sub: 'sub-1' });
    const req = makeReq({ params: { provider: 'google' }, body: { idToken: token } });
    const next: NextFunction = jest.fn();

    mw(req, makeRes(), next);

    expect(next).toHaveBeenCalledWith(undefined); // called without error (undefined = no error)
    expect((req as any).socialProviderSub).toBe('google:sub-1');
  });

  it('attaches socialProviderSub to req on every request with a parseable token', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 5 });
    const token = makeJwt({ sub: 'my-sub' });
    const req = makeReq({ params: { provider: 'apple' }, body: { idToken: token } });
    const next: NextFunction = jest.fn();

    mw(req, makeRes(), next);
    expect((req as any).socialProviderSub).toBe('apple:my-sub');
  });

  it('blocks the (limit+1)th request per sub with a TOO_MANY_REQUESTS AppError', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 2 });
    const token = makeJwt({ sub: 'victim-sub' });
    const makeSubReq = () => makeReq({ params: { provider: 'google' }, body: { idToken: token } });
    const next: NextFunction = jest.fn();

    mw(makeSubReq(), makeRes(), next); // count = 1 — allowed
    mw(makeSubReq(), makeRes(), next); // count = 2 — allowed (at limit)
    mw(makeSubReq(), makeRes(), next); // count = 3 — blocked

    expect(next).toHaveBeenCalledTimes(3);
    const err = (next as jest.Mock).mock.calls[2][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('sets X-RateLimit-* headers on every request', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 5 });
    const token = makeJwt({ sub: 'header-sub' });
    const req = makeReq({ params: { provider: 'google' }, body: { idToken: token } });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('sets Retry-After header on blocked (429) responses', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1 });
    const token = makeJwt({ sub: 'blocked-sub' });
    const makeSubReq = () => makeReq({ params: { provider: 'google' }, body: { idToken: token } });
    const next: NextFunction = jest.fn();

    mw(makeSubReq(), makeRes(), next); // count = 1 — allowed
    const res2 = makeRes();
    mw(makeSubReq(), res2, next); // count = 2 — blocked

    expect(res2.headers['retry-after']).toBeDefined();
    expect(parseInt(res2.headers['retry-after'], 10)).toBeGreaterThan(0);
  });

  it('tracks different provider+sub pairs independently', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1 });
    const tokenA = makeJwt({ sub: 'sub-a' });
    const tokenB = makeJwt({ sub: 'sub-b' });
    const nextA: NextFunction = jest.fn();
    const nextB: NextFunction = jest.fn();

    // Exhaust sub-a's bucket
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: tokenA } }), makeRes(), nextA);
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: tokenA } }), makeRes(), nextA); // blocked

    // sub-b should still be allowed
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: tokenB } }), makeRes(), nextB);

    expect((nextA as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError); // blocked
    expect((nextB as jest.Mock).mock.calls[0][0]).toBeUndefined(); // allowed
  });

  it('treats same sub on different providers as different buckets (cross-provider isolation)', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1 });
    const token = makeJwt({ sub: 'shared-sub' }); // same sub, different provider
    const nextGoogle: NextFunction = jest.fn();
    const nextApple: NextFunction = jest.fn();

    // Exhaust google:shared-sub
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), nextGoogle);
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), nextGoogle); // blocked

    // apple:shared-sub is independent — should still be allowed
    mw(makeReq({ params: { provider: 'apple' }, body: { idToken: token } }), makeRes(), nextApple);

    expect((nextGoogle as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
    expect((nextApple as jest.Mock).mock.calls[0][0]).toBeUndefined();
  });

  it('legitimate high-frequency user sees soft-cap only (allowed up to the limit)', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 10 });
    const token = makeJwt({ sub: 'legitimate-user' });
    const next: NextFunction = jest.fn();

    // First 10 requests should all pass
    for (let i = 0; i < 10; i++) {
      mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), next);
    }

    // All 10 calls reached next without an error
    const errors = (next as jest.Mock).mock.calls.filter((args) => args[0] instanceof Error);
    expect(errors).toHaveLength(0);
    expect(next).toHaveBeenCalledTimes(10);

    // The 11th request is blocked
    const res11 = makeRes();
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), res11, next);
    const err11 = (next as jest.Mock).mock.calls[10][0];
    expect(err11).toBeInstanceOf(AppError);
    expect((err11 as AppError).code).toBe('TOO_MANY_REQUESTS');
  });
});

// ── IP fallback ───────────────────────────────────────────────────────────────

describe('createSocialAntiEnumerationMiddleware — IP fallback', () => {
  beforeEach(() => resetSocialAntiEnumerationMetrics());

  it('applies IP-based rate limit when idToken body is absent', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { ipFallbackLimit: 2 });
    const next: NextFunction = jest.fn();
    const req1 = makeReq({ params: { provider: 'google' }, body: {}, ip: '10.0.0.1' });
    const req2 = makeReq({ params: { provider: 'google' }, body: {}, ip: '10.0.0.1' });
    const req3 = makeReq({ params: { provider: 'google' }, body: {}, ip: '10.0.0.1' });

    mw(req1, makeRes(), next); // count=1 allowed
    mw(req2, makeRes(), next); // count=2 allowed (at limit)
    mw(req3, makeRes(), next); // count=3 blocked

    expect(next).toHaveBeenCalledTimes(3);
    expect((next as jest.Mock).mock.calls[2][0]).toBeInstanceOf(AppError);
  });

  it('applies IP-based rate limit when idToken has no parseable sub', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { ipFallbackLimit: 1 });
    const next: NextFunction = jest.fn();
    // Malformed JWT — no sub field
    const token = makeJwt({ email: 'x@example.com' });
    const req1 = makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '9.9.9.9' });
    const req2 = makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '9.9.9.9' });

    mw(req1, makeRes(), next);
    mw(req2, makeRes(), next); // blocked

    expect((next as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
  });

  it('does not attach socialProviderSub when sub cannot be parsed', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { ipFallbackLimit: 5 });
    const next: NextFunction = jest.fn();
    const req = makeReq({ params: { provider: 'google' }, body: {}, ip: '1.2.3.4' });

    mw(req, makeRes(), next);
    expect((req as any).socialProviderSub).toBeUndefined();
  });

  it('different IPs have independent fallback counters', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { ipFallbackLimit: 1 });
    const nextA: NextFunction = jest.fn();
    const nextB: NextFunction = jest.fn();

    // Exhaust IP A
    mw(makeReq({ ip: '1.1.1.1', params: { provider: 'google' }, body: {} }), makeRes(), nextA);
    mw(makeReq({ ip: '1.1.1.1', params: { provider: 'google' }, body: {} }), makeRes(), nextA); // blocked

    // IP B is unaffected
    mw(makeReq({ ip: '2.2.2.2', params: { provider: 'google' }, body: {} }), makeRes(), nextB);

    expect((nextA as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
    expect((nextB as jest.Mock).mock.calls[0][0]).toBeUndefined();
  });
});

// ── Metrics ──────────────────────────────────────────────────────────────────

describe('createSocialAntiEnumerationMiddleware — metrics', () => {
  beforeEach(() => resetSocialAntiEnumerationMetrics());

  it('increments attempts counter on each request', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 10 });
    const token = makeJwt({ sub: 'metrics-sub' });
    const next: NextFunction = jest.fn();

    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), next);
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), next);

    expect(getSocialAntiEnumerationMetrics().attempts).toBe(2);
  });

  it('increments rejections counter only on blocked requests', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1 });
    const token = makeJwt({ sub: 'reject-sub' });
    const next: NextFunction = jest.fn();

    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), next); // allowed
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), next); // blocked

    const metrics = getSocialAntiEnumerationMetrics();
    expect(metrics.attempts).toBe(2);
    expect(metrics.rejections).toBe(1);
  });

  it('metrics are additive across multiple middleware instances sharing a store', () => {
    const store = new InMemoryRateLimitStore();
    const mw1 = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 5 });
    const mw2 = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 5 });
    const token = makeJwt({ sub: 'shared-metrics' });
    const next: NextFunction = jest.fn();

    mw1(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), next);
    mw2(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), next);

    expect(getSocialAntiEnumerationMetrics().attempts).toBe(2);
  });

  it('reset clears both counters to zero', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1 });
    const token = makeJwt({ sub: 'reset-sub' });
    const next: NextFunction = jest.fn();

    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), next);
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), next);

    resetSocialAntiEnumerationMetrics();
    const m = getSocialAntiEnumerationMetrics();
    expect(m.attempts).toBe(0);
    expect(m.rejections).toBe(0);
  });
});

// ── Auth boundary: unknown provider falls through to IP bucket ─────────────────

describe('createSocialAntiEnumerationMiddleware — auth boundary / edge cases', () => {
  beforeEach(() => resetSocialAntiEnumerationMetrics());

  it('unknown provider falls through to IP-based fallback bucket', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { ipFallbackLimit: 5 });
    const token = makeJwt({ sub: 'sub-123' });
    const req = makeReq({ params: { provider: 'github' }, body: { idToken: token }, ip: '7.7.7.7' });
    const next: NextFunction = jest.fn();

    mw(req, makeRes(), next);
    // socialProviderSub is NOT set — github is unsupported
    expect((req as any).socialProviderSub).toBeUndefined();
    // But the middleware still calls next (under IP limit)
    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toBeUndefined();
  });

  it('missing params object falls through gracefully', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { ipFallbackLimit: 5 });
    const req = makeReq({ params: undefined as any, body: {}, ip: '8.8.8.8' });
    const next: NextFunction = jest.fn();

    expect(() => mw(req, makeRes(), next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('X-RateLimit-Remaining reaches 0 (not negative) at the limit boundary', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 2 });
    const token = makeJwt({ sub: 'boundary-sub' });
    const next: NextFunction = jest.fn();

    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), makeRes(), next);
    const res2 = makeRes();
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token } }), res2, next); // count = 2, remaining = 0

    expect(res2.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('per-sub and IP buckets are isolated (exhausting sub bucket does not exhaust IP bucket)', () => {
    const store = new InMemoryRateLimitStore();
    // Use the same store; sub-bucket limit = 1, IP-fallback limit = 5
    const mw = createSocialAntiEnumerationMiddlewareWithStore(store, { limit: 1, ipFallbackLimit: 5 });
    const token = makeJwt({ sub: 'isolation-sub' });
    const nextSub: NextFunction = jest.fn();
    const nextIp: NextFunction = jest.fn();

    // Exhaust the sub bucket
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '3.3.3.3' }), makeRes(), nextSub);
    mw(makeReq({ params: { provider: 'google' }, body: { idToken: token }, ip: '3.3.3.3' }), makeRes(), nextSub); // blocked

    // IP fallback for a malformed token on the same IP — independent
    mw(makeReq({ params: { provider: 'google' }, body: {}, ip: '3.3.3.3' }), makeRes(), nextIp); // allowed (different bucket)

    expect((nextSub as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
    expect((nextIp as jest.Mock).mock.calls[0][0]).toBeUndefined();
  });
});
