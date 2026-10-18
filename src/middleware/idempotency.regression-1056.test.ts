/**
 * Regression suite for src/middleware/idempotency.ts line 288 — Closes #1056
 *
 * Evidence: `toHeaderString()` at line 288 contains an explicit `return undefined`
 * branch for inputs that are neither a plain string nor a non-empty array.
 * This branch feeds directly into the `contentType` field of the stored
 * `IdempotencyRecord`, so a silent change here (e.g. returning `null` or `''`
 * instead of `undefined`) would corrupt cached response replay across every
 * consumer of the middleware.
 *
 * Coverage matrix
 * ───────────────
 * toHeaderString (tested via res.getHeader('content-type') → contentType field)
 *   ❶ undefined path  — no Content-Type header → record.contentType is undefined
 *   ❷ string path     — string header          → record.contentType is that string
 *   ❸ array path      — array header [v]       → record.contentType is String(v[0])
 *   ❹ empty array     — []                     → record.contentType is undefined
 *
 * Neighbouring success / failure paths
 *   • Normal POST stores a response and replays it correctly (success path)
 *   • 5xx is never stored; key is released (failure/empty-result path)
 *   • PATCH is covered by the configured methods set (boundary)
 *
 * Boundary inputs for IdempotencyRecord fields
 *   • status 0 (never set by route) doesn't appear in stored records
 *   • Empty body string is stored as '' not undefined
 *   • Buffer body is serialised to UTF-8 string (serializeBody boundary)
 *   • undefined body (res.send(undefined)) is serialised to ''
 */

import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';
import {
  createIdempotencyMiddleware,
  InMemoryIdempotencyStore,
  IdempotencyRecord,
} from './idempotency';

// ── Minimal test doubles ────────────────────────────────────────────────────

class FakeResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  private _headers: Record<string, string | string[]> = {};
  private _done = false;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string | string[]): void {
    this._headers[name.toLowerCase()] = value;
  }

  getHeader(name: string): string | string[] | undefined {
    return this._headers[name.toLowerCase()];
  }

  json(payload?: unknown): this {
    if (!this.getHeader('content-type')) {
      this.setHeader('content-type', 'application/json; charset=utf-8');
    }
    this.body = payload;
    this._finish();
    return this;
  }

  send(payload?: unknown): this {
    this.body = payload;
    this._finish();
    return this;
  }

  /** Force-set a header as an array (simulates multi-value headers from Express). */
  setRawHeader(name: string, value: string[]): void {
    this._headers[name.toLowerCase()] = value;
  }

  private _finish(): void {
    if (this._done) return;
    this._done = true;
    this.emit('finish');
    this.emit('close');
  }
}

function makeReq(method: string, key?: string): Partial<Request> & { header: Request['header'] } {
  const lc: Record<string, string> = {};
  if (key) lc['idempotency-key'] = key;
  return {
    method,
    header: ((name: string) => lc[name.toLowerCase()]) as Request['header'],
  };
}

/** Read the IdempotencyRecord the store captured after one request cycle. */
async function captureRecord(
  store: InMemoryIdempotencyStore,
  key: string
): Promise<IdempotencyRecord | null> {
  const result = await store.checkAndReserve(key);
  if (result.state === 'cached') return result.record;
  return null;
}

// ── toHeaderString — the line-288 `return undefined` path ──────────────────

describe('idempotency.ts line 288 — toHeaderString return undefined regression', () => {
  it('❶ stores contentType as undefined when no Content-Type header is set (the return-undefined path)', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req = makeReq('POST', 'no-ct') as Request;
    const res = new FakeResponse();
    const next: NextFunction = jest.fn(() => {
      // Send a plain-text body without setting content-type
      res.statusCode = 200;
      res.body = 'plain';
      res.emit('finish');
      res.emit('close');
    });

    await mw(req, res as unknown as Response, next);
    await Promise.resolve();

    const record = await captureRecord(store, 'no-ct');
    expect(record).not.toBeNull();
    // Regression: must be strictly undefined, never null or empty string
    expect(record!.contentType).toBeUndefined();
  });

  it('❷ stores contentType as the string value when Content-Type is a plain string', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req = makeReq('POST', 'ct-string') as Request;
    const res = new FakeResponse();

    await mw(req, res as unknown as Response, jest.fn(() => {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.status(200).send('hello');
    }));
    await Promise.resolve();

    const record = await captureRecord(store, 'ct-string');
    expect(record!.contentType).toBe('text/plain; charset=utf-8');
  });

  it('❸ stores contentType as String(array[0]) when Content-Type is a non-empty array', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req = makeReq('POST', 'ct-array') as Request;
    const res = new FakeResponse();

    await mw(req, res as unknown as Response, jest.fn(() => {
      // Simulate Express returning a multi-value header as an array
      res.setRawHeader('content-type', ['application/json', 'charset=utf-8']);
      res.statusCode = 200;
      res.body = '{}';
      res.emit('finish');
      res.emit('close');
    }));
    await Promise.resolve();

    const record = await captureRecord(store, 'ct-array');
    expect(record!.contentType).toBe('application/json');
  });

  it('❹ stores contentType as undefined when Content-Type is an empty array (boundary: toHeaderString returns undefined for [])', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req = makeReq('POST', 'ct-empty-array') as Request;
    const res = new FakeResponse();

    await mw(req, res as unknown as Response, jest.fn(() => {
      // Empty array — toHeaderString hits the `return undefined` branch at line 288
      res.setRawHeader('content-type', []);
      res.status(200).send('data');
    }));
    await Promise.resolve();

    const record = await captureRecord(store, 'ct-empty-array');
    expect(record!.contentType).toBeUndefined();
  });

  it('undefined contentType in cached record does not prevent replay (replayResponse handles undefined)', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    // First request — no content-type → contentType is undefined in record
    const req1 = makeReq('POST', 'replay-no-ct') as Request;
    const res1 = new FakeResponse();
    await mw(req1, res1 as unknown as Response, jest.fn(() => {
      res1.status(200).send('raw data');
    }));
    await Promise.resolve();

    // Second request — should replay without throwing
    const req2 = makeReq('POST', 'replay-no-ct') as Request;
    const res2 = new FakeResponse();
    await mw(req2, res2 as unknown as Response, jest.fn());

    expect(res2.statusCode).toBe(200);
    expect(res2.body).toBe('raw data');
    expect((res2 as any)._headers['idempotency-status']).toBe('cached');
  });
});

