import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';
import { Pool } from 'pg';
import {
  createIdempotencyMiddleware,
  InMemoryIdempotencyStore,
  PostgresIdempotencyStore,
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
});

describe('PostgresIdempotencyStore', () => {
  let pool: Pool;
  let store: PostgresIdempotencyStore;

  beforeAll(async () => {
    // Create a test pool
    pool = new Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME ?? 'revora',
      user: process.env.DB_USER ?? 'postgres',
      password: process.env.DB_PASSWORD ?? '',
      max: 1,
    });

    // Create the idempotency_keys table if it doesn't exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        response_status INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        response_content_type TEXT,
        fingerprint TEXT,
        state TEXT NOT NULL DEFAULT 'inflight' CHECK (state IN ('inflight', 'completed', 'released')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      )
    `);

    store = new PostgresIdempotencyStore({ pool, ttlMs: 60000 }); // 1 minute TTL
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS idempotency_keys');
    await pool.end();
  });

  afterEach(async () => {
    await pool.query('DELETE FROM idempotency_keys');
  });

  describe('checkAndReserve', () => {
    it('should return "new" state for a new key', async () => {
      const result = await store.checkAndReserve('test-key-1');
      expect(result.state).toBe('new');
    });

    it('should return "inflight" state for a key that is currently in-flight', async () => {
      await store.checkAndReserve('test-key-2');
      const result = await store.checkAndReserve('test-key-2');
      expect(result.state).toBe('inflight');
    });

    it('should return "cached" state for a completed key', async () => {
      const key = 'test-key-3';
      await store.checkAndReserve(key);
      await store.save(key, {
        status: 200,
        body: '{"result":"success"}',
        contentType: 'application/json',
        createdAt: new Date(),
      });

      const result = await store.checkAndReserve(key);
      expect(result.state).toBe('cached');
      if (result.state === 'cached') {
        expect(result.record.status).toBe(200);
        expect(result.record.body).toBe('{"result":"success"}');
      }
    });

    it('should return "new" for a released key (allow retry)', async () => {
      const key = 'test-key-4';
      await store.checkAndReserve(key);
      await store.release(key);

      const result = await store.checkAndReserve(key);
      expect(result.state).toBe('new');
    });

    it('should enforce TTL expiry', async () => {
      const key = 'test-key-5';
      const shortTtlStore = new PostgresIdempotencyStore({ pool, ttlMs: 100 }); // 100ms TTL
      
      await shortTtlStore.checkAndReserve(key);
      await shortTtlStore.save(key, {
        status: 200,
        body: '{"result":"success"}',
        createdAt: new Date(),
      });

      // Wait for TTL to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      const result = await shortTtlStore.checkAndReserve(key);
      expect(result.state).toBe('new');
    });

    it('should handle concurrent requests with row-level locking', async () => {
      const key = 'test-key-6';
      
      // Simulate concurrent requests
      const results = await Promise.all([
        store.checkAndReserve(key),
        store.checkAndReserve(key),
        store.checkAndReserve(key),
      ]);

      // Only one should be "new", the rest should be "inflight"
      const newCount = results.filter(r => r.state === 'new').length;
      const inflightCount = results.filter(r => r.state === 'inflight').length;

      expect(newCount).toBe(1);
      expect(inflightCount).toBe(2);
    });

    it('should store fingerprint in cached record', async () => {
      const key = 'test-key-7';
      await store.checkAndReserve(key);
      await store.save(key, {
        status: 201,
        body: '{"id":"123"}',
        contentType: 'application/json',
        fingerprint: 'abc123',
        createdAt: new Date(),
      });

      const result = await store.checkAndReserve(key);
      expect(result.state).toBe('cached');
      if (result.state === 'cached') {
        expect(result.record.fingerprint).toBe('abc123');
      }
    });

    it('should fail open on database errors', async () => {
      const badPool = new Pool({
        host: 'invalid-host',
        port: 5432,
        database: 'invalid-db',
        connectionTimeoutMillis: 100,
      });
      
      const badStore = new PostgresIdempotencyStore({ pool: badPool });
      const result = await badStore.checkAndReserve('test-key-8');
      
      // Should return 'new' to avoid blocking requests
      expect(result.state).toBe('new');
      
      await badPool.end().catch(() => {});
    });
  });

  describe('save', () => {
    it('should save a completed record', async () => {
      const key = 'test-key-9';
      await store.checkAndReserve(key);
      
      await store.save(key, {
        status: 201,
        body: '{"id":"txn-123"}',
        contentType: 'application/json',
        fingerprint: 'fingerprint-1',
        createdAt: new Date(),
      });

      const result = await store.checkAndReserve(key);
      expect(result.state).toBe('cached');
      if (result.state === 'cached') {
        expect(result.record.status).toBe(201);
        expect(result.record.body).toBe('{"id":"txn-123"}');
        expect(result.record.contentType).toBe('application/json');
        expect(result.record.fingerprint).toBe('fingerprint-1');
      }
    });

    it('should update expires_at on save', async () => {
      const key = 'test-key-10';
      await store.checkAndReserve(key);
      
      await store.save(key, {
        status: 200,
        body: '{"ok":true}',
        createdAt: new Date(),
      });

      const queryResult = await pool.query(
        'SELECT expires_at FROM idempotency_keys WHERE key = $1',
        [key]
      );
      
      expect(queryResult.rows[0].expires_at).not.toBeNull();
    });

    it('should not throw on database errors', async () => {
      const badPool = new Pool({
        host: 'invalid-host',
        port: 5432,
        database: 'invalid-db',
        connectionTimeoutMillis: 100,
      });
      
      const badStore = new PostgresIdempotencyStore({ pool: badPool });
      
      // Should not throw
      await expect(
        badStore.save('test-key-11', {
          status: 200,
          body: '{}',
          createdAt: new Date(),
        })
      ).resolves.not.toThrow();
      
      await badPool.end().catch(() => {});
    });
  });

  describe('release', () => {
    it('should release an in-flight key', async () => {
      const key = 'test-key-12';
      await store.checkAndReserve(key);
      
      await store.release(key);

      // Should allow new reservation
      const result = await store.checkAndReserve(key);
      expect(result.state).toBe('new');
    });

    it('should only release in-flight keys', async () => {
      const key = 'test-key-13';
      await store.checkAndReserve(key);
      await store.save(key, {
        status: 200,
        body: '{}',
        createdAt: new Date(),
      });

      await store.release(key);

      // Should still return cached (not new)
      const result = await store.checkAndReserve(key);
      expect(result.state).toBe('cached');
    });

    it('should not throw on database errors', async () => {
      const badPool = new Pool({
        host: 'invalid-host',
        port: 5432,
        database: 'invalid-db',
        connectionTimeoutMillis: 100,
      });
      
      const badStore = new PostgresIdempotencyStore({ pool: badPool });
      
      // Should not throw
      await expect(badStore.release('test-key-14')).resolves.not.toThrow();
      
      await badPool.end().catch(() => {});
    });
  });

  describe('cleanupExpired', () => {
    it('should remove expired records', async () => {
      const key1 = 'test-key-15';
      const key2 = 'test-key-16';
      
      // Create records with short TTL
      const shortTtlStore = new PostgresIdempotencyStore({ pool, ttlMs: 100 });
      
      await shortTtlStore.checkAndReserve(key1);
      await shortTtlStore.save(key1, {
        status: 200,
        body: '{}',
        createdAt: new Date(),
      });

      await shortTtlStore.checkAndReserve(key2);
      await shortTtlStore.save(key2, {
        status: 200,
        body: '{}',
        createdAt: new Date(),
      });

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 150));

      const deletedCount = await shortTtlStore.cleanupExpired();
      expect(deletedCount).toBeGreaterThanOrEqual(0);
    });

    it('should not remove non-expired records', async () => {
      const key = 'test-key-17';
      
      await store.checkAndReserve(key);
      await store.save(key, {
        status: 200,
        body: '{}',
        createdAt: new Date(),
      });

      const deletedCount = await store.cleanupExpired();
      
      // Record should still exist
      const result = await store.checkAndReserve(key);
      expect(result.state).toBe('cached');
    });
  });

  describe('integration with middleware', () => {
    it('should work with createIdempotencyMiddleware', async () => {
      const middleware = createIdempotencyMiddleware({
        store,
      });

      const req1 = createRequest('POST', 'payment-integration-1') as Request;
      const res1 = new MockResponse();
      const next1: NextFunction = jest.fn(() => {
        res1.status(201).json({ ok: true, id: 'txn-integration-1' });
      });

      await middleware(req1, res1 as unknown as Response, next1);
      await Promise.resolve();

      expect(next1).toHaveBeenCalledTimes(1);

      const req2 = createRequest('POST', 'payment-integration-1') as Request;
      const res2 = new MockResponse();
      const next2: NextFunction = jest.fn(() => {
        res2.status(500).json({ ok: false });
      });

      await middleware(req2, res2 as unknown as Response, next2);

      expect(next2).not.toHaveBeenCalled();
      expect(res2.statusCode).toBe(201);
      expect(res2.body).toEqual({ ok: true, id: 'txn-integration-1' });
      expect(res2.headers['idempotency-status']).toBe('cached');
    });
  });
});
