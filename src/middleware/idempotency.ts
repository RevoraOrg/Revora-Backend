import { NextFunction, Request, RequestHandler, Response } from 'express';

export interface IdempotencyRecord {
  status: number;
  body: string;
  contentType?: string;
  createdAt: Date;
}

export type IdempotencyCheckResult =
  | { state: 'new' }
  | { state: 'inflight' }
  | { state: 'cached'; record: IdempotencyRecord };

export interface IdempotencyStore {
  checkAndReserve(key: string): Promise<IdempotencyCheckResult>;
  save(key: string, record: IdempotencyRecord): Promise<void>;
  release(key: string): Promise<void>;
}

export interface InMemoryIdempotencyStoreOptions {
  ttlMs?: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<
    string,
    { record: IdempotencyRecord; expiresAt?: number }
  >();
  private readonly inFlight = new Set<string>();
  private readonly ttlMs?: number;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs;
  }

  async checkAndReserve(key: string): Promise<IdempotencyCheckResult> {
    this.pruneExpired(key);

    const cached = this.records.get(key);
    if (cached) {
      return { state: 'cached', record: cached.record };
    }

    if (this.inFlight.has(key)) {
      return { state: 'inflight' };
    }

    this.inFlight.add(key);
    return { state: 'new' };
  }

  async save(key: string, record: IdempotencyRecord): Promise<void> {
    this.inFlight.delete(key);
    const expiresAt = this.ttlMs ? Date.now() + this.ttlMs : undefined;
    this.records.set(key, { record, expiresAt });
  }

  async release(key: string): Promise<void> {
    this.inFlight.delete(key);
  }

  private pruneExpired(key: string): void {
    const entry = this.records.get(key);
    if (!entry?.expiresAt) {
      return;
    }
    if (Date.now() >= entry.expiresAt) {
      this.records.delete(key);
    }
  }
}

export interface IdempotencyMiddlewareOptions {
  store?: IdempotencyStore;
  headerName?: string;
  methods?: string[];
  shouldStoreResponse?: (statusCode: number) => boolean;
}

const DEFAULT_METHODS = ['POST', 'PATCH'];
const DEFAULT_HEADER = 'idempotency-key';

function toHeaderString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return String(value[0]);
  }
  return undefined;
}

function serializeBody(payload: unknown): string {
  if (Buffer.isBuffer(payload)) {
    return payload.toString('utf-8');
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload === undefined) {
    return '';
  }
  return JSON.stringify(payload);
}

function replayResponse(res: Response, record: IdempotencyRecord): void {
  res.setHeader('Idempotency-Status', 'cached');

  if (record.contentType) {
    res.setHeader('Content-Type', record.contentType);
  }

  const contentType = (record.contentType ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      const parsed = record.body === '' ? null : JSON.parse(record.body);
      res.status(record.status).json(parsed);
      return;
    } catch {
      // Fall back to raw body if cached body is not parseable JSON.
    }
  }

  res.status(record.status).send(record.body);
}

export function createIdempotencyMiddleware(
  options: IdempotencyMiddlewareOptions = {}
): RequestHandler {
  const store = options.store ?? new InMemoryIdempotencyStore();
  const headerName = (options.headerName ?? DEFAULT_HEADER).toLowerCase();
  const methods = new Set(
    (options.methods ?? DEFAULT_METHODS).map((method) => method.toUpperCase())
  );
  const shouldStoreResponse =
    options.shouldStoreResponse ?? ((statusCode: number) => statusCode < 500);

  return async (req: Request, res: Response, next: NextFunction) => {
    if (!methods.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const key = req.header(headerName)?.trim();
    if (!key) {
      next();
      return;
    }

    const checkResult = await store.checkAndReserve(key);
    if (checkResult.state === 'cached') {
      replayResponse(res, checkResult.record);
      return;
    }

    if (checkResult.state === 'inflight') {
      res.setHeader('Idempotency-Status', 'inflight');
      res.status(409).json({
        error: 'Request with this idempotency key is already in progress.',
      });
      return;
    }

    let responseBody = '';
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    res.json = ((payload?: unknown) => {
      responseBody = JSON.stringify(payload ?? null);
      return originalJson(payload);
    }) as Response['json'];

    res.send = ((payload?: unknown) => {
      responseBody = serializeBody(payload);
      return originalSend(payload as Parameters<Response['send']>[0]);
    }) as Response['send'];

    let completed = false;
    res.once('finish', () => {
      completed = true;
      if (!shouldStoreResponse(res.statusCode)) {
        void store.release(key);
        return;
      }

      const contentType = toHeaderString(res.getHeader('content-type'));
      const record: IdempotencyRecord = {
        status: res.statusCode,
        body: responseBody,
        contentType,
        createdAt: new Date(),
      };
      void store.save(key, record);
    });

    res.once('close', () => {
      if (!completed) {
        void store.release(key);
      }
    });

    next();
  };
}
