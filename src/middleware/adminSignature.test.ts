
import crypto from 'crypto';
import { Request, Response } from 'express';
import { AppError } from '../lib/errors';
import { verifyAdminSignature } from './adminSignature';

const ADMIN_KID = 'admin-test-key';
const NOW = new Date('2026-11-22T15:00:00.000Z');
const TIMESTAMP = Math.floor(NOW.getTime() / 1000);

const originalAdminPubKeys = process.env.ADMIN_PUBKEYS;

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
});
import { Request, Response, NextFunction } from 'express';
import { globalLogger } from '../lib/logger';
describe('verifyAdminSignature', () => {
  const kid = 'test-admin';
  const privateKey = keyPair.privateKey;
  const publicKeyBase64 = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const originalPubKeys = process.env.ADMIN_PUBKEYS;
  const originalV1Enabled = process.env.ADMIN_SIGNATURE_V1_ENABLED;
  let warnSpy: jest.SpyInstance;
    process.env.ADMIN_PUBKEYS = JSON.stringify({ [kid]: publicKeyBase64 });
    delete process.env.ADMIN_SIGNATURE_V1_ENABLED;
    warnSpy = jest.spyOn(globalLogger, 'warn').mockImplementation(() => undefined);
    warnSpy.mockRestore();
    if (originalPubKeys === undefined) delete process.env.ADMIN_PUBKEYS;
    else process.env.ADMIN_PUBKEYS = originalPubKeys;
    if (originalV1Enabled === undefined) delete process.env.ADMIN_SIGNATURE_V1_ENABLED;
    else process.env.ADMIN_SIGNATURE_V1_ENABLED = originalV1Enabled;
  function sign(payload: Record<string, unknown>): string {
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
  }
  function makeRequest(options: {
    body: Record<string, unknown>;
    version?: string;
    method?: string;
    originalUrl?: string;
  }): Request {
    const headers: Record<string, string> = {
      'x-admin-signature': sign(options.body),
      'x-admin-kid': kid,
    };
    if (options.version !== undefined) headers['x-admin-signature-version'] = options.version;
    const settings = new Map<string, unknown>();
    return {
      body: options.body,
      method: options.method ?? 'POST',
      originalUrl: options.originalUrl ?? '/api/startup/offerings/offering-456/approve',
      path: options.originalUrl?.split('?')[0] ?? '/api/startup/offerings/offering-456/approve',
      header: (name: string) => headers[name.toLowerCase()],
      app: {
        get: (name: string) => settings.get(name),
        set: (name: string, value: unknown) => settings.set(name, value),
      },
    } as unknown as Request;
  }
  function invoke(req: Request): jest.Mock {
    const next = jest.fn() as jest.Mock;
    verifyAdminSignature()(req, {} as Response, next as NextFunction);
    return next;
  }
  function fields(nonce: string): Record<string, unknown> {
    return {
      action: 'approve',
      offeringId: 'offering-456',
      nonce,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }
  it('rejects a v2 signature replayed against a different route', () => {
    const signedRoute = '/api/startup/offerings/offering-456/approve';
    const signedBody = {
      ...fields('route-replay'),
      method: 'POST',
      path: signedRoute,
    };
    const req = makeRequest({
      body: signedBody,
      version: '2',
      originalUrl: '/api/startup/offerings/offering-456/reject',
    const next = invoke(req);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(req.app.get('adminNonceStore')).toBeUndefined();
  it('rejects a v2 signature replayed with a different HTTP method', () => {
    const path = '/api/startup/offerings/offering-456/approve';
    const req = makeRequest({
      body: { ...fields('method-replay'), method: 'PUT', path },
      version: '2',
      method: 'POST',
    const next = invoke(req);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    expect(req.app.get('adminNonceStore')).toBeUndefined();
  it('accepts a v2 signature for the exact method and pathname', () => {
    const path = '/api/startup/offerings/offering-456/approve';
    const req = makeRequest({
      body: { ...fields('route-match'), method: 'POST', path },
      version: '2',
      originalUrl: `${path}?source=dashboard`,
    const next = invoke(req);
    expect(req.app.get('adminNonceStore')).toContain('route-match');
  it('keeps header-less v1 signatures working and emits a deprecation warning', () => {
    const req = makeRequest({ body: fields('legacy-compatible') });
    const next = invoke(req);
    expect(warnSpy).toHaveBeenCalledWith(
      'Legacy admin signature version is deprecated',
      expect.objectContaining({ kid, path: req.path }),
  it('rejects v1 signatures when the compatibility flag is disabled', () => {
    process.env.ADMIN_SIGNATURE_V1_ENABLED = 'false';
    const req = makeRequest({ body: fields('legacy-disabled'), version: '1' });
    const next = invoke(req);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
