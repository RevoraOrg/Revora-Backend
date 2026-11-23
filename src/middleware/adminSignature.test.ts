import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { verifyAdminSignature } from './adminSignature';
import { AppError, ErrorCode } from '../lib/errors';
import { globalLogger } from '../lib/logger';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

/** Base64 (standard, not url-safe) SPKI encoding of the test public key. */
const PUBLIC_KEY_B64 = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');

const KID = 'test-kid';

interface MockApp {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}

/**
 * Build a minimal Express Request mock with an in-memory app store so the
 * middleware's nonce cache behaves like the real `req.app.get/set` pair.
 */
function makeReq(options: {
  headers?: Record<string, string | undefined>;
  body?: unknown;
  app?: MockApp;
} = {}): Request {
  const headers = options.headers ?? {};
  const store = new Map<string, unknown>();
  const app: MockApp =
    options.app ??
    ({
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => {
        store.set(key, value);
      },
    } as MockApp);

  return {
    path: '/api/v1/admin/offerings',
    body: options.body ?? {},
    header: (name: string) => headers[name.toLowerCase()],
    app,
  } as unknown as Request;
}

function makeRes(): Response {
  return {} as Response;
}

/** Invoke the middleware synchronously and capture any error passed to next. */
function run(req: Request): { error: AppError; nextCalled: boolean } {
  const middleware = verifyAdminSignature();
  let error = undefined as unknown as AppError;
  let nextCalled = false;
  expect(() => {
    middleware(req, makeRes(), ((err?: unknown) => {
      nextCalled = true;
      error = err as AppError;
    }) as NextFunction);
  }).not.toThrow();
  return { error, nextCalled };
}

interface SignedBody {
  action: string;
  offeringId: string;
  nonce: string;
  timestamp: number;
}

