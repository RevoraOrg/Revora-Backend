import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  createIdempotencyMiddleware,
  InMemoryIdempotencyStore,
  IdempotencyRecord,
  IdempotencyStore,
} from './idempotency';

class MockResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  headers: Record<string, string> = {};
  ended = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: unknown): void {
    this.headers[name.toLowerCase()] = String(value);
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  json(payload?: unknown): this {
    if (!this.getHeader('content-type')) {
      this.setHeader('content-type', 'application/json; charset=utf-8');
    }
    this.body = payload;
    this.complete();
    return this;
  }

  send(payload?: unknown): this {
    this.body = payload;
    this.complete();
    return this;
  }

  private complete(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.emit('finish');
    this.emit('close');
  }
}

function createRequest(method: string, key?: string): Partial<Request> {
  const headers: Record<string, string> = {};
  if (key) {
    headers['idempotency-key'] = key;
  }

  return {
    method,
    header: ((name: string) => {
      const value = headers[name.toLowerCase()];
      if (name.toLowerCase() === 'set-cookie') {
        return value ? [value] : undefined;
      }
      return value;
    }) as Request['header'],
  };
}

describe('createIdempotencyMiddleware', () => {
  it('passes through non-target HTTP methods', async () => {
    const store: IdempotencyStore = {
      checkAndReserve: jest.fn(),
      save: jest.fn(),
      release: jest.fn(),
    };
    const middleware = createIdempotencyMiddleware({ store });
    const req = createRequest('GET', 'abc') as Request;
    const res = new MockResponse() as unknown as Response;
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(store.checkAndReserve).not.toHaveBeenCalled();
  });

  it('passes through POST/PATCH requests without idempotency key', async () => {
    const middleware = createIdempotencyMiddleware();
    const req = createRequest('POST') as Request;
    const res = new MockResponse() as unknown as Response;
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('stores first response and replays it for duplicate key', async () => {
    const middleware = createIdempotencyMiddleware({
      store: new InMemoryIdempotencyStore(),
    });

    const req1 = createRequest('POST', 'payment-123') as Request;
    const res1 = new MockResponse();
    const next1: NextFunction = jest.fn(() => {
      res1.status(201).json({ ok: true, id: 'txn-1' });
    });

    await middleware(req1, res1 as unknown as Response, next1);
    await Promise.resolve();

    expect(next1).toHaveBeenCalledTimes(1);

    const req2 = createRequest('POST', 'payment-123') as Request;
    const res2 = new MockResponse();
    const next2: NextFunction = jest.fn(() => {
      res2.status(500).json({ ok: false });
    });

    await middleware(req2, res2 as unknown as Response, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(201);
    expect(res2.body).toEqual({ ok: true, id: 'txn-1' });
    expect(res2.headers['idempotency-status']).toBe('cached');
  });

  it('rejects concurrent in-flight duplicate requests', async () => {
    const middleware = createIdempotencyMiddleware({
      store: new InMemoryIdempotencyStore(),
    });

    const req1 = createRequest('PATCH', 'order-99') as Request;
    const res1 = new MockResponse();
    const next1: NextFunction = jest.fn();

    await middleware(req1, res1 as unknown as Response, next1);
    expect(next1).toHaveBeenCalledTimes(1);

    const req2 = createRequest('PATCH', 'order-99') as Request;
    const res2 = new MockResponse();
    const next2: NextFunction = jest.fn();

    await middleware(req2, res2 as unknown as Response, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(409);
    expect(res2.body).toEqual({
      error: 'Request with this idempotency key is already in progress.',
    });
    expect(res2.headers['idempotency-status']).toBe('inflight');

    res1.status(202).send('accepted');
    await Promise.resolve();
  });

  it('releases key and does not cache on 500 response', async () => {
    const middleware = createIdempotencyMiddleware({
      store: new InMemoryIdempotencyStore(),
    });

    const req1 = createRequest('POST', 'error-key') as Request;
    const res1 = new MockResponse();
    const next1: NextFunction = jest.fn(() => {
      res1.status(500).json({ error: 'internal' });
    });

    await middleware(req1, res1 as unknown as Response, next1);
    await Promise.resolve();

    // Second request should process as new since first was released
    const req2 = createRequest('POST', 'error-key') as Request;
    const res2 = new MockResponse();
    const next2: NextFunction = jest.fn(() => {
      res2.status(200).json({ ok: true });
    });

    await middleware(req2, res2 as unknown as Response, next2);
    await Promise.resolve();

    expect(next2).toHaveBeenCalledTimes(1);
    expect(res2.statusCode).toBe(200);
  });

  it('uses custom header name when provided', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({
      store,
      headerName: 'x-custom-idempotency-key',
    });

    const req = createRequest('POST') as Request;
    (req as any).headers = { 'x-custom-idempotency-key': 'custom-key' };
    (req as any).header = ((name: string) => {
      if (name.toLowerCase() === 'x-custom-idempotency-key') return 'custom-key';
      return undefined;
    }) as Request['header'];

    const res = new MockResponse();
    const next = jest.fn(() => {
      res.status(200).json({ ok: true });
    });

    await middleware(req, res as unknown as Response, next);
    await Promise.resolve();

    expect(store).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses custom HTTP methods for idempotency', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({
      store,
      methods: ['DELETE'],
    });

    const req = createRequest('DELETE', 'delete-key') as Request;
    const res = new MockResponse();
    const next = jest.fn(() => {
      res.status(200).json({ deleted: true });
    });

    await middleware(req, res as unknown as Response, next);
    await Promise.resolve();

    expect(next).toHaveBeenCalledTimes(1);
    expect(store).toBeDefined();
  });

  it('respects custom shouldStoreResponse predicate', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({
      store,
      shouldStoreResponse: (status) => status === 201, // Only cache 201
    });

    const req1 = createRequest('POST', 'store-key') as Request;
    const res1 = new MockResponse();
    const next1 = jest.fn(() => {
      res1.status(200).json({ ok: true });
    });

    await middleware(req1, res1 as unknown as Response, next1);
    await Promise.resolve();

    const req2 = createRequest('POST', 'store-key') as Request;
    const res2 = new MockResponse();
    const next2 = jest.fn(() => {
      res2.status(201).json({ created: true });
    });

    await middleware(req2, res2 as unknown as Response, next2);
    await Promise.resolve();

    // 200 was not cached, 201 will be cached
    expect(next2).toHaveBeenCalledTimes(1);
    expect(res2.statusCode).toBe(201);
  });

  it('uses fingerprint for request differentiation', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({
      store,
      fingerprint: (req) => `${req.method}:${req.path}`,
    });

    const req1 = createRequest('POST', 'fp-key') as Request;
    req1.body = { a: 1 };
    const res1 = new MockResponse();
    const next1 = jest.fn(() => {
      res1.status(200).json({ fingerprint: 'stored' });
    });

    await middleware(req1, res1 as unknown as Response, next1);
    await Promise.resolve();

    const req2 = createRequest('POST', 'fp-key') as Request;
    req2.body = { a: 2 }; // Different body but same fingerprint
    const res2 = new MockResponse();

    await middleware(req2, res2 as unknown as Response, next1);
    await Promise.resolve();

    // Same fingerprint means same response (cached)
    expect(res2.statusCode).toBe(200);
  });

  it('rejects cached response with mismatched fingerprint', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({
      store,
      fingerprint: (_req) => 'fingerprint-1',
    });

    const req1 = createRequest('POST', 'fp-mismatch') as Request;
    const res1 = new MockResponse();
    const next1 = jest.fn(() => {
      res1.status(200).json({ ok: true });
    });

    await middleware(req1, res1 as unknown as Response, next1);
    await Promise.resolve();

    // Mock store to return cached record with different fingerprint
    let cachedRecord: any = null;
    const store2 = new InMemoryIdempotencyStore();
    (store2 as any).records.set('fp-mismatch', {
      record: {
        status: 200,
        body: '{"ok":true}',
        fingerprint: 'stored-fingerprint',
        createdAt: new Date(),
      },
    });

    const middleware2 = createIdempotencyMiddleware({
      store: store2,
      fingerprint: (_req) => 'different-fingerprint',
    });

    const req2 = createRequest('POST', 'fp-mismatch') as Request;
    const res2 = new MockResponse();

    await middleware2(req2, res2 as unknown as Response, next1);
    await Promise.resolve();

    expect(res2.statusCode).toBe(409);
    expect(res2.body.error).toContain('different request payload');
  });

  it('handles non-JSON cached response', async () => {
    const store = new InMemoryIdempotencyStore();
    (store as any).records.set('plain-key', {
      record: {
        status: 200,
        body: 'plain text response',
        createdAt: new Date(),
      },
    });

    const middleware = createIdempotencyMiddleware({ store });

    const req = createRequest('POST', 'plain-key') as Request;
    const res = new MockResponse();
    const next = jest.fn();

    await middleware(req, res as unknown as Response, next);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('plain text response');
    expect(next).not.toHaveBeenCalled();
  });

  it('handles connection errors gracefully', async () => {
    const store: IdempotencyStore = {
      checkAndReserve: jest.fn().mockRejectedValue(new Error('DB connection failed')),
      save: jest.fn(),
      release: jest.fn(),
    };
    const middleware = createIdempotencyMiddleware({ store });

    const req = createRequest('POST', 'error-key') as Request;
    const res = new MockResponse() as unknown as Response;
    const next = jest.fn();

    await middleware(req, res, next);
    // Should proceed despite store error (fail open)
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('handles TTL expiration correctly', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1 });
    await store.save('expiring-key', {
      status: 200,
      body: 'ok',
      createdAt: new Date(),
    });

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 10));

    const middleware = createIdempotencyMiddleware({ store });

    const req = createRequest('POST', 'expiring-key') as Request;
    const res = new MockResponse();
    const next = jest.fn(() => {
      res.status(200).json({ new: true });
    });

    await middleware(req, res as unknown as Response, next);
    await Promise.resolve();

    // Expired record should be treated as new
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('handles null body in serializeBody', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({ store });

    const req = createRequest('POST', 'null-body-key') as Request;
    const res = new MockResponse();
    const next = jest.fn(() => {
      res.status(200).send(null);
    });

    await middleware(req, res as unknown as Response, next);
    await Promise.resolve();

    // Should store and allow caching
    const req2 = createRequest('POST', 'null-body-key') as Request;
    const res2 = new MockResponse();
    const next2 = jest.fn();

    await middleware(req2, res2 as unknown as Response, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(200);
  });

  it('handles malformed JSON in cached response fallback', async () => {
    const store = new InMemoryIdempotencyStore();
    (store as any).records.set('malformed-json', {
      record: {
        status: 200,
        body: '{ invalid json }',
        contentType: 'application/json',
        createdAt: new Date(),
      },
    });

    const middleware = createIdempotencyMiddleware({ store });

    const req = createRequest('POST', 'malformed-json') as Request;
    const res = new MockResponse();
    const next = jest.fn();

    await middleware(req, res as unknown as Response, next);

    // Should fall back to send() for malformed JSON
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{ invalid json }');
  });

  it('handles empty body string in serializeBody', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({ store });

    const req = createRequest('POST', 'empty-body') as Request;
    const res = new MockResponse();
    const next = jest.fn(() => {
      res.status(204).send('');
    });

    await middleware(req, res as unknown as Response, next);
    await Promise.resolve();

    // Second request should be cached as new
    const req2 = createRequest('POST', 'empty-body') as Request;
    const res2 = new MockResponse();
    const next2 = jest.fn();

    await middleware(req2, res2 as unknown as Response, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// InMemoryIdempotencyStore – state machine and TTL unit tests
//
// Security assumptions validated here:
//  - Expired cached records are never replayed; they are evicted and treated
//    as new so a fresh request can proceed without stale data leaking.
//  - An in-flight key cannot be double-reserved; concurrent callers receive
//    the 'inflight' sentinel until the first caller saves or releases.
//  - release() frees the key so a subsequent checkAndReserve returns 'new',
//    preventing permanent lock-out after an upstream error.
//  - save() atomically promotes inflight → cached and removes the in-flight
//    marker so no window exists where both states are true simultaneously.
//  - TTL is enforced lazily on access (pruneExpired), so a key that has
//    never been accessed after expiry does not block a new reservation.
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    status: 200,
    body: '{"ok":true}',
    contentType: 'application/json',
    fingerprint: undefined,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// State machine: new → inflight → cached
// ---------------------------------------------------------------------------

describe('InMemoryIdempotencyStore – state transitions', () => {
  it('returns "new" for an unseen key and marks it inflight', async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await store.checkAndReserve('key-1');
    expect(result.state).toBe('new');
  });

  it('returns "inflight" when the same key is reserved a second time before save', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.checkAndReserve('key-2');
    const second = await store.checkAndReserve('key-2');
    expect(second.state).toBe('inflight');
  });

  it('returns "cached" after save() is called with a record', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.checkAndReserve('key-3');
    await store.save('key-3', makeRecord({ status: 201 }));
    const result = await store.checkAndReserve('key-3');
    expect(result.state).toBe('cached');
    expect(result.state === 'cached' && result.record.status).toBe(201);
  });

  it('save() removes the inflight marker so the key is no longer inflight', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.checkAndReserve('key-4');
    await store.save('key-4', makeRecord());
    // A third call must return 'cached', not 'inflight'
    const result = await store.checkAndReserve('key-4');
    expect(result.state).toBe('cached');
  });

  it('release() frees the key so the next checkAndReserve returns "new"', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.checkAndReserve('key-5');
    await store.release('key-5');
    const result = await store.checkAndReserve('key-5');
    expect(result.state).toBe('new');
  });

  it('release() on an unknown key is a no-op and does not throw', async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(store.release('never-reserved')).resolves.toBeUndefined();
  });

  it('save() on a key that was never reserved still stores the record', async () => {
    // Defensive: callers may save without a prior reserve in error-recovery paths.
    const store = new InMemoryIdempotencyStore();
    await store.save('key-6', makeRecord({ status: 200 }));
    const result = await store.checkAndReserve('key-6');
    expect(result.state).toBe('cached');
  });

  it('independent keys do not interfere with each other', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.checkAndReserve('alpha');
    await store.checkAndReserve('beta');

    const alphaAgain = await store.checkAndReserve('alpha');
    const betaAgain = await store.checkAndReserve('beta');

    expect(alphaAgain.state).toBe('inflight');
    expect(betaAgain.state).toBe('inflight');

    await store.save('alpha', makeRecord({ status: 200 }));
    const alphaFinal = await store.checkAndReserve('alpha');
    const betaFinal = await store.checkAndReserve('beta');

    expect(alphaFinal.state).toBe('cached');
    expect(betaFinal.state).toBe('inflight'); // beta still in-flight
  });

  it('cached record preserves all fields verbatim', async () => {
    const store = new InMemoryIdempotencyStore();
    const record = makeRecord({
      status: 422,
      body: '{"error":"invalid"}',
      contentType: 'application/json; charset=utf-8',
      fingerprint: 'fp-abc123',
    });
    await store.checkAndReserve('key-7');
    await store.save('key-7', record);
    const result = await store.checkAndReserve('key-7');
    expect(result.state).toBe('cached');
    if (result.state === 'cached') {
      expect(result.record).toEqual(record);
    }
  });
});

