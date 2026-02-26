import { EventEmitter } from 'events';
import { NextFunction, Request, Response } from 'express';
import {
  createIdempotencyMiddleware,
  InMemoryIdempotencyStore,
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
