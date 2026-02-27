import { Request, Response, NextFunction } from 'express';
import {
  createRateLimitMiddleware,
  InMemoryRateLimitStore,
} from './rateLimit';

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

  it('returns 429 when limit is exceeded', () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateLimitMiddleware({ limit: 2, windowMs: 60_000, store });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next); // count = 1
    mw(req, res, next); // count = 2
    mw(req, res, next); // count = 3 — over limit

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(429);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect((res.payload as any)?.error).toBe('TooManyRequests');
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

    mw(makeReq({ ip: '1.1.1.1' }), makeRes(), nextA); // allowed
    mw(makeReq({ ip: '1.1.1.1' }), makeRes(), nextA); // blocked
    mw(makeReq({ ip: '2.2.2.2' }), makeRes(), nextB); // different IP — allowed

    expect(nextA).toHaveBeenCalledTimes(1);
    expect(nextB).toHaveBeenCalledTimes(1);
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

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(429);
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
});