import { Request, Response, NextFunction } from 'express';
import {
  createRateLimitMiddleware,
  InMemoryRateLimitStore,
} from './rateLimit';
import { AppError } from '../lib/errors';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let payload: unknown;

  const res: any = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    getHeader: jest.fn((k: string) => headers[k.toLowerCase()]),
    status: jest.fn(function (code: number) {
      statusCode = code;
      return res;
    }),
    json: jest.fn(function (data: unknown) {
      payload = data;
      return res;
    }),
    get statusCode() {
      return statusCode;
    },
    get payload() {
      return payload;
    },
    get headers() {
      return headers;
    },
  };

  return res as unknown as Response & {
    statusCode: number;
    payload: unknown;
    headers: Record<string, string>;
  };
}

describe('InMemoryRateLimitStore', () => {
  it('increments counter within a window', () => {
    const store = new InMemoryRateLimitStore();
    const r1 = store.increment('key1', 60_000);
    const r2 = store.increment('key1', 60_000);
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(2);
    expect(r1.resetAt).toBe(r2.resetAt);
  });

  it('resets counter after window expires', () => {
    const store = new InMemoryRateLimitStore();
    store.increment('key2', 1); // 1 ms window — will expire immediately
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        const r = store.increment('key2', 60_000);
        expect(r.count).toBe(1);
        resolve();
      }, 10),
    );
  });

  it('reset() clears the entry', () => {
    const store = new InMemoryRateLimitStore();
    store.increment('key3', 60_000);
    store.increment('key3', 60_000);
    store.reset('key3');
    const r = store.increment('key3', 60_000);
    expect(r.count).toBe(1);
  });

  it('clear() resets all keys', () => {
    const store = new InMemoryRateLimitStore();
    store.increment('key-a', 60_000);
    store.increment('key-b', 60_000);
    store.clear();

    const a = store.increment('key-a', 60_000);
    const b = store.increment('key-b', 60_000);
    expect(a.count).toBe(1);
    expect(b.count).toBe(1);
  });

  // Task 1.1 — additional InMemoryRateLimitStore tests

  it('increment on an expired window creates a new window with count = 1 (Requirement 6.3)', () => {
    const store = new InMemoryRateLimitStore();
    const r1 = store.increment('expiry-key', 1); // 1 ms window
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        const r2 = store.increment('expiry-key', 60_000);
        expect(r2.count).toBe(1);
        expect(r2.resetAt).toBeGreaterThan(r1.resetAt);
        resolve();
      }, 10),
    );
  });

  it('increment returns the same resetAt for all calls within the same window (Requirement 6.4)', () => {
    const store = new InMemoryRateLimitStore();
    const r1 = store.increment('same-window', 60_000);
    const r2 = store.increment('same-window', 60_000);
    const r3 = store.increment('same-window', 60_000);
    expect(r1.resetAt).toBe(r2.resetAt);
    expect(r2.resetAt).toBe(r3.resetAt);
  });

  it('clear() is a no-op on an already-empty store (Requirement 6.6 edge case)', () => {
    const store = new InMemoryRateLimitStore();
    // Should not throw on an empty store
    expect(() => store.clear()).not.toThrow();
    // Store should still work normally after clearing an empty store
    const r = store.increment('after-clear', 60_000);
    expect(r.count).toBe(1);
  });

  it('reset() on a non-existent key does not throw (Requirement 6.5 edge case)', () => {
    const store = new InMemoryRateLimitStore();
    expect(() => store.reset('nonexistent')).not.toThrow();
  });
});