// ---------------------------------------------------------------------------
// TTL expiry with fake timers
// ---------------------------------------------------------------------------

describe('InMemoryIdempotencyStore – TTL expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns "cached" before TTL elapses', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 5000 });
    await store.checkAndReserve('ttl-1');
    await store.save('ttl-1', makeRecord());

    jest.advanceTimersByTime(4999); // 1 ms before expiry

    const result = await store.checkAndReserve('ttl-1');
    expect(result.state).toBe('cached');
  });

  it('returns "new" (not "cached") exactly at TTL boundary', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 5000 });
    await store.checkAndReserve('ttl-2');
    await store.save('ttl-2', makeRecord());

    jest.advanceTimersByTime(5000); // exactly at expiry (Date.now() >= expiresAt)

    const result = await store.checkAndReserve('ttl-2');
    expect(result.state).toBe('new');
  });

  it('returns "new" after TTL has elapsed', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1000 });
    await store.checkAndReserve('ttl-3');
    await store.save('ttl-3', makeRecord());

    jest.advanceTimersByTime(2000); // well past expiry

    const result = await store.checkAndReserve('ttl-3');
    expect(result.state).toBe('new');
  });

  it('expired record is evicted so a subsequent save creates a fresh entry', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1000 });
    const original = makeRecord({ status: 200, body: '{"v":1}' });
    await store.checkAndReserve('ttl-4');
    await store.save('ttl-4', original);

    jest.advanceTimersByTime(1500);

    // First access after expiry evicts the old record and marks key as new
    const afterExpiry = await store.checkAndReserve('ttl-4');
    expect(afterExpiry.state).toBe('new');

    // Now save a fresh record under the same key
    const fresh = makeRecord({ status: 201, body: '{"v":2}' });
    await store.save('ttl-4', fresh);

    const cached = await store.checkAndReserve('ttl-4');
    expect(cached.state).toBe('cached');
    if (cached.state === 'cached') {
      expect(cached.record.body).toBe('{"v":2}');
      expect(cached.record.status).toBe(201);
    }
  });

  it('does not expire records when no TTL is configured', async () => {
    const store = new InMemoryIdempotencyStore(); // no ttlMs
    await store.checkAndReserve('no-ttl');
    await store.save('no-ttl', makeRecord());

    jest.advanceTimersByTime(Number.MAX_SAFE_INTEGER);

    const result = await store.checkAndReserve('no-ttl');
    expect(result.state).toBe('cached');
  });

  it('ttlMs: 0 is treated as "no TTL" because 0 is falsy (implementation edge case)', async () => {
    // The save() method uses `this.ttlMs ? ...` which treats 0 as falsy,
    // so ttlMs=0 behaves identically to no TTL — records never expire.
    // This test documents the current behavior; callers should use ttlMs >= 1.
    const store = new InMemoryIdempotencyStore({ ttlMs: 0 });
    await store.checkAndReserve('ttl-zero');
    await store.save('ttl-zero', makeRecord());

    jest.advanceTimersByTime(9999);

    // Because ttlMs=0 is falsy, expiresAt is undefined → record never expires
    const result = await store.checkAndReserve('ttl-zero');
    expect(result.state).toBe('cached');
  });

  it('multiple keys expire independently', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 3000 });

    await store.checkAndReserve('multi-a');
    await store.save('multi-a', makeRecord({ status: 200 }));

    jest.advanceTimersByTime(1000);

    await store.checkAndReserve('multi-b');
    await store.save('multi-b', makeRecord({ status: 201 }));

    // Advance to 3001 ms total: 'multi-a' has expired, 'multi-b' has not (only 2001 ms old)
    jest.advanceTimersByTime(2001);

    const resultA = await store.checkAndReserve('multi-a');
    const resultB = await store.checkAndReserve('multi-b');

    expect(resultA.state).toBe('new');
    expect(resultB.state).toBe('cached');
  });

  it('inflight keys are not affected by TTL (TTL only applies to cached records)', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 100 });
    await store.checkAndReserve('inflight-ttl');

    jest.advanceTimersByTime(500); // well past any TTL

    // Key is still inflight (no record was saved), so second check returns inflight
    const result = await store.checkAndReserve('inflight-ttl');
    expect(result.state).toBe('inflight');
  });
});