/** Build a canonical body + a matching valid Ed25519 signature. */
function signedRequest(
  overrides: Partial<SignedBody> = {},
  encoding: 'base64' | 'base64url' = 'base64url',
  extraHeaders: Record<string, string | undefined> = {},
): { body: SignedBody; signature: string; headers: Record<string, string | undefined> } {
  const body: SignedBody = {
    action: 'updateOffering',
    offeringId: 'off-1',
    nonce: crypto.randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    ...overrides,
  };
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  const signature = crypto.sign(null, Buffer.from(canonical), privateKey).toString(encoding);
  return {
    body,
    signature,
    headers: {
      'x-admin-signature': signature,
      'x-admin-kid': KID,
      ...extraHeaders,
    },
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('verifyAdminSignature', () => {
  let warnSpy: jest.SpyInstance;
  let criticalSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.ADMIN_PUBKEYS = JSON.stringify({ [KID]: PUBLIC_KEY_B64 });
    warnSpy = jest.spyOn(globalLogger, 'warn').mockImplementation(() => undefined);
    criticalSpy = jest.spyOn(globalLogger, 'critical').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ADMIN_PUBKEYS;
  });

  describe('happy path', () => {
    it('accepts a valid signature and attaches the kid for audit logging', () => {
      const { body, headers } = signedRequest();
      const req = makeReq({ headers, body });

      const { error, nextCalled } = run(req);

      expect(error).toBeUndefined();
      expect(nextCalled).toBe(true);
      expect((req as Request & { adminKid?: string }).adminKid).toBe(KID);
    });

    it('accepts a standard-base64 encoded signature (not only base64url)', () => {
      const { body, headers } = signedRequest({}, 'base64');
      const { error } = run(makeReq({ headers, body }));
      expect(error).toBeUndefined();
    });

    it('persists the nonce store on the app for later replay detection', () => {
      const { body, headers } = signedRequest();
      const req = makeReq({ headers, body });
      run(req);

      const store = req.app.get('adminNonceStore') as Set<string>;
      expect(store).toBeInstanceOf(Set);
      expect(store.has(body.nonce)).toBe(true);
    });
  });

  describe('missing or invalid client input', () => {
    it('returns 401 when the signature header is missing', () => {
      const { body, headers } = signedRequest();
      const { error } = run(makeReq({ headers: { ...headers, 'x-admin-signature': undefined }, body }));

      expect(error.statusCode).toBe(401);
      expect(error.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(warnSpy).toHaveBeenCalledWith('Missing admin signature or kid', expect.anything());
    });

    it('returns 401 when the kid header is missing', () => {
      const { body, headers } = signedRequest();
      const { error } = run(makeReq({ headers: { ...headers, 'x-admin-kid': undefined }, body }));
      expect(error.statusCode).toBe(401);
    });

    it('returns 401 for an unknown kid', () => {
      const { body, headers } = signedRequest();
      const { error } = run(makeReq({ headers: { ...headers, 'x-admin-kid': 'nope' }, body }));

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Invalid admin key');
    });

    it('returns 401 when the configured key value is not a string', () => {
      process.env.ADMIN_PUBKEYS = JSON.stringify({ [KID]: 123 });
      const { body, headers } = signedRequest();

      const { error } = run(makeReq({ headers, body }));

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Invalid admin key');
    });

    it('returns 400 when the request has a null body', () => {
      const { headers } = signedRequest();
      const req = makeReq({ headers });
      req.body = null;

      const { error } = run(req);

      expect(error.statusCode).toBe(400);
    });

    it('returns 400 when required signed fields are missing', () => {
      const { headers } = signedRequest();
      const { error } = run(makeReq({ headers, body: { action: 'updateOffering' } }));

      expect(error.statusCode).toBe(400);
      expect(error.code).toBe(ErrorCode.BAD_REQUEST);
    });

    it('returns 401 when the body is tampered after signing', () => {
      const { body, headers } = signedRequest();
      const { error } = run(makeReq({ headers, body: { ...body, offeringId: 'off-tampered' } }));

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Invalid admin signature');
    });

    it('returns 401 for a well-formed but incorrect 64-byte signature', () => {
      const { body } = signedRequest();
      const garbage = crypto.randomBytes(64).toString('base64url');

      const { error } = run(
        makeReq({ headers: { 'x-admin-signature': garbage, 'x-admin-kid': KID }, body }),
      );

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Invalid admin signature');
    });

    it('does not throw when req.body access throws (defence in depth)', () => {
      const { headers } = signedRequest();
      const req = makeReq({ headers });
      Object.defineProperty(req, 'body', {
        get() {
          throw new Error('boom');
        },
      });

      const { error } = run(req);

      expect(error.statusCode).toBe(500);
      expect(criticalSpy).toHaveBeenCalledWith(
        'Unexpected error in admin signature middleware',
        expect.objectContaining({ error: 'boom' }),
      );
    });
  });

  describe('malformed signatures never throw (issue #1358)', () => {
    it.each([
      ['non-base64 characters', '%%%%not-a-signature%%%%'],
      ['invalid padding placement', 'AA=A'],
      ['whitespace', 'AAAA AAAA'],
    ])('returns 401 for a signature with %s', (_label, signature) => {
      const { body } = signedRequest();
      const { error } = run(
        makeReq({ headers: { 'x-admin-signature': signature, 'x-admin-kid': KID }, body }),
      );

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Invalid admin signature');
      expect(warnSpy).toHaveBeenCalledWith(
        'Malformed admin signature encoding',
        expect.objectContaining({ kid: KID }),
      );
    });

    it('treats an empty signature header as missing', () => {
      const { body } = signedRequest();
      const { error } = run(
        makeReq({ headers: { 'x-admin-signature': '', 'x-admin-kid': KID }, body }),
      );

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Missing admin signature');
    });

    it('returns 401 for a truncated (32-byte) signature instead of throwing', () => {
      const { body } = signedRequest();
      const truncated = crypto.randomBytes(32).toString('base64url');

      const { error } = run(
        makeReq({ headers: { 'x-admin-signature': truncated, 'x-admin-kid': KID }, body }),
      );

      expect(error.statusCode).toBe(401);
    });

    it('returns 401 for a 63-byte signature (off-by-one length)', () => {
      const { body } = signedRequest();
      const short = crypto.randomBytes(63).toString('base64url');

      const { error } = run(
        makeReq({ headers: { 'x-admin-signature': short, 'x-admin-kid': KID }, body }),
      );

      expect(error.statusCode).toBe(401);
    });

    it('maps a crypto.verify throw to 401 rather than a 500', () => {
      const { body, headers } = signedRequest();
      jest.spyOn(crypto, 'verify').mockImplementationOnce(() => {
        throw new Error('verification exploded');
      });

      const { error } = run(makeReq({ headers, body }));

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Invalid admin signature');
      expect(warnSpy).toHaveBeenCalledWith(
        'Admin signature verification threw',
        expect.objectContaining({ error: 'verification exploded' }),
      );
    });

    it('handles a non-Error thrown by crypto.verify', () => {
      const { body, headers } = signedRequest();
      jest.spyOn(crypto, 'verify').mockImplementationOnce(() => {
        throw 'plain string';
      });

      const { error } = run(makeReq({ headers, body }));

      expect(error.statusCode).toBe(401);
      expect(warnSpy).toHaveBeenCalledWith(
        'Admin signature verification threw',
        expect.objectContaining({ error: 'plain string' }),
      );
    });

    it('handles a non-Error thrown while reading the request body', () => {
      const { headers } = signedRequest();
      const req = makeReq({ headers });
      Object.defineProperty(req, 'body', {
        get() {
          throw 'plain body error';
        },
      });

      const { error } = run(req);

      expect(error.statusCode).toBe(500);
      expect(criticalSpy).toHaveBeenCalledWith(
        'Unexpected error in admin signature middleware',
        expect.objectContaining({ error: 'plain body error' }),
      );
    });
  });

  describe('malformed server key configuration (critical + 500)', () => {
    it('returns 500 and logs critical when ADMIN_PUBKEYS is unset', () => {
      delete process.env.ADMIN_PUBKEYS;
      const { body, headers } = signedRequest();

      const { error } = run(makeReq({ headers, body }));

      expect(error.statusCode).toBe(500);
      expect(error.expose).toBe(false);
      expect(criticalSpy).toHaveBeenCalledWith('ADMIN_PUBKEYS env not set');
    });

    it('returns 500 and logs critical when ADMIN_PUBKEYS is not valid JSON', () => {
      process.env.ADMIN_PUBKEYS = '{not-json';
      const { body, headers } = signedRequest();

      const { error } = run(makeReq({ headers, body }));

      expect(error.statusCode).toBe(500);
      expect(criticalSpy).toHaveBeenCalledWith('ADMIN_PUBKEYS env malformed');
    });

    it.each([
      ['null', 'null'],
      ['an array', '["a"]'],
      ['a scalar', '"abc"'],
    ])('returns 500 when ADMIN_PUBKEYS parses to %s', (_label, value) => {
      process.env.ADMIN_PUBKEYS = value;
      const { body, headers } = signedRequest();

      const { error } = run(makeReq({ headers, body }));

      expect(error.statusCode).toBe(500);
      expect(criticalSpy).toHaveBeenCalledWith('ADMIN_PUBKEYS env malformed');
    });

    it('returns 500 and logs critical for a corrupt (non-base64) public key', () => {
      process.env.ADMIN_PUBKEYS = JSON.stringify({ [KID]: '%%%%corrupt-key%%%%' });
      const { body, headers } = signedRequest();

      const { error } = run(makeReq({ headers, body }));

      expect(error.statusCode).toBe(500);
      expect(error.message).toBe('Server configuration error');
      expect(criticalSpy).toHaveBeenCalledWith(
        'ADMIN_PUBKEYS contains an invalid public key',
        expect.objectContaining({ kid: KID }),
      );
    });

    it('handles a non-Error thrown by crypto.createPublicKey', () => {
      process.env.ADMIN_PUBKEYS = JSON.stringify({ [KID]: PUBLIC_KEY_B64 });
      const { body, headers } = signedRequest();
      jest.spyOn(crypto, 'createPublicKey').mockImplementationOnce(() => {
        throw 'key parse failed';
      });

      const { error } = run(makeReq({ headers, body }));

      expect(error.statusCode).toBe(500);
      expect(criticalSpy).toHaveBeenCalledWith(
        'ADMIN_PUBKEYS contains an invalid public key',
        expect.objectContaining({ error: 'key parse failed' }),
      );
    });

    it('returns 500 and logs critical for a valid-base64 but non-SPKI key', () => {
      process.env.ADMIN_PUBKEYS = JSON.stringify({
        [KID]: crypto.randomBytes(32).toString('base64'),
      });
      const { body, headers } = signedRequest();

      const { error } = run(makeReq({ headers, body }));

      expect(error.statusCode).toBe(500);
      expect(criticalSpy).toHaveBeenCalledWith(
        'ADMIN_PUBKEYS contains an invalid public key',
        expect.objectContaining({ kid: KID }),
      );
    });
  });

  describe('replay and freshness protections', () => {
    it('returns 401 for a valid signature with a stale timestamp', () => {
      const stale = Math.floor(Date.now() / 1000) - 120;
      const { body, headers } = signedRequest({ timestamp: stale });

      const { error } = run(makeReq({ headers, body }));

      expect(error.statusCode).toBe(401);
      expect(error.message).toBe('Stale timestamp');
    });

    it('returns 409 when the same nonce is replayed', () => {
      const { body, headers } = signedRequest();
      const req = makeReq({ headers, body });

      // First use succeeds and registers the nonce.
      expect(run(req).error).toBeUndefined();

      // Second use with the identical signed request is rejected as a replay.
      const { error } = run(makeReq({ headers, body, app: req.app }));
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe(ErrorCode.CONFLICT);
    });
  });
});