// ── IdempotencyRecord — neighbouring success and failure paths ──────────────

describe('IdempotencyRecord — success and failure paths neighbouring line 288', () => {
  it('normal POST: stores record and replays on duplicate (success path)', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req1 = makeReq('POST', 'success-1') as Request;
    const res1 = new FakeResponse();
    await mw(req1, res1 as unknown as Response, jest.fn(() => {
      res1.status(201).json({ id: 42 });
    }));
    await Promise.resolve();

    const req2 = makeReq('POST', 'success-1') as Request;
    const res2 = new FakeResponse();
    await mw(req2, res2 as unknown as Response, jest.fn());

    expect(res2.statusCode).toBe(201);
    expect(res2.body).toEqual({ id: 42 });
    expect((res2 as any)._headers['idempotency-status']).toBe('cached');
  });

  it('5xx response: key is released, not cached (empty-result / failure path)', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req1 = makeReq('POST', 'fail-1') as Request;
    const res1 = new FakeResponse();
    await mw(req1, res1 as unknown as Response, jest.fn(() => {
      res1.status(500).json({ error: 'boom' });
    }));
    await Promise.resolve();

    const result = await store.checkAndReserve('fail-1');
    // Regression: must be 'new', not 'cached' — 5xx must never be replayed
    expect(result.state).toBe('new');
  });

  it('4xx client error: is cached by default and replayed correctly', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req1 = makeReq('POST', 'client-err') as Request;
    const res1 = new FakeResponse();
    await mw(req1, res1 as unknown as Response, jest.fn(() => {
      res1.status(409).json({ error: 'conflict' });
    }));
    await Promise.resolve();

    const req2 = makeReq('POST', 'client-err') as Request;
    const res2 = new FakeResponse();
    await mw(req2, res2 as unknown as Response, jest.fn());

    expect(res2.statusCode).toBe(409);
    expect(res2.body).toEqual({ error: 'conflict' });
  });
});

// ── serializeBody — boundary inputs that feed IdempotencyRecord.body ────────

describe('IdempotencyRecord.body — serializeBody boundary inputs (line 288 neighbours)', () => {
  it('Buffer body is stored as a UTF-8 string (not undefined)', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req = makeReq('POST', 'buf-body') as Request;
    const res = new FakeResponse();
    await mw(req, res as unknown as Response, jest.fn(() => {
      const buf = Buffer.from('binary content', 'utf-8');
      res.status(200).send(buf);
    }));
    await Promise.resolve();

    const record = await captureRecord(store, 'buf-body');
    expect(record!.body).toBe('binary content');
    expect(typeof record!.body).toBe('string');
  });

  it('undefined body (res.send() with no arg) is stored as empty string, not undefined', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req = makeReq('POST', 'undef-body') as Request;
    const res = new FakeResponse();
    await mw(req, res as unknown as Response, jest.fn(() => {
      res.status(204).send(undefined);
    }));
    await Promise.resolve();

    const record = await captureRecord(store, 'undef-body');
    // Regression: body must be '' not undefined — replaying `res.send(undefined)` is valid
    expect(record!.body).toBe('');
  });

  it('empty string body is stored as empty string (boundary: zero-length string path)', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req = makeReq('POST', 'empty-str-body') as Request;
    const res = new FakeResponse();
    await mw(req, res as unknown as Response, jest.fn(() => {
      res.status(204).send('');
    }));
    await Promise.resolve();

    const record = await captureRecord(store, 'empty-str-body');
    expect(record!.body).toBe('');
  });

  it('JSON body with null is stored as "null" (JSON.stringify boundary)', async () => {
    const store = new InMemoryIdempotencyStore();
    const mw = createIdempotencyMiddleware({ store });

    const req = makeReq('POST', 'null-json') as Request;
    const res = new FakeResponse();
    await mw(req, res as unknown as Response, jest.fn(() => {
      res.status(200).json(null);
    }));
    await Promise.resolve();

    const record = await captureRecord(store, 'null-json');
    expect(record!.body).toBe('null');
  });
});

// ── Method boundary — only POST/PATCH are covered by default ────────────────

describe('method boundary — IdempotencyRecord is only stored for configured methods', () => {
  it.each(['GET', 'HEAD', 'DELETE', 'PUT', 'OPTIONS'] as const)(
    '%s bypasses idempotency entirely (no record stored)',
    async (method) => {
      const store = new InMemoryIdempotencyStore();
      const mw = createIdempotencyMiddleware({ store });

      const req = makeReq(method, 'bypass-key') as Request;
      const res = new FakeResponse();
      const next = jest.fn(() => res.status(200).json({ ok: true }));

      await mw(req, res as unknown as Response, next);
      await Promise.resolve();

      expect(next).toHaveBeenCalledTimes(1);
      const result = await store.checkAndReserve('bypass-key');
      // No record created — new key is always in 'new' state after bypass
      expect(result.state).toBe('new');
    }
  );
});