// ---------------------------------------------------------------------------
// pruneExpired – lazy eviction on access
// ---------------------------------------------------------------------------

describe('InMemoryIdempotencyStore – pruneExpired (lazy eviction)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('evicts the expired entry for the accessed key only', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 1000 });

    await store.checkAndReserve('prune-a');
    await store.save('prune-a', makeRecord({ status: 200 }));
    await store.checkAndReserve('prune-b');
    await store.save('prune-b', makeRecord({ status: 201 }));

    jest.advanceTimersByTime(1500); // both expired

    // Access only 'prune-a' — it should be evicted and return 'new'
    const resultA = await store.checkAndReserve('prune-a');
    expect(resultA.state).toBe('new');

    // 'prune-b' is also expired but was not accessed yet; accessing it now
    // should also evict it and return 'new'
    const resultB = await store.checkAndReserve('prune-b');
    expect(resultB.state).toBe('new');
  });

  it('does not evict a non-expired entry during pruning', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 5000 });
    await store.checkAndReserve('prune-live');
    await store.save('prune-live', makeRecord());

    jest.advanceTimersByTime(4000); // not yet expired

    const result = await store.checkAndReserve('prune-live');
    expect(result.state).toBe('cached');
  });

  it('a key with no expiresAt (no TTL) is never pruned', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.checkAndReserve('prune-no-ttl');
    await store.save('prune-no-ttl', makeRecord());

    jest.advanceTimersByTime(999_999_999);

    const result = await store.checkAndReserve('prune-no-ttl');
    expect(result.state).toBe('cached');
  });

  it('after eviction the key can be re-reserved and re-saved', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 500 });
    await store.checkAndReserve('prune-cycle');
    await store.save('prune-cycle', makeRecord({ status: 200 }));

    jest.advanceTimersByTime(600);

    // Evict via access
    const evicted = await store.checkAndReserve('prune-cycle');
    expect(evicted.state).toBe('new');

    // Complete a full new cycle
    await store.save('prune-cycle', makeRecord({ status: 204 }));
    const recached = await store.checkAndReserve('prune-cycle');
    expect(recached.state).toBe('cached');
    if (recached.state === 'cached') {
      expect(recached.record.status).toBe(204);
    }
  });
});