describe('createRateLimitMiddleware — per IP', () => {
  it('passes through when under the limit', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 5, windowMs: 60_000, store });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
    expect(res.statusCode).toBe(200);
  });

  it('calls next(error) when limit is exceeded', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 2, windowMs: 60_000, store });
    const req = makeReq();
    const next: NextFunction = jest.fn();

    mw(req, makeRes(), next); // count = 1 — allowed
    mw(req, makeRes(), next); // count = 2 — allowed
    const res3 = makeRes();
    mw(req, res3, next); // count = 3 — over limit, next(err)

    // next called 3 times total; 3rd call carries an AppError
    expect(next).toHaveBeenCalledTimes(3);
    const err = (next as jest.Mock).mock.calls[2][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('TOO_MANY_REQUESTS');
    expect(res3.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('sets X-RateLimit-* headers on every allowed request', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 10, windowMs: 60_000, store });
    const req = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);

    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('tracks different IPs independently', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 1, windowMs: 60_000, store });
    const nextA: NextFunction = jest.fn();
    const nextB: NextFunction = jest.fn();

    mw(makeReq({ ip: '1.1.1.1' }), makeRes(), nextA); // allowed — next(undefined)
    mw(makeReq({ ip: '1.1.1.1' }), makeRes(), nextA); // blocked — next(AppError)
    mw(makeReq({ ip: '2.2.2.2' }), makeRes(), nextB); // different IP — allowed

    // nextA called twice: 1st allowed, 2nd blocked with error
    expect(nextA).toHaveBeenCalledTimes(2);
    expect((nextA as jest.Mock).mock.calls[0][0]).toBeUndefined();
    expect((nextA as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
    // nextB called once without error
    expect(nextB).toHaveBeenCalledTimes(1);
    expect((nextB as jest.Mock).mock.calls[0][0]).toBeUndefined();
  });
});

describe('createRateLimitMiddleware — per user', () => {
  it('uses req.user.sub as the key', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 2, windowMs: 60_000, perUser: true, store });
    const req = makeReq({ ['user' as any]: { sub: 'user-abc' } } as any);
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);
    mw(req, res, next);
    mw(req, res, next); // over limit

    expect(next).toHaveBeenCalledTimes(3); // next is called with error on 3rd
    expect((next as jest.Mock).mock.calls[2][0]).toBeInstanceOf(AppError);
  });

  it('calls next() without blocking when no user is set (unauthenticated)', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 1, windowMs: 60_000, perUser: true, store });
    const req = makeReq(); // no user
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);
    mw(req, res, next); // second call — still no user, still passes

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
  });

  it('isolates counters by keyPrefix when sharing a store', () => {
    const store = new InMemoryRateLimitStore();
    const tierA = createRateLimitMiddleware({
      limit: 1,
      windowMs: 60_000,
      keyPrefix: 'tier-a',
      store,
    });
    const tierB = createRateLimitMiddleware({
      limit: 1,
      windowMs: 60_000,
      keyPrefix: 'tier-b',
      store,
    });

    const nextA = jest.fn();
    const nextB = jest.fn();
    const req = makeReq({ ip: '3.3.3.3' });
    const resA1 = makeRes();
    const resB1 = makeRes();
    const resA2 = makeRes();
    const resB2 = makeRes();

    tierA(req, resA1, nextA); // allowed
    tierB(req, resB1, nextB); // allowed (independent counter)
    tierA(req, resA2, nextA); // blocked — next called with error
    tierB(req, resB2, nextB); // blocked — next called with error

    // nextA called twice: once allowed, once with error
    expect(nextA).toHaveBeenCalledTimes(2);
    expect(nextB).toHaveBeenCalledTimes(2);
    // The second call to each should be an AppError (blocked)
    expect((nextA as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
    expect((nextB as jest.Mock).mock.calls[1][0]).toBeInstanceOf(AppError);
  });
});

