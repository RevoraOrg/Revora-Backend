import { NextFunction, Request, Response } from 'express';
import {
  createStartupRegisterRateLimit,
  InMemoryRateLimitStore,
  RateLimitStore,
} from './startupRegisterRateLimit';
import { ErrorCode } from '../lib/errors';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(ip = '1.2.3.4'): Request {
  return { ip } as unknown as Request;
}

function makeRes() {
  let statusCode = 200;
  let body: unknown = null;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(obj: unknown) {
      body = obj;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    _status: () => statusCode,
    _body: () => body,
    _headers: () => headers,
  };
  return res as unknown as Response & { _status(): number; _body(): unknown; _headers(): Record<string, string> };
}

const noop: NextFunction = jest.fn();

function freshStore() {
  return new InMemoryRateLimitStore();
}

// ── InMemoryRateLimitStore ────────────────────────────────────────────────────

describe('InMemoryRateLimitStore', () => {
  it('returns undefined for unknown key', () => {
    const store = freshStore();
    expect(store.get('x')).toBeUndefined();
  });

  it('stores and retrieves an entry', () => {
    const store = freshStore();
    store.set('k', { timestamps: [1, 2, 3] });
    expect(store.get('k')).toEqual({ timestamps: [1, 2, 3] });
  });

  it('clear() removes all entries', () => {
    const store = freshStore();
    store.set('a', { timestamps: [1] });
    store.set('b', { timestamps: [2] });
    store.clear();
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeUndefined();
  });
});

// ── createStartupRegisterRateLimit ────────────────────────────────────────────

describe('createStartupRegisterRateLimit', () => {
  let store: InMemoryRateLimitStore;
  let warnSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    store = freshStore();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  // ── skip option ─────────────────────────────────────────────────────────────

  it('calls next() immediately when skip=true', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ skip: true, store });
    mw(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── happy path ──────────────────────────────────────────────────────────────

  it('allows requests below the limit and calls next()', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 3, windowMs: 60_000, store });

    mw(makeReq(), makeRes(), next);
    mw(makeReq(), makeRes(), next);
    mw(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalledTimes(3);
  });

  it('logs an info event for each allowed attempt', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 5, windowMs: 60_000, store });

    mw(makeReq(), makeRes(), next);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(infoSpy.mock.calls[0][0]);
    expect(log.type).toBe('rate_limit');
    expect(log.event).toBe('STARTUP_REGISTER_ATTEMPT');
    expect(log.count).toBe(1);
  });

  // ── blocking ────────────────────────────────────────────────────────────────

  it('returns 429 with FORBIDDEN code when limit is exceeded', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 2, windowMs: 60_000, store });

    mw(makeReq(), makeRes(), next); // 1
    mw(makeReq(), makeRes(), next); // 2

    const res = makeRes();
    mw(makeReq(), res, next); // 3 — should be blocked

    expect(res._status()).toBe(429);
    const body = res._body() as any;
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toMatch(/too many/i);
  });

  it('does not call next() when the request is blocked', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 1, windowMs: 60_000, store });

    mw(makeReq(), makeRes(), next); // allowed
    mw(makeReq(), makeRes(), next); // blocked

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('logs a warn event when a request is blocked', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 1, windowMs: 60_000, store });

    mw(makeReq(), makeRes(), next);
    mw(makeReq(), makeRes(), next); // blocked

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const log = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(log.event).toBe('STARTUP_REGISTER_BLOCKED');
    expect(log.key).toBe('1.2.3.4');
  });

  it('blocked response body does not contain raw internal error strings', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 1, windowMs: 60_000, store });

    mw(makeReq(), makeRes(), next);
    const res = makeRes();
    mw(makeReq(), res, next);

    const body = res._body() as any;
    // Must not leak stack traces or DB error strings
    expect(typeof body.code).toBe('string');
    expect(typeof body.message).toBe('string');
    expect(body).not.toHaveProperty('stack');
    expect(body).not.toHaveProperty('details');
  });

  // ── sliding window ──────────────────────────────────────────────────────────

  it('allows requests again after the window expires', () => {
    jest.useFakeTimers();
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 2, windowMs: 1_000, store });

    mw(makeReq(), makeRes(), next); // t=0
    mw(makeReq(), makeRes(), next); // t=0 — at limit

    // Advance past the window
    jest.advanceTimersByTime(1_001);

    mw(makeReq(), makeRes(), next); // should be allowed again

    expect(next).toHaveBeenCalledTimes(3);
    jest.useRealTimers();
  });

  it('counts only timestamps within the window', () => {
    jest.useFakeTimers();
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 2, windowMs: 5_000, store });

    mw(makeReq(), makeRes(), next); // t=0
    jest.advanceTimersByTime(6_000);   // first timestamp now outside window
    mw(makeReq(), makeRes(), next); // t=6000 — window reset, count=1
    mw(makeReq(), makeRes(), next); // t=6000 — count=2, at limit

    const res = makeRes();
    mw(makeReq(), res, next); // should be blocked

    expect(res._status()).toBe(429);
    jest.useRealTimers();
  });

  // ── per-key isolation ───────────────────────────────────────────────────────

  it('tracks different IPs independently', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 1, windowMs: 60_000, store });

    mw(makeReq('10.0.0.1'), makeRes(), next); // IP-A: 1 — at limit
    mw(makeReq('10.0.0.2'), makeRes(), next); // IP-B: 1 — allowed

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('blocks only the offending IP, not others', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 1, windowMs: 60_000, store });

    mw(makeReq('10.0.0.1'), makeRes(), next); // IP-A: 1 — at limit
    mw(makeReq('10.0.0.1'), makeRes(), next); // IP-A: blocked

    const res = makeRes();
    mw(makeReq('10.0.0.2'), res, next); // IP-B: should pass

    expect(res._status()).toBe(200); // not 429
    expect(next).toHaveBeenCalledTimes(2); // IP-A first + IP-B
  });

  // ── custom keyFn ────────────────────────────────────────────────────────────

  it('uses a custom keyFn when provided', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({
      maxRequests: 1,
      windowMs: 60_000,
      store,
      keyFn: (req) => (req as any).headers?.['x-forwarded-for'] ?? req.ip,
    });

    const reqA = { ip: '1.1.1.1', headers: { 'x-forwarded-for': 'custom-key' } } as unknown as Request;
    const reqB = { ip: '2.2.2.2', headers: { 'x-forwarded-for': 'custom-key' } } as unknown as Request;

    mw(reqA, makeRes(), next); // custom-key: 1 — at limit
    const res = makeRes();
    mw(reqB, res, next); // same custom-key — blocked

    expect(res._status()).toBe(429);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── custom store ────────────────────────────────────────────────────────────

  it('delegates to a custom store implementation', () => {
    const customStore: RateLimitStore = {
      get: jest.fn().mockReturnValue(undefined),
      set: jest.fn(),
    };
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 5, windowMs: 60_000, store: customStore });

    mw(makeReq(), makeRes(), next);

    expect(customStore.get).toHaveBeenCalledWith('1.2.3.4');
    expect(customStore.set).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── unknown IP fallback ─────────────────────────────────────────────────────

  it('falls back to "unknown" key when req.ip is undefined', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 1, windowMs: 60_000, store });

    const req = { ip: undefined } as unknown as Request;
    mw(req, makeRes(), next);
    mw(req, makeRes(), next); // second — should be blocked

    expect(next).toHaveBeenCalledTimes(1);
  });

  // ── rate limit headers ────────────────────────────────────────────────────────

  it('sets X-RateLimit-Limit header on every request', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 5, windowMs: 60_000, store });

    const res = makeRes();
    mw(makeReq(), res, next);

    expect(res._headers()['X-RateLimit-Limit']).toBe('5');
  });

  it('sets X-RateLimit-Remaining header correctly', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 3, windowMs: 60_000, store });

    const res1 = makeRes();
    mw(makeReq(), res1, next);
    expect(res1._headers()['X-RateLimit-Remaining']).toBe('3');

    const res2 = makeRes();
    mw(makeReq(), res2, next);
    expect(res2._headers()['X-RateLimit-Remaining']).toBe('2');

    const res3 = makeRes();
    mw(makeReq(), res3, next);
    expect(res3._headers()['X-RateLimit-Remaining']).toBe('1');
  });

  it('sets X-RateLimit-Reset header on every request', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 5, windowMs: 60_000, store });

    const res = makeRes();
    mw(makeReq(), res, next);

    const resetHeader = res._headers()['X-RateLimit-Reset'];
    expect(resetHeader).toBeDefined();
    const resetTime = parseInt(resetHeader, 10);
    expect(resetTime).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('sets Retry-After header when rate limited', () => {
    const next = jest.fn() as NextFunction;
    const mw = createStartupRegisterRateLimit({ maxRequests: 1, windowMs: 60_000, store });

    mw(makeReq(), makeRes(), next); // allowed
    const res = makeRes();
    mw(makeReq(), res, next); // blocked

    const retryAfter = res._headers()['Retry-After'];
    expect(retryAfter).toBeDefined();
    const retryAfterSeconds = parseInt(retryAfter, 10);
    expect(retryAfterSeconds).toBeGreaterThan(0);
  });
});