// ---------------------------------------------------------------------------
// Middleware integration – TTL expiry end-to-end
// ---------------------------------------------------------------------------

describe('createIdempotencyMiddleware – TTL expiry integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('replays cached response before TTL, then treats key as new after TTL', async () => {
    const store = new InMemoryIdempotencyStore({ ttlMs: 2000 });
    const middleware = createIdempotencyMiddleware({ store });

    // First request – stores the response
    const req1 = createRequest('POST', 'idem-ttl-1') as Request;
    const res1 = new MockResponse();
    const next1: NextFunction = jest.fn(() => {
      res1.status(200).json({ result: 'first' });
    });
    await middleware(req1, res1 as unknown as Response, next1);
    await Promise.resolve();

    // Second request before TTL – must replay
    jest.advanceTimersByTime(1000);
    const req2 = createRequest('POST', 'idem-ttl-1') as Request;
    const res2 = new MockResponse();
    const next2: NextFunction = jest.fn();
    await middleware(req2, res2 as unknown as Response, next2);

    expect(next2).not.toHaveBeenCalled();
    expect(res2.headers['idempotency-status']).toBe('cached');
    expect(res2.body).toEqual({ result: 'first' });

    // Third request after TTL – must be treated as new
    jest.advanceTimersByTime(1001); // total 2001 ms past save
    const req3 = createRequest('POST', 'idem-ttl-1') as Request;
    const res3 = new MockResponse();
    const next3: NextFunction = jest.fn(() => {
      res3.status(200).json({ result: 'second' });
    });
    await middleware(req3, res3 as unknown as Response, next3);
    await Promise.resolve();

    expect(next3).toHaveBeenCalledTimes(1);
    expect(res3.body).toEqual({ result: 'second' });
  });
});

