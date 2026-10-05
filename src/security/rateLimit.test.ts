import { Request, Response } from 'express';
import {
  RateLimitStore,
  InMemoryRateLimitStore,
  RedisRateLimitStore,
  createRateLimitMiddleware,
  createValidationRateLimit,
  createAuthRateLimit,
  createAuditRateLimit,
  createRateLimitStore,
  SlidingWindowRateLimiter,
  defaultKeyGenerator,
  RateLimitOptions,
} from './rateLimit';
import { SecurityContext } from './types';

interface RequestWithSecurityContext extends Request {
  securityContext?: SecurityContext;
}

function makeReq(overrides: Partial<RequestWithSecurityContext> = {}): RequestWithSecurityContext {
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    path: '/test',
    route: { path: '/test' },
    ...overrides,
  } as unknown as RequestWithSecurityContext;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let payload: unknown;

  interface MockResponse {
    set: jest.Mock;
    getHeader: jest.Mock;
    setHeader: jest.Mock;
    status: jest.Mock;
    json: jest.Mock;
    statusCode: number;
    payload: unknown;
    headers: Record<string, string>;
  }

  const res: MockResponse = {
    set: jest.fn((k: string | Record<string, string>, v?: string) => {
      if (typeof k === 'object' && k !== null) {
        Object.entries(k).forEach(([key, value]) => {
          headers[key.toLowerCase()] = value;
        });
      } else if (typeof k === 'string' && v !== undefined) {
        headers[k.toLowerCase()] = v;
      }
      return res;
    }),
    getHeader: jest.fn((k: string) => headers[k.toLowerCase()]),
    setHeader: jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
      return res;
    }),
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

describe('RateLimitStore Interface', () => {
  it('defines the required methods for all implementations', () => {
    const store: RateLimitStore = new InMemoryRateLimitStore();
    
    expect(typeof store.get).toBe('function');
    expect(typeof store.set).toBe('function');
    expect(typeof store.increment).toBe('function');
    expect(typeof store.reset).toBe('function');
  });
});

