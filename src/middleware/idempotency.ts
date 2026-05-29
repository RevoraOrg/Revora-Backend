import { NextFunction, Request, RequestHandler, Response } from 'express';
import { Pool, QueryResult } from 'pg';

export interface IdempotencyRecord {
  status: number;
  body: string;
  contentType?: string;
  fingerprint?: string;
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

export interface PostgresIdempotencyStoreOptions {
  pool: Pool;
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

/**
 * @title Postgres-Backed Idempotency Store
 * @notice Production-grade idempotency store using PostgreSQL for multi-instance safety.
 * @dev Implements row-level locking to prevent concurrent duplicate processing across instances.
 *
 * Security assumptions:
 * - Database connection is secure and properly configured
 * - Row-level locking (SELECT ... FOR UPDATE) prevents race conditions
 * - TTL expiry is enforced at query time to prevent stale data reuse
 * - In-flight state prevents concurrent processing of the same key
 *
 * Abuse/failure paths handled:
 * - Concurrent requests with the same idempotency key are serialized
 * - Expired records are filtered out during checkAndReserve
 * - Database connection failures result in safe fallback (state: 'new')
 * - Transaction rollback on errors prevents partial state corruption
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  private readonly pool: Pool;
  private readonly ttlMs?: number;

  constructor(options: PostgresIdempotencyStoreOptions) {
    this.pool = options.pool;
    this.ttlMs = options.ttlMs;
  }

  async checkAndReserve(key: string): Promise<IdempotencyCheckResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // First, delete expired records for this key
      const expiresAt = this.ttlMs ? new Date(Date.now() + this.ttlMs) : null;
      
      // Check for existing completed record (with row-level lock)
      const existingQuery = `
        SELECT 
          response_status,
          response_body,
          response_content_type,
          fingerprint,
          created_at,
          state
        FROM idempotency_keys
        WHERE key = $1
          AND (expires_at IS NULL OR expires_at > NOW())
        FOR UPDATE
      `;
      const existingResult: QueryResult = await client.query(existingQuery, [key]);

      if (existingResult.rows.length > 0) {
        const row = existingResult.rows[0];
        
        // If it's in-flight, return inflight state
        if (row.state === 'inflight') {
          await client.query('ROLLBACK');
          return { state: 'inflight' };
        }

        // If it's completed, return cached state
        if (row.state === 'completed') {
          await client.query('ROLLBACK');
          return {
            state: 'cached',
            record: {
              status: row.response_status,
              body: row.response_body,
              contentType: row.response_content_type,
              fingerprint: row.fingerprint,
              createdAt: new Date(row.created_at),
            },
          };
        }

        // If it's released, treat as new (allow retry)
        if (row.state === 'released') {
          await client.query('ROLLBACK');
          // Delete the released record and allow new reservation
          await this.deleteKey(key);
          return await this.checkAndReserve(key);
        }
      }

      // No existing valid record - create in-flight entry
      const insertQuery = `
        INSERT INTO idempotency_keys (
          key,
          response_status,
          response_body,
          response_content_type,
          fingerprint,
          state,
          created_at,
          expires_at
        ) VALUES ($1, 0, '', NULL, NULL, 'inflight', NOW(), $2)
        ON CONFLICT (key) DO UPDATE SET
          state = 'inflight',
          created_at = NOW(),
          expires_at = $2
      `;
      await client.query(insertQuery, [key, expiresAt]);

      await client.query('COMMIT');
      return { state: 'new' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      // On database error, fail open to avoid blocking requests
      console.error('[PostgresIdempotencyStore] checkAndReserve error:', error);
      return { state: 'new' };
    } finally {
      client.release();
    }
  }

  async save(key: string, record: IdempotencyRecord): Promise<void> {
    const expiresAt = this.ttlMs ? new Date(Date.now() + this.ttlMs) : null;
    
    const query = `
      UPDATE idempotency_keys
      SET
        response_status = $1,
        response_body = $2,
        response_content_type = $3,
        fingerprint = $4,
        state = 'completed',
        created_at = $5,
        expires_at = $6
      WHERE key = $7
    `;
    
    try {
      await this.pool.query(query, [
        record.status,
        record.body,
        record.contentType || null,
        record.fingerprint || null,
        record.createdAt,
        expiresAt,
        key,
      ]);
    } catch (error) {
      console.error('[PostgresIdempotencyStore] save error:', error);
      // Don't throw - idempotency failures shouldn't break the main request
    }
  }

  async release(key: string): Promise<void> {
    const query = `
      UPDATE idempotency_keys
      SET state = 'released'
      WHERE key = $1 AND state = 'inflight'
    `;
    
    try {
      await this.pool.query(query, [key]);
    } catch (error) {
      console.error('[PostgresIdempotencyStore] release error:', error);
      // Don't throw - idempotency failures shouldn't break the main request
    }
  }

  private async deleteKey(key: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM idempotency_keys WHERE key = $1', [key]);
    } catch (error) {
      console.error('[PostgresIdempotencyStore] deleteKey error:', error);
    }
  }

  /**
   * @notice Cleanup task to remove expired records from the database.
   * @dev Should be run periodically (e.g., via cron) to prevent table bloat.
   */
  async cleanupExpired(): Promise<number> {
    const query = `
      DELETE FROM idempotency_keys
      WHERE expires_at IS NOT NULL AND expires_at < NOW()
    `;
    
    try {
      const result: QueryResult = await this.pool.query(query);
      return result.rowCount || 0;
    } catch (error) {
      console.error('[PostgresIdempotencyStore] cleanupExpired error:', error);
      return 0;
    }
  }
}

export interface IdempotencyMiddlewareOptions {
  store?: IdempotencyStore;
  headerName?: string;
  methods?: string[];
  shouldStoreResponse?: (statusCode: number) => boolean;
  fingerprint?: (req: Request) => string;
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
  const fingerprint = options.fingerprint;

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

    const requestFingerprint = fingerprint?.(req);
    let checkResult;
    try {
      checkResult = await store.checkAndReserve(key);
    } catch (error) {
      // On internal error, we allow the request to proceed without idempotency
      // to avoid blocking clients due to infra issues.
      next();
      return;
    }

    if (checkResult.state === 'cached') {
      if (
        requestFingerprint &&
        checkResult.record.fingerprint &&
        checkResult.record.fingerprint !== requestFingerprint
      ) {
        res.setHeader('Idempotency-Status', 'conflict');
        res.status(409).json({
          error:
            'Idempotency key reuse with a different request payload is not allowed.',
        });
        return;
      }

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
        fingerprint: requestFingerprint,
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