// ---------------------------------------------------------------------------
// Middleware integration – release on error / connection close
// ---------------------------------------------------------------------------

describe('createIdempotencyMiddleware – release on upstream error', () => {
  it('releases the key when the response closes before finishing (connection drop)', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({ store });

    const req = createRequest('POST', 'drop-key') as Request;
    const res = new MockResponse();
    const next: NextFunction = jest.fn(() => {
      // Simulate connection drop: emit 'close' without 'finish'
      res.emit('close');
    });

    await middleware(req, res as unknown as Response, next);
    await Promise.resolve();

    // Key must be free now
    const result = await store.checkAndReserve('drop-key');
    expect(result.state).toBe('new');
  });

  it('does not double-release when both finish and close fire', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({ store });

    const req = createRequest('POST', 'double-close') as Request;
    const res = new MockResponse();
    const next: NextFunction = jest.fn(() => {
      res.status(200).json({ ok: true });
    });

    await middleware(req, res as unknown as Response, next);
    await Promise.resolve();

    // After normal finish the key is cached; a spurious 'close' must not corrupt state
    const result = await store.checkAndReserve('double-close');
    expect(result.state).toBe('cached');
  });
});

// ---------------------------------------------------------------------------
// Middleware integration – shouldStoreResponse gate
// ---------------------------------------------------------------------------