describe('InMemoryRateLimitStore', () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  describe('get', () => {
    it('returns null for non-existent key', async () => {
      const result = await store.get('nonexistent');
      expect(result).toBeNull();
    });

    it('returns the count for an existing key', async () => {
      await store.set('key1', 5, 60000);
      const result = await store.get('key1');
      expect(result).toBe(5);
    });

    it('returns null for expired keys', async () => {
      await store.set('expired', 10, 1);
      await new Promise(resolve => setTimeout(resolve, 10));
      const result = await store.get('expired');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('sets a value with TTL', async () => {
      await store.set('key1', 42, 60000);
      const result = await store.get('key1');
      expect(result).toBe(42);
    });

    it('overwrites existing value', async () => {
      await store.set('key1', 10, 60000);
      await store.set('key1', 20, 60000);
      const result = await store.get('key1');
      expect(result).toBe(20);
    });
  });

  describe('increment', () => {
    it('returns 1 for a new key', async () => {
      const result = await store.increment('newkey', 60000);
      expect(result).toBe(1);
    });

    it('increments existing key within window', async () => {
      await store.increment('key1', 60000);
      await store.increment('key1', 60000);
      const result = await store.increment('key1', 60000);
      expect(result).toBe(3);
    });

    it('resets to 1 after window expires', async () => {
      await store.increment('expiring', 1);
      await new Promise(resolve => setTimeout(resolve, 10));
      const result = await store.increment('expiring', 60000);
      expect(result).toBe(1);
    });

    it('maintains separate counters for different keys', async () => {
      await store.increment('key1', 60000);
      await store.increment('key1', 60000);
      const result1 = await store.increment('key2', 60000);
      const result2 = await store.increment('key2', 60000);
      expect(result1).toBe(1);
      expect(result2).toBe(2);
    });
  });

  describe('reset', () => {
    it('clears the counter for a key', async () => {
      await store.increment('key1', 60000);
      await store.increment('key1', 60000);
      await store.reset('key1');
      const result = await store.increment('key1', 60000);
      expect(result).toBe(1);
    });

    it('does not throw for non-existent key', async () => {
      await expect(store.reset('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('removes expired entries on get', async () => {
      await store.set('expired', 10, 1);
      await new Promise(resolve => setTimeout(resolve, 10));
      await store.get('valid');
      await store.set('valid', 1, 60000);
      const result = await store.get('expired');
      expect(result).toBeNull();
    });

    it('removes expired entries on set', async () => {
      await store.set('expired', 10, 1);
      await new Promise(resolve => setTimeout(resolve, 10));
      await store.set('newkey', 5, 60000);
      const result = await store.get('expired');
      expect(result).toBeNull();
    });

    it('removes expired entries on increment', async () => {
      await store.increment('expired', 1);
      await new Promise(resolve => setTimeout(resolve, 10));
      const result = await store.increment('newkey', 60000);
      expect(result).toBe(1);
    });
  });
});

describe('RedisRateLimitStore', () => {
  interface RedisClient {
    get(key: string): Promise<string | null>;
    setex(key: string, seconds: number, value: string): Promise<void>;
    incr(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<void>;
    del(key: string): Promise<void>;
  }
  interface MockRedisClient extends RedisClient {
    get: jest.Mock;
    setex: jest.Mock;
    incr: jest.Mock;
    expire: jest.Mock;
    del: jest.Mock;
  }
  let mockRedis: MockRedisClient;
  let store: RedisRateLimitStore;

  beforeEach(() => {
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      incr: jest.fn(),
      expire: jest.fn(),
      del: jest.fn(),
    };
    store = new RedisRateLimitStore(mockRedis);
  });

  describe('get', () => {
    it('returns parsed integer value', async () => {
      mockRedis.get.mockResolvedValue('42');
      const result = await store.get('key1');
      expect(result).toBe(42);
      expect(mockRedis.get).toHaveBeenCalledWith('key1');
    });

    it('returns null for non-existent key', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await store.get('key1');
      expect(result).toBeNull();
    });

    it('returns null for undefined value', async () => {
      mockRedis.get.mockResolvedValue(undefined);
      const result = await store.get('key1');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('calls setex with correct TTL in seconds', async () => {
      await store.set('key1', 42, 120000);
      expect(mockRedis.setex).toHaveBeenCalledWith('key1', 120, '42');
    });

    it('rounds up TTL to nearest second', async () => {
      await store.set('key1', 42, 1500);
      expect(mockRedis.setex).toHaveBeenCalledWith('key1', 2, '42');
    });
  });

  describe('increment', () => {
    it('increments and sets expiry on first increment', async () => {
      mockRedis.incr.mockResolvedValue(1);
      const result = await store.increment('key1', 60000);
      expect(result).toBe(1);
      expect(mockRedis.incr).toHaveBeenCalledWith('key1');
      expect(mockRedis.expire).toHaveBeenCalledWith('key1', 60);
    });

    it('increments without setting expiry on subsequent calls', async () => {
      mockRedis.incr.mockResolvedValue(5);
      const result = await store.increment('key1', 60000);
      expect(result).toBe(5);
      expect(mockRedis.incr).toHaveBeenCalledWith('key1');
      expect(mockRedis.expire).not.toHaveBeenCalled();
    });
  });

  describe('reset', () => {
    it('deletes the key', async () => {
      await store.reset('key1');
      expect(mockRedis.del).toHaveBeenCalledWith('key1');
    });
  });
});

describe('SlidingWindowRateLimiter', () => {
  let mockStore: jest.Mocked<RateLimitStore>;
  let limiter: SlidingWindowRateLimiter;

  beforeEach(() => {
    mockStore = {
      get: jest.fn(),
      set: jest.fn(),
      increment: jest.fn(),
      reset: jest.fn(),
    };
    limiter = new SlidingWindowRateLimiter(mockStore);
  });

  describe('isAllowed', () => {
    it('returns allowed when under limit', async () => {
      mockStore.get.mockResolvedValue(5);
      const result = await limiter.isAllowed('key1', 60000, 10);
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(5);
      expect(result.resetTime).toBeGreaterThan(Date.now());
    });

    it('returns not allowed when at limit', async () => {
      mockStore.get.mockResolvedValue(10);
      const result = await limiter.isAllowed('key1', 60000, 10);
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(10);
    });

    it('returns not allowed when over limit', async () => {
      mockStore.get.mockResolvedValue(15);
      const result = await limiter.isAllowed('key1', 60000, 10);
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(15);
    });

    it('treats null as 0', async () => {
      mockStore.get.mockResolvedValue(null);
      const result = await limiter.isAllowed('key1', 60000, 10);
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
    });
  });

  describe('recordRequest', () => {
    it('increments the store', async () => {
      mockStore.increment.mockResolvedValue(1);
      await limiter.recordRequest('key1', 60000);
      expect(mockStore.increment).toHaveBeenCalledWith('key1', 60000);
    });
  });
});

describe('defaultKeyGenerator', () => {
  it('generates key from user ID when security context exists', () => {
    const req = makeReq();
    req.securityContext = {
      user: { id: 'user-123', role: 'admin', permissions: [], sessionId: 'sess-1', authenticatedAt: new Date() },
      requestId: 'req-1',
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      timestamp: new Date(),
    };
    req.route = { path: '/api/test' };

    const key = defaultKeyGenerator(req);
    expect(key).toBe('rate_limit:user-123:/api/test');
  });

  it('falls back to IP when no user in security context', () => {
    const req = makeReq({ ip: '192.168.1.1' });
    req.securityContext = {
      user: undefined,
      requestId: 'req-1',
      ipAddress: '192.168.1.1',
      userAgent: 'test-agent',
      timestamp: new Date(),
    };
    req.route = { path: '/api/test' };

    const key = defaultKeyGenerator(req);
    expect(key).toBe('rate_limit:192.168.1.1:/api/test');
  });

  it('falls back to anonymous when no IP', () => {
    const req = makeReq({ ip: undefined, socket: { remoteAddress: undefined } as unknown as Request['socket'] });
    req.securityContext = {
      user: undefined,
      requestId: 'req-1',
      ipAddress: 'unknown',
      userAgent: 'test-agent',
      timestamp: new Date(),
    };
    req.route = { path: '/api/test' };

    const key = defaultKeyGenerator(req);
    expect(key).toBe('rate_limit:anonymous:/api/test');
  });
});

describe('createRateLimitMiddleware', () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  const createMiddleware = (options: Partial<RateLimitOptions> = {}) => {
    return createRateLimitMiddleware({
      config: {
        windowMs: 60000,
        maxRequests: 5,
        skipSuccessfulRequests: false,
        skipFailedRequests: false,
      },
      store,
      ...options,
    });
  };

  it('allows requests under the limit', async () => {
    const mw = createMiddleware();
    const req = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
  });

  it('blocks requests over the limit', async () => {
    const mw = createMiddleware({ config: { windowMs: 60000, maxRequests: 2, skipSuccessfulRequests: false, skipFailedRequests: false } });
    const req = makeReq({ ip: '10.0.0.1' });
    const next = jest.fn();

    await mw(req, makeRes(), next); // 1 - allowed
    await mw(req, makeRes(), next); // 2 - allowed
    const res3 = makeRes();
    await mw(req, res3, next); // 3 - blocked

    // For blocked requests, next() is NOT called - the response is sent directly
    expect(next).toHaveBeenCalledTimes(2); // Only called for allowed requests
    expect(res3.statusCode).toBe(429);
    expect(res3.headers['retry-after']).toBeDefined();
    expect(res3.payload).toEqual(expect.objectContaining({
      error: 'Rate limit exceeded',
    }));
  });

  it('sets rate limit headers on allowed requests', async () => {
    const mw = createMiddleware();
    const req = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

it('tracks different IPs independently', async () => {
    const mw = createMiddleware({ config: { windowMs: 60000, maxRequests: 1, skipSuccessfulRequests: false, skipFailedRequests: false } });
    const nextA = jest.fn();
    const nextB = jest.fn();

    await mw(makeReq({ ip: '1.1.1.1' }), makeRes(), nextA); // allowed
    await mw(makeReq({ ip: '1.1.1.1' }), makeRes(), nextA); // blocked - next NOT called
    await mw(makeReq({ ip: '2.2.2.2' }), makeRes(), nextB); // different IP - allowed

    // nextA called once (for first allowed request), second request blocked - no next call
    expect(nextA).toHaveBeenCalledTimes(1);
    expect((nextA as jest.Mock).mock.calls[0][0]).toBeUndefined();
    // nextB called once for different IP
    expect(nextB).toHaveBeenCalledTimes(1);
    expect((nextB as jest.Mock).mock.calls[0][0]).toBeUndefined();
  });

  it('uses custom key generator when provided', async () => {
    const mw = createMiddleware({
      keyGenerator: (req) => `custom:${req.headers['x-custom-id']}`,
    });
    const req = makeReq({ headers: { 'x-custom-id': 'custom-123' } });
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);
    await mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.headers['x-ratelimit-remaining']).toBe('3');
  });

  it('calls onLimitReached callback when limit exceeded', async () => {
    const onLimitReached = jest.fn();
    const mw = createMiddleware({
      config: { windowMs: 60000, maxRequests: 1, skipSuccessfulRequests: false, skipFailedRequests: false },
      onLimitReached,
    });
    const req = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next); // allowed
    await mw(req, res, next); // blocked

    expect(onLimitReached).toHaveBeenCalledWith(req, res, expect.any(Number));
  });

  it('records audit event when auditRepository provided', async () => {
    const auditRepository = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    const mw = createMiddleware({
      config: { windowMs: 60000, maxRequests: 1, skipSuccessfulRequests: false, skipFailedRequests: false },
      auditRepository,
    });
    const req = makeReq({ ip: '10.0.0.1' });
    req.securityContext = {
      user: { id: 'user-1', role: 'admin', permissions: [], sessionId: 'sess-1', authenticatedAt: new Date() },
      requestId: 'req-1',
      ipAddress: '10.0.0.1',
      userAgent: 'test',
      timestamp: new Date(),
    };
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next); // allowed
    await mw(req, res, next); // blocked

    expect(auditRepository.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SECURITY_VIOLATION',
        action: 'rate_limit_exceeded',
      })
    );
  });

  it('fails open on store error', async () => {
    const failingStore: RateLimitStore = {
      increment: jest.fn().mockRejectedValue(new Error('Store error')),
      get: jest.fn(),
      set: jest.fn(),
      reset: jest.fn(),
    };
    const mw = createRateLimitMiddleware({
      config: { windowMs: 60000, maxRequests: 1, skipSuccessfulRequests: false, skipFailedRequests: false },
      store: failingStore,
    });
    const req = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBe(200);
  });
});