// Task 1.2 — additional createRateLimitMiddleware tests
describe('createRateLimitMiddleware — header and error correctness', () => {
  it('X-RateLimit-Remaining is exactly 0 (not negative) when count equals limit (Requirement 4.5)', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 2, windowMs: 60_000, store });
    const req = makeReq();
    const next: NextFunction = jest.fn();

    mw(req, makeRes(), next); // count = 1, remaining = 1
    const res2 = makeRes();
    mw(req, res2, next); // count = 2, remaining = 0

    expect(res2.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('X-RateLimit-Remaining is 0 on the blocked (limit+1) request (Requirement 4.5)', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 2, windowMs: 60_000, store });
    const req = makeReq();
    const next: NextFunction = jest.fn();

    mw(req, makeRes(), next); // count = 1
    mw(req, makeRes(), next); // count = 2
    const res3 = makeRes();
    mw(req, res3, next); // count = 3 — blocked

    expect(res3.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('Retry-After header is present and is a positive integer on a 429 response (Requirement 3.3)', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 1, windowMs: 60_000, store });
    const req = makeReq();
    const next: NextFunction = jest.fn();

    mw(req, makeRes(), next); // count = 1 — allowed
    const res2 = makeRes();
    mw(req, res2, next); // count = 2 — blocked

    const retryAfter = res2.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    expect(parseInt(retryAfter, 10)).toBeGreaterThan(0);
  });

  it('next() is called with an AppError whose code === TOO_MANY_REQUESTS on the blocked request (Requirement 8.5)', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 1, windowMs: 60_000, store });
    const req = makeReq();
    const next: NextFunction = jest.fn();

    mw(req, makeRes(), next); // count = 1 — allowed, next called without error
    mw(req, makeRes(), next); // count = 2 — blocked, next called with AppError

    expect(next).toHaveBeenCalledTimes(2);
    const err = (next as jest.Mock).mock.calls[1][0];
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('TOO_MANY_REQUESTS');
  });

  it('IP fallback to req.socket.remoteAddress when req.ip is undefined (Requirement 5.3)', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 3, windowMs: 60_000, store });
    const req = makeReq({ ip: undefined, socket: { remoteAddress: '5.5.5.5' } as any });
    const next: NextFunction = jest.fn();

    mw(req, makeRes(), next); // count = 1
    const res2 = makeRes();
    mw(req, res2, next); // count = 2

    // Both requests share the same counter (same socket address)
    expect(res2.headers['x-ratelimit-remaining']).toBe('1'); // limit(3) - count(2) = 1
  });

  it('IP fallback to unknown when both req.ip and req.socket.remoteAddress are undefined (Requirement 5.4)', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 5, windowMs: 60_000, store });
    const req = makeReq({ ip: undefined, socket: undefined as any });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    // Should not throw — uses 'unknown' as the key
    expect(() => mw(req, res, next)).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
    // Called without an error (allowed)
    expect((next as jest.Mock).mock.calls[0][0]).toBeUndefined();
  });

  it('keyPrefix isolates counters — exhausting prefix-a does not affect prefix-b (Requirement 5.6)', () => {
    const store = new InMemoryRateLimitStore();
    const mwA = createRateLimitMiddleware({ limit: 1, windowMs: 60_000, keyPrefix: 'prefix-a', store });
    const mwB = createRateLimitMiddleware({ limit: 1, windowMs: 60_000, keyPrefix: 'prefix-b', store });
    const req = makeReq({ ip: '9.9.9.9' });
    const nextA: NextFunction = jest.fn();
    const nextB: NextFunction = jest.fn();

    mwA(req, makeRes(), nextA); // prefix-a: count = 1 — allowed
    mwA(req, makeRes(), nextA); // prefix-a: count = 2 — blocked

    // prefix-b counter is independent — first request should be allowed
    const resB = makeRes();
    mwB(req, resB, nextB);

    // nextB called once without error (allowed)
    expect(nextB).toHaveBeenCalledTimes(1);
    expect((nextB as jest.Mock).mock.calls[0][0]).toBeUndefined();
    // prefix-b remaining should be limit-1 = 0
    expect(resB.headers['x-ratelimit-remaining']).toBe('0');
  });
});