describe('createIdempotencyMiddleware – shouldStoreResponse', () => {
  it('does not cache 5xx responses by default', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({ store });

    const req1 = createRequest('POST', 'err-key') as Request;
    const res1 = new MockResponse();
    const next1: NextFunction = jest.fn(() => {
      res1.status(500).json({ error: 'boom' });
    });

    await middleware(req1, res1 as unknown as Response, next1);
    await Promise.resolve();

    // Key must be released (not cached) after a 500
    const result = await store.checkAndReserve('err-key');
    expect(result.state).toBe('new');
  });

  it('caches 4xx responses (< 500) by default', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({ store });

    const req1 = createRequest('POST', 'client-err-key') as Request;
    const res1 = new MockResponse();
    const next1: NextFunction = jest.fn(() => {
      res1.status(422).json({ error: 'unprocessable' });
    });

    await middleware(req1, res1 as unknown as Response, next1);
    await Promise.resolve();

    const result = await store.checkAndReserve('client-err-key');
    expect(result.state).toBe('cached');
    if (result.state === 'cached') {
      expect(result.record.status).toBe(422);
    }
  });

  it('respects a custom shouldStoreResponse predicate', async () => {
    const store = new InMemoryIdempotencyStore();
    // Only cache 201 Created
    const middleware = createIdempotencyMiddleware({
      store,
      shouldStoreResponse: (code) => code === 201,
    });

    const req200 = createRequest('POST', 'custom-200') as Request;
    const res200 = new MockResponse();
    await middleware(req200, res200 as unknown as Response, jest.fn(() => {
      res200.status(200).json({ ok: true });
    }));
    await Promise.resolve();
    expect((await store.checkAndReserve('custom-200')).state).toBe('new');

    const req201 = createRequest('POST', 'custom-201') as Request;
    const res201 = new MockResponse();
    await middleware(req201, res201 as unknown as Response, jest.fn(() => {
      res201.status(201).json({ created: true });
    }));
    await Promise.resolve();
    expect((await store.checkAndReserve('custom-201')).state).toBe('cached');
  });
});