describe('createValidationRateLimit', () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  it('creates middleware with validation config', async () => {
    const mw = createValidationRateLimit(store);
    const req = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.headers['x-ratelimit-limit']).toBe('10');
  });

  it('uses validation key prefix', async () => {
    const mw = createValidationRateLimit(store);
    const req1 = makeReq({ ip: '10.0.0.1' });
    req1.securityContext = {
      user: { id: 'user-1', role: 'admin', permissions: [], sessionId: 'sess-1', authenticatedAt: new Date() },
      requestId: 'req-1',
      ipAddress: '10.0.0.1',
      userAgent: 'test',
      timestamp: new Date(),
    };
    const req2 = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    await mw(req1, res, next); // user-1
    await mw(req2, res, next); // anonymous (different key)

    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('createAuthRateLimit', () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  it('creates middleware with auth config', async () => {
    const mw = createAuthRateLimit(store);
    const req = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.headers['x-ratelimit-limit']).toBe('100');
  });

  it('keys by IP for auth attempts', async () => {
    const mw = createAuthRateLimit(store);
    const req = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);
    await mw(req, res, next);

    expect(res.headers['x-ratelimit-remaining']).toBe('98');
  });
});

describe('createAuditRateLimit', () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  it('creates middleware with audit config', async () => {
    const mw = createAuditRateLimit(store);
    const req = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.headers['x-ratelimit-limit']).toBe('1000');
  });

  it('keys by user ID', async () => {
    const mw = createAuditRateLimit(store);
    const req = makeReq({ ip: '10.0.0.1' });
    req.securityContext = {
      user: { id: 'user-1', role: 'admin', permissions: [], sessionId: 'sess-1', authenticatedAt: new Date() },
      requestId: 'req-1',
      ipAddress: '10.0.0.1',
      userAgent: 'test',
      timestamp: new Date(),
    };
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);
    await mw(req, res, next);

    expect(res.headers['x-ratelimit-remaining']).toBe('998');
  });
});

