
import crypto from 'crypto';
import { Request, Response } from 'express';
import { Pool } from 'pg';
import { AppError } from '../lib/errors';
import {
  DEFAULT_ADMIN_NONCE_TTL_MS,
  PostgresAdminNonceStore,
  verifyAdminSignature,
} from './adminSignature';

const ADMIN_KID = 'admin-test-key';
const NOW = new Date('2026-11-22T15:00:00.000Z');
const TIMESTAMP = Math.floor(NOW.getTime() / 1000);

const originalAdminPubKeys = process.env.ADMIN_PUBKEYS;
const originalAdminNonceTtlMs = process.env.ADMIN_NONCE_TTL_MS;

let publicKey: crypto.KeyObject;
let privateKey: crypto.KeyObject;
let publicKeyBase64: string;

function generateKeyPair() {
  const keyPair = crypto.generateKeyPairSync('ed25519');

  publicKey = keyPair.publicKey;
  privateKey = keyPair.privateKey;

  publicKeyBase64 = publicKey
    .export({
      type: 'spki',
      format: 'der',
    })
    .toString('base64');

  process.env.ADMIN_PUBKEYS = JSON.stringify({
    [ADMIN_KID]: publicKeyBase64,
  });
}

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'update',
    offeringId: 'offering-123',
    nonce: 'nonce-123',
    timestamp: TIMESTAMP,
    ...overrides,
  };
}

function createSignature(
  payload: ReturnType<typeof createPayload>,
  signingKey: crypto.KeyObject = privateKey,
) {
  const { action, offeringId, nonce, timestamp } = payload;

  const canonical = JSON.stringify(
    { action, offeringId, nonce, timestamp },
    Object.keys({ action, offeringId, nonce, timestamp }).sort(),
  );

  return crypto
    .sign(null, Buffer.from(canonical), signingKey)
    .toString('base64');
}

function createMockRequest(
  payload: Record<string, unknown> = createPayload(),
  options: {
    signature?: string;
    kid?: string;
    nonceStore?: Set<string>;
    withoutNonceStore?: boolean;
  } = {},
) {
  const nonceStore = options.nonceStore ?? new Set<string>();

  const headers: Record<string, string> = {
    'x-admin-signature':
      options.signature ?? createSignature(payload as ReturnType<typeof createPayload>),
    'x-admin-kid': options.kid ?? ADMIN_KID,
  };

  const req = {
    header: jest.fn((name: string) => headers[name.toLowerCase()]),
    body: payload,
    path: '/offerings',
    app: {
      get: jest.fn((key: string) =>
        key === 'adminNonceStore' && !options.withoutNonceStore ? nonceStore : undefined
      ),
      set: jest.fn((key: string, value: unknown) => {
        if (key === 'adminNonceStore') {
          return value;
        }
      }),
    },
  } as unknown as Request;

  return { req, nonceStore, headers };
}

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

function expectAppError(next: jest.Mock, statusCode: number, code: string) {
  expect(next).toHaveBeenCalledTimes(1);

  const error = next.mock.calls[0][0] as AppError;

  expect(error).toBeInstanceOf(AppError);
  expect(error.statusCode).toBe(statusCode);
  expect(error.code).toBe(code);

  return error;
}

describe('verifyAdminSignature middleware', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);

    generateKeyPair();
  });

  afterEach(() => {
    jest.useRealTimers();

    if (originalAdminPubKeys === undefined) {
      delete process.env.ADMIN_PUBKEYS;
    } else {
      process.env.ADMIN_PUBKEYS = originalAdminPubKeys;
    }

    if (originalAdminNonceTtlMs === undefined) {
      delete process.env.ADMIN_NONCE_TTL_MS;
    } else {
      process.env.ADMIN_NONCE_TTL_MS = originalAdminNonceTtlMs;
    }

    jest.clearAllMocks();
  });

  it('rejects requests with missing headers', () => {
    const { req } = createMockRequest();

    (req.header as jest.Mock).mockReturnValue(undefined);

    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expectAppError(next, 401, 'UNAUTHORIZED');
  });

  it('rejects requests when ADMIN_PUBKEYS is missing', () => {
    delete process.env.ADMIN_PUBKEYS;

    const { req } = createMockRequest();
    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expectAppError(next, 500, 'INTERNAL_ERROR');
  });

  it('rejects requests when ADMIN_PUBKEYS contains malformed JSON', () => {
    process.env.ADMIN_PUBKEYS = '{invalid-json';

    const { req } = createMockRequest();
    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expectAppError(next, 500, 'INTERNAL_ERROR');
  });

  it('rejects requests with an unknown kid', () => {
    const { req } = createMockRequest(undefined, {
      kid: 'unknown-key',
    });

    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expectAppError(next, 401, 'UNAUTHORIZED');
  });

  it('rejects requests with missing signed fields', () => {
    const payload = createPayload({
      nonce: undefined,
    });

    const { req } = createMockRequest(payload, {
      signature: 'invalid-signature',
    });

    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expectAppError(next, 400, 'BAD_REQUEST');
  });

  it('rejects requests with an invalid signature', () => {
    const { privateKey: anotherPrivateKey } =
      crypto.generateKeyPairSync('ed25519');

    const payload = createPayload();

    const invalidSignature = createSignature(
      payload,
      anotherPrivateKey,
    );

    const { req } = createMockRequest(payload, {
      signature: invalidSignature,
    });

    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expectAppError(next, 401, 'UNAUTHORIZED');
  });

  it('rejects requests with a stale timestamp', () => {
    const payload = createPayload({
      timestamp: TIMESTAMP - 31,
    });

    const { req } = createMockRequest(payload);

    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expectAppError(next, 401, 'UNAUTHORIZED');
  });

  it('rejects requests with a replayed nonce', () => {
    const payload = createPayload();

    const nonceStore = new Set<string>([payload.nonce]);

    const { req } = createMockRequest(payload, {
      nonceStore,
    });

    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expectAppError(next, 409, 'CONFLICT');
    expect(nonceStore.has(payload.nonce)).toBe(true);
  });

  it('rejects requests with a null body', () => {
    const { req } = createMockRequest();

    req.body = null;

    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expectAppError(next, 400, 'BAD_REQUEST');
  });

  it('creates a nonce store when none exists', () => {
    const payload = createPayload();

    const { req } = createMockRequest(payload, {
      withoutNonceStore: true,
    });

    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();

    const storedNonceStore = (req.app.set as jest.Mock)
      .mock.calls[0][1] as Set<string>;

    expect(storedNonceStore).toBeInstanceOf(Set);
    expect(storedNonceStore.has(payload.nonce)).toBe(true);
  });

  it('accepts valid signatures, attaches adminKid and stores the nonce', () => {
    const payload = createPayload();

    const { req, nonceStore } = createMockRequest(payload);

    const next = jest.fn();

    verifyAdminSignature()(req, mockRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();

    expect((req as Request & { adminKid?: string }).adminKid).toBe(ADMIN_KID);

    expect(nonceStore.has(payload.nonce)).toBe(true);

    expect(req.app.set).toHaveBeenCalledWith(
      'adminNonceStore',
      nonceStore,
    );
  });

  describe('with a shared nonce store', () => {
    async function runWithStore(
      store: { consume: jest.Mock },
      payload = createPayload(),
      options: { nonceTtlMs?: number; failOpenOnStoreError?: boolean } = {},
    ) {
      const { req } = createMockRequest(payload);
      const next = jest.fn();
      const middleware = verifyAdminSignature({ store, ...options });

      await (middleware(req, mockRes(), next) as unknown as Promise<void>);

      return { req, next };
    }

    it('consumes the nonce scoped to the verified kid with the default TTL', async () => {
      const store = { consume: jest.fn().mockResolvedValue(true) };

      const { req, next } = await runWithStore(store);

      expect(store.consume).toHaveBeenCalledTimes(1);
      expect(store.consume).toHaveBeenCalledWith(
        ADMIN_KID,
        'nonce-123',
        DEFAULT_ADMIN_NONCE_TTL_MS,
      );
      expect(next).toHaveBeenCalledWith();
      expect((req as Request & { adminKid?: string }).adminKid).toBe(ADMIN_KID);
      // The process-local fallback must not be populated when a shared store
      // is configured, otherwise the two replay histories could diverge.
      expect(req.app.set).not.toHaveBeenCalled();
    });

    it('rejects a replay reported by the shared store', async () => {
      const store = { consume: jest.fn().mockResolvedValue(false) };

      const { next } = await runWithStore(store);

      expectAppError(next, 409, 'CONFLICT');
    });

    it('fails closed when the store throws', async () => {
      const store = {
        consume: jest.fn().mockRejectedValue(new Error('database down')),
      };

      const { req, next } = await runWithStore(store);

      expectAppError(next, 500, 'INTERNAL_ERROR');
      expect((req as Request & { adminKid?: string }).adminKid).toBeUndefined();
    });

    it('fails open when explicitly configured and the store throws', async () => {
      const store = {
        consume: jest.fn().mockRejectedValue(new Error('database down')),
      };

      const { req, next } = await runWithStore(store, createPayload(), {
        failOpenOnStoreError: true,
      });

      expect(next).toHaveBeenCalledWith();
      expect((req as Request & { adminKid?: string }).adminKid).toBe(ADMIN_KID);
    });

    it('honours the nonceTtlMs option over the environment', async () => {
      process.env.ADMIN_NONCE_TTL_MS = '30000';
      const store = { consume: jest.fn().mockResolvedValue(true) };

      await runWithStore(store, createPayload(), { nonceTtlMs: 90_000 });

      expect(store.consume).toHaveBeenCalledWith(ADMIN_KID, 'nonce-123', 90_000);
    });

    it('honours ADMIN_NONCE_TTL_MS when no option is given', async () => {
      process.env.ADMIN_NONCE_TTL_MS = '45000';
      const store = { consume: jest.fn().mockResolvedValue(true) };

      await runWithStore(store);

      expect(store.consume).toHaveBeenCalledWith(ADMIN_KID, 'nonce-123', 45_000);
    });

    it.each(['0', '-5', 'not-a-number', ''])(
      'falls back to the default TTL for invalid ADMIN_NONCE_TTL_MS=%j',
      async (value) => {
        process.env.ADMIN_NONCE_TTL_MS = value;
        const store = { consume: jest.fn().mockResolvedValue(true) };

        await runWithStore(store);

        expect(store.consume).toHaveBeenCalledWith(
          ADMIN_KID,
          'nonce-123',
          DEFAULT_ADMIN_NONCE_TTL_MS,
        );
      },
    );

    it('falls back to the default TTL for an invalid nonceTtlMs option', async () => {
      const store = { consume: jest.fn().mockResolvedValue(true) };

      await runWithStore(store, createPayload(), { nonceTtlMs: 0 });

      expect(store.consume).toHaveBeenCalledWith(
        ADMIN_KID,
        'nonce-123',
        DEFAULT_ADMIN_NONCE_TTL_MS,
      );
    });
  });
});

describe('PostgresAdminNonceStore', () => {
  function createPool(rowCount: number | null = 1) {
    const query = jest.fn().mockResolvedValue({ rowCount, rows: [] });
    return { pool: { query } as unknown as Pool, query };
  }

  it('records a new (kid, nonce) with a single atomic upsert and reports success', async () => {
    const { pool, query } = createPool(1);
    const store = new PostgresAdminNonceStore({ pool });

    await expect(store.consume('kid-1', 'nonce-1', 120_000)).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO admin_nonces (kid, nonce, expires_at)');
    expect(sql).toContain('ON CONFLICT (kid, nonce) DO UPDATE');
    expect(sql).toContain('WHERE admin_nonces.expires_at <= NOW()');
    expect(params[0]).toBe('kid-1');
    expect(params[1]).toBe('nonce-1');
    expect(params[2]).toBeInstanceOf(Date);
    const expiresAt = (params[2] as Date).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(Date.now() + 120_000 - 1_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 120_000 + 1_000);
  });

  it.each([0, null])(
    'reports a replay when the upsert returns no row (rowCount=%j)',
    async (rowCount) => {
      const { pool } = createPool(rowCount);
      const store = new PostgresAdminNonceStore({ pool });

      await expect(store.consume('kid-1', 'nonce-1', 1_000)).resolves.toBe(false);
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid TTL (%j) without querying the database',
    async (ttlMs) => {
      const { pool, query } = createPool();
      const store = new PostgresAdminNonceStore({ pool });

      await expect(store.consume('kid-1', 'nonce-1', ttlMs)).rejects.toThrow(
        'Admin nonce TTL must be a positive finite number of milliseconds',
      );
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('propagates database errors so the middleware can apply its fail policy', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection refused'));
    const store = new PostgresAdminNonceStore({
      pool: { query } as unknown as Pool,
    });

    await expect(store.consume('kid-1', 'nonce-1', 1_000)).rejects.toThrow(
      'connection refused',
    );
  });

  it('deletes expired rows and returns the number removed', async () => {
    const { pool, query } = createPool(3);
    const store = new PostgresAdminNonceStore({ pool });

    await expect(store.cleanupExpired()).resolves.toBe(3);

    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toContain('DELETE FROM admin_nonces WHERE expires_at < NOW()');
  });

  it('treats a missing rowCount from cleanup as zero deleted', async () => {
    const { pool } = createPool(null);
    const store = new PostgresAdminNonceStore({ pool });

    await expect(store.cleanupExpired()).resolves.toBe(0);
  });
});