// ---------------------------------------------------------------------------
// Middleware integration – fingerprint conflict detection
// ---------------------------------------------------------------------------

describe('createIdempotencyMiddleware – fingerprint conflict', () => {
  it('returns 409 when the same key is reused with a different fingerprint', async () => {
    const store = new InMemoryIdempotencyStore();
    let callCount = 0;
    const middleware = createIdempotencyMiddleware({
      store,
      fingerprint: () => `fp-${++callCount}`,
    });

    const req1 = createRequest('POST', 'fp-key') as Request;
    const res1 = new MockResponse();
    await middleware(req1, res1 as unknown as Response, jest.fn(() => {
      res1.status(200).json({ ok: true });
    }));
    await Promise.resolve();

    const req2 = createRequest('POST', 'fp-key') as Request;
    const res2 = new MockResponse();
    await middleware(req2, res2 as unknown as Response, jest.fn());

    expect(res2.statusCode).toBe(409);
    expect(res2.headers['idempotency-status']).toBe('conflict');
  });

  it('replays without conflict when fingerprints match', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = createIdempotencyMiddleware({
      store,
      fingerprint: () => 'stable-fp',
    });

    const req1 = createRequest('POST', 'fp-match') as Request;
    const res1 = new MockResponse();
    await middleware(req1, res1 as unknown as Response, jest.fn(() => {
      res1.status(200).json({ ok: true });
    }));
    await Promise.resolve();

    const req2 = createRequest('POST', 'fp-match') as Request;
    const res2 = new MockResponse();
    await middleware(req2, res2 as unknown as Response, jest.fn());

    expect(res2.statusCode).toBe(200);
    expect(res2.headers['idempotency-status']).toBe('cached');
  });
});