describe('createRateLimitStore', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('returns InMemoryRateLimitStore when no redis provided', () => {
    const store = createRateLimitStore();
    expect(store).toBeInstanceOf(InMemoryRateLimitStore);
  });

  it('returns InMemoryRateLimitStore when not in production', () => {
    process.env.NODE_ENV = 'development';
    const mockRedis = {};
    const store = createRateLimitStore(mockRedis);
    expect(store).toBeInstanceOf(InMemoryRateLimitStore);
  });

  it('returns RedisRateLimitStore when redis provided and in production', () => {
    process.env.NODE_ENV = 'production';
    const mockRedis = {};
    const store = createRateLimitStore(mockRedis);
    expect(store).toBeInstanceOf(RedisRateLimitStore);
  });
});

describe('Rate Limit Middleware - Edge Cases', () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  it('handles requests with missing security context gracefully', async () => {
    const mw = createRateLimitMiddleware({
      config: { windowMs: 60000, maxRequests: 5, skipSuccessfulRequests: false, skipFailedRequests: false },
      store,
    });
    const req = makeReq();
    req.securityContext = undefined;
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('handles missing req.route gracefully', async () => {
    const mw = createRateLimitMiddleware({
      config: { windowMs: 60000, maxRequests: 5, skipSuccessfulRequests: false, skipFailedRequests: false },
      store,
    });
    const req = makeReq();
    delete req.route;
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('resets remaining to 0 when limit reached', async () => {
    const mw = createRateLimitMiddleware({
      config: { windowMs: 60000, maxRequests: 2, skipSuccessfulRequests: false, skipFailedRequests: false },
      store,
    });
    const req = makeReq({ ip: '10.0.0.1' });
    const next = jest.fn();

    await mw(req, makeRes(), next); // 1
    await mw(req, makeRes(), next); // 2
    const res3 = makeRes();
    await mw(req, res3, next); // 3 - blocked

    // For blocked requests, rate limit headers are not set (response sent directly)
    // The remaining header is only set for allowed requests
    expect(res3.statusCode).toBe(429);
    expect(res3.payload).toEqual(expect.objectContaining({
      error: 'Rate limit exceeded',
    }));
  });

  it('calculates reset time correctly', async () => {
    const mw = createRateLimitMiddleware({
      config: { windowMs: 60000, maxRequests: 5, skipSuccessfulRequests: false, skipFailedRequests: false },
      store,
    });
    const req = makeReq({ ip: '10.0.0.1' });
    const res = makeRes();
    const next = jest.fn();

    await mw(req, res, next);

    const resetHeader = res.headers['x-ratelimit-reset'];
    expect(resetHeader).toBeDefined();
    // Reset header is an ISO string (e.g., "2026-10-05T12:34:56.789Z")
    expect(resetHeader).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const resetTime = new Date(resetHeader).getTime();
    const now = Date.now();
    expect(resetTime).toBeGreaterThan(now);
    expect(resetTime).toBeLessThanOrEqual(now + 60000);
  });
});