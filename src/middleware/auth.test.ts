import crypto from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  authMiddleware,
  verifyJwt,
  requireInvestor,
  AuthenticatedRequest,
  createRequireAuth,
  requireAdminWithEd25519Signature,
  resetAdminPubKeysCache,
  AdminSignatureContext,
} from './auth';
import { hashSessionToken } from '../auth/session';
import { signJwt } from '../utils/jwt';
import {
  issueToken,
  signAdminStatusTransition,
  AdminSignedStatusTransitionPayload,
  InMemoryAdminSignatureReplayCache,
} from '../lib/jwt';
import { AuthenticatedRequest as LogoutAuthenticatedRequest } from '../auth/logout/types';
import { AppError } from '../lib/errors';

// ── Shared secret setup ───────────────────────────────────────────────────────
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-32chars!';
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const SECRET = process.env.JWT_SECRET ?? 'test-secret-that-is-long-enough-32chars!';
const PREVIOUS_SECRET = 'previous-secret-that-is-long-enough-32chars!!';

function makeJwtToken(
  payload: Record<string, unknown>,
  secret: string = SECRET,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

/** Helper: assert next() was called with an AppError having the given statusCode */
function expectAppError(next: jest.Mock, statusCode: number): AppError {
  expect(next).toHaveBeenCalled();
  const err = next.mock.calls[0][0] as AppError;
  expect(err).toBeInstanceOf(AppError);
  expect(err.statusCode).toBe(statusCode);
  return err;
}

// ── requireAuth (feature/change-password-api) ─────────────────────────────────
describe('requireAuth middleware', () => {
  const mockNext: NextFunction = jest.fn();

  const makeReq = (authHeader?: string): LogoutAuthenticatedRequest =>
    ({ headers: authHeader ? { authorization: authHeader } : {} }) as LogoutAuthenticatedRequest;

  let requireAuth: RequestHandler;
  let sessionRepo: { findById: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.JWT_SECRET_PREVIOUS;

    sessionRepo = {
      findById: jest.fn().mockResolvedValue(null),
    };

    requireAuth = createRequireAuth(sessionRepo as any);
  });

  it('calls next() and sets req.auth for a valid token', async () => {
    const token = signJwt({ sub: 'user-123', sid: 'session-abc' });
    const tokenHash = hashSessionToken(token);
    sessionRepo.findById.mockResolvedValueOnce({
      id: 'session-abc',
      user_id: 'user-123',
      token_hash: tokenHash,
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      created_at: new Date(),
    });

    const req = makeReq(`Bearer ${token}`);
    const res = mockRes();

    await requireAuth(req as Request, res, mockNext);

    expect(mockNext).toHaveBeenCalledWith();
    expect(req.auth?.userId).toBe('user-123');
    expect(req.auth?.sessionId).toBe('session-abc');
    expect(req.auth?.tokenId).toBe(token);
  });

  it('calls next with 401 AppError when Authorization header is missing', async () => {
    const req = makeReq();
    const res = mockRes();

    await requireAuth(req as Request, res, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('calls next with 401 AppError when the header is not Bearer scheme', async () => {
    const req = makeReq('Basic dXNlcjpwYXNz');
    const res = mockRes();

    await requireAuth(req as Request, res, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('calls next with 401 AppError for an invalid/tampered token', async () => {
    const req = makeReq('Bearer invalid.token.here');
    const res = mockRes();

    await requireAuth(req as Request, res, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });

  it('calls next with 401 AppError for an expired token', async () => {
    const token = signJwt({ sub: 'user-123', sid: 'session-abc' }, '-1s');
    const req = makeReq(`Bearer ${token}`);
    const res = mockRes();

    await requireAuth(req as Request, res, mockNext);

    expect(mockNext).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
  });
});

// ── authMiddleware (master — JWT factory fn) ──────────────────────────────────
describe('authMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.JWT_SECRET_PREVIOUS;
    delete process.env.JWT_ISSUER;
    delete process.env.JWT_AUDIENCE;
  });

  describe('valid token', () => {
    it('attaches user to request with valid token', () => {
      const token = issueToken({ subject: 'user-123', email: 'test@example.com' });
      const req = { headers: { authorization: `Bearer ${token}` } } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect((req as AuthenticatedRequest).user?.sub).toBe('user-123');
      expect((req as AuthenticatedRequest).user?.email).toBe('test@example.com');
    });

    it('works with token containing only sub', () => {
      const token = issueToken({ subject: 'user-456' });
      const req = { headers: { authorization: `Bearer ${token}` } } as Request;
      const next = jest.fn();

      authMiddleware()(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect((req as AuthenticatedRequest).user?.sub).toBe('user-456');
    });
  });

  describe('missing token', () => {
    it('calls next with 401 AppError when Authorization header is missing', () => {
      const req = { headers: {} } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({
        statusCode: 401,
        message: 'Authorization header missing',
      }));
    });
  });

  describe('invalid token', () => {
    it('calls next with 401 AppError for invalid token format', () => {
      const req = { headers: { authorization: 'InvalidFormat token123' } } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });

    it('calls next with 401 AppError for malformed token', () => {
      const req = { headers: { authorization: 'Bearer not-a-valid-jwt' } } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });

    it('calls next with 401 AppError for wrong secret', () => {
      const req = {
        headers: {
          authorization:
            'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImlhdCI6MTcwMDAwMDAwMH0.invalid',
        },
      } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });
  });

  describe('expired token', () => {
    it('calls next with 401 AppError for expired token', () => {
      // Must be expired beyond the default 30s clock-skew tolerance.
      const token = issueToken({ subject: 'user-123', expiresIn: '-60s' });
      const req = { headers: { authorization: `Bearer ${token}` } } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 401 }));
    });
  });
});

// ── verifyJwt ─────────────────────────────────────────────────────────────────
describe('verifyJwt', () => {
  it('decodes a valid token and returns expected payload fields', () => {
    const token = makeJwtToken({ sub: 'user-1', role: 'investor', sid: 'session-123' });
    const payload = verifyJwt(token, SECRET);
    expect(payload.sub).toBe('user-1');
    expect(payload.role).toBe('investor');
    expect(payload.sid).toBe('session-123');
  });

  describe('token format boundary and error handling (evidence: line 157)', () => {
    it('throws Invalid token format on an empty string', () => {
      expect(() => verifyJwt('', SECRET)).toThrow('Invalid token format');
    });

    it('throws Invalid token format when token has only 1 part', () => {
      expect(() => verifyJwt('onlyonepart', SECRET)).toThrow('Invalid token format');
    });

    it('throws Invalid token format when token has 2 parts', () => {
      expect(() => verifyJwt('header.payload', SECRET)).toThrow('Invalid token format');
    });

    it('throws Invalid token format on a malformed dot string', () => {
      expect(() => verifyJwt('not.a.valid.token', SECRET)).toThrow('Invalid token format');
    });

    it('throws Invalid token format when token has 4 parts', () => {
      expect(() => verifyJwt('part1.part2.part3.part4', SECRET)).toThrow('Invalid token format');
    });
  });

  describe('token signature validation and non-JSON handling (evidence: line 180)', () => {
    it('throws Invalid token signature on wrong secret', () => {
      const token = makeJwtToken({ sub: 'user-1', role: 'investor' });
      expect(() => verifyJwt(token, 'wrong-secret')).toThrow('Invalid token signature');
    });

    it('throws Invalid token signature when signature segment is tampered', () => {
      const token = makeJwtToken({ sub: 'user-1', role: 'investor' });
      const [header, payload] = token.split('.');
      const tampered = `${header}.${payload}.invalidsignaturebase64url`;
      expect(() => verifyJwt(tampered, SECRET)).toThrow('Invalid token signature');
    });

    it('throws Invalid token signature when payload is altered after signing', () => {
      const token = makeJwtToken({ sub: 'user-1', role: 'investor' });
      const [header, , sig] = token.split('.');
      const alteredPayload = Buffer.from(JSON.stringify({ sub: 'attacker', role: 'admin' })).toString('base64url');
      expect(() => verifyJwt(`${header}.${alteredPayload}.${sig}`, SECRET)).toThrow('Invalid token signature');
    });

    it('throws Invalid token signature when header is altered after signing', () => {
      const token = makeJwtToken({ sub: 'user-1', role: 'investor' });
      const [, payload, sig] = token.split('.');
      const alteredHeader = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
      expect(() => verifyJwt(`${alteredHeader}.${payload}.${sig}`, SECRET)).toThrow('Invalid token signature');
    });

    it('throws Invalid token signature when payload is not valid JSON despite valid HMAC', () => {
      const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const nonJsonPayloadB64 = Buffer.from('this is not json {').toString('base64url');
      const expectedSig = crypto
        .createHmac('sha256', SECRET)
        .update(`${headerB64}.${nonJsonPayloadB64}`)
        .digest('base64url');
      const token = `${headerB64}.${nonJsonPayloadB64}.${expectedSig}`;

      expect(() => verifyJwt(token, SECRET)).toThrow('Invalid token signature');
    });

    it('throws Invalid token signature when passed an empty secrets array', () => {
      const token = makeJwtToken({ sub: 'user-1', role: 'investor' });
      expect(() => verifyJwt(token, [])).toThrow('Invalid token signature');
    });
  });

  describe('token expiration boundaries (evidence: line 186)', () => {
    it('throws Token expired when exp is in the past', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 60;
      const token = makeJwtToken({ sub: 'user-1', role: 'investor', exp: pastExp });
      expect(() => verifyJwt(token, SECRET)).toThrow('Token expired');
    });

    it('throws Token expired when exp is exactly 1 second in the past', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 1;
      const token = makeJwtToken({ sub: 'user-1', role: 'investor', exp: pastExp });
      expect(() => verifyJwt(token, SECRET)).toThrow('Token expired');
    });

    it('accepts a token with exp equal to the current second (boundary)', () => {
      const now = Math.floor(Date.now() / 1000);
      const token = makeJwtToken({ sub: 'user-1', role: 'investor', exp: now });
      const payload = verifyJwt(token, SECRET);
      expect(payload.sub).toBe('user-1');
      expect(payload.exp).toBe(now);
    });

    it('accepts a token with a future expiry', () => {
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const token = makeJwtToken({ sub: 'user-1', role: 'investor', exp: futureExp });
      const payload = verifyJwt(token, SECRET);
      expect(payload.sub).toBe('user-1');
      expect(payload.exp).toBe(futureExp);
    });

    it('accepts a token without exp claim (exp undefined)', () => {
      const token = makeJwtToken({ sub: 'user-no-exp', role: 'investor' });
      const payload = verifyJwt(token, SECRET);
      expect(payload.sub).toBe('user-no-exp');
      expect(payload.exp).toBeUndefined();
    });
  });

  // ── Key rotation for verifyJwt ──────────────────────────────────────────────

  describe('key rotation', () => {
    it('verifies token with current secret when given an array of secrets', () => {
      const token = makeJwtToken({ sub: 'user-1', role: 'investor' }, SECRET);
      const payload = verifyJwt(token, [SECRET, PREVIOUS_SECRET]);
      expect(payload.sub).toBe('user-1');
    });

    it('verifies token with previous secret when current fails', () => {
      const token = makeJwtToken({ sub: 'user-rotated', role: 'investor' }, PREVIOUS_SECRET);
      const payload = verifyJwt(token, [SECRET, PREVIOUS_SECRET]);
      expect(payload.sub).toBe('user-rotated');
    });

    it('throws when no secret in the array matches', () => {
      const token = makeJwtToken({ sub: 'user-1', role: 'investor' }, 'third-secret-not-in-array');
      expect(() => verifyJwt(token, [SECRET, PREVIOUS_SECRET])).toThrow('Invalid token signature');
    });

    it('works with a single-element array', () => {
      const token = makeJwtToken({ sub: 'user-1', role: 'investor' }, SECRET);
      const payload = verifyJwt(token, [SECRET]);
      expect(payload.sub).toBe('user-1');
    });
  });
});

// ── requireInvestor ───────────────────────────────────────────────────────────
describe('requireInvestor', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    delete process.env.JWT_SECRET_PREVIOUS;
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });

  const makeReq = (authHeader?: string): Request =>
    ({ headers: authHeader ? { authorization: authHeader } : {} }) as unknown as Request;

  it('calls next() for a valid investor token', () => {
    const token = makeJwtToken({ sub: 'investor-1', role: 'investor' });
    const req = makeReq(`Bearer ${token}`);
    const next: NextFunction = jest.fn();

    requireInvestor(req, mockRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect((req as AuthenticatedRequest).user).toEqual({ id: 'investor-1', role: 'investor' });
  });

  it('calls next with 401 AppError when Authorization header is missing', () => {
    const next: NextFunction = jest.fn();

    requireInvestor(makeReq(), mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Missing or invalid Authorization header',
    }));
  });

  it('calls next with 401 AppError for Basic auth', () => {
    const next: NextFunction = jest.fn();

    requireInvestor(makeReq('Basic some-credentials'), mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Missing or invalid Authorization header',
    }));
  });

  it('calls next with 401 AppError for an invalid token', () => {
    const next: NextFunction = jest.fn();

    requireInvestor(makeReq('Bearer invalid.token.here'), mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Invalid or expired token',
    }));
  });

  it('calls next with 403 AppError for a non-investor role', () => {
    const token = makeJwtToken({ sub: 'admin-1', role: 'admin' });
    const next: NextFunction = jest.fn();

    requireInvestor(makeReq(`Bearer ${token}`), mockRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 403,
      message: 'Forbidden: investor role required',
    }));
  });

  it('calls next with 500 AppError when JWT_SECRET is not set', () => {
    delete process.env.JWT_SECRET;
    const token = makeJwtToken({ sub: 'investor-1', role: 'investor' });
    const next: NextFunction = jest.fn();

    requireInvestor(makeReq(`Bearer ${token}`), mockRes(), next);

    expectAppError(next, 500);
  });

  it('verifies investor token signed with previous secret when JWT_SECRET_PREVIOUS is set', () => {
    const token = makeJwtToken({ sub: 'investor-1', role: 'investor' }, PREVIOUS_SECRET);
    process.env.JWT_SECRET_PREVIOUS = PREVIOUS_SECRET;

    const req = makeReq(`Bearer ${token}`);
    const next: NextFunction = jest.fn();

    requireInvestor(req, mockRes(), next);

    // Token signed with the previous secret must verify successfully.
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect((req as AuthenticatedRequest).user).toEqual({ id: 'investor-1', role: 'investor' });
  });
});

// ── requireAdminWithEd25519Signature and AdminSignatureContext ────────────────
describe('requireAdminWithEd25519Signature and AdminSignatureContext', () => {
  // Generate Ed25519 keypairs for admin testing
  const { publicKey: edPublicKey, privateKey: edPrivateKey } = crypto.generateKeyPairSync('ed25519');
  const adminPubPem = edPublicKey.export({ type: 'spki', format: 'pem' }).toString();
  const adminPrivPem = edPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const { publicKey: otherEdPublicKey, privateKey: otherEdPrivateKey } = crypto.generateKeyPairSync('ed25519');
  const otherPubPem = otherEdPublicKey.export({ type: 'spki', format: 'pem' }).toString();
  const otherPrivPem = otherEdPrivateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const TEST_KID = 'admin-ed25519-kid-1';
  const OTHER_KID = 'admin-ed25519-kid-other';

  let customReplayCache: InMemoryAdminSignatureReplayCache;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = SECRET;
    delete process.env.JWT_SECRET_PREVIOUS;

    // Reset public keys cache and populate environment
    resetAdminPubKeysCache();
    process.env.ADMIN_ED25519_PUBKEYS = JSON.stringify({
      [TEST_KID]: adminPubPem,
      [OTHER_KID]: otherPubPem,
    });

    customReplayCache = new InMemoryAdminSignatureReplayCache(300);
  });

  afterEach(() => {
    resetAdminPubKeysCache();
    delete process.env.ADMIN_ED25519_PUBKEYS;
  });

  interface MakeAdminSignedReqOptions {
    authHeader?: string;
    adminTokenPayload?: Record<string, unknown>;
    kid?: string;
    signature?: string;
    omitKid?: boolean;
    omitSignature?: boolean;
    body?: Partial<AdminSignedStatusTransitionPayload> | Record<string, unknown>;
    omitBody?: boolean;
    path?: string;
    params?: Record<string, string>;
    signWithKey?: string;
  }

  function makeAdminSignedReq(opts: MakeAdminSignedReqOptions = {}) {
    const adminToken = opts.authHeader !== undefined
      ? opts.authHeader
      : `Bearer ${makeJwtToken(opts.adminTokenPayload ?? { sub: 'admin-user-1', role: 'admin' }, SECRET)}`;

    const nowSec = Math.floor(Date.now() / 1000);
    const action = (opts.body?.action ?? 'approve') as AdminSignedStatusTransitionPayload['action'];
    const offeringId = (opts.body?.offeringId ?? 'offering-uuid-123') as string;
    const nonce = (opts.body?.nonce ?? 'unique-nonce-12345') as string;
    const timestamp = opts.body?.timestamp !== undefined ? (opts.body.timestamp as number) : nowSec;

    const payload: AdminSignedStatusTransitionPayload = {
      action,
      offeringId,
      nonce,
      timestamp,
      ...(opts.body ? (opts.body as Record<string, unknown>) : {}),
    } as AdminSignedStatusTransitionPayload;

    const signingKey = opts.signWithKey ?? adminPrivPem;
    const validSig = signAdminStatusTransition(payload, signingKey);

    const headers: Record<string, string> = {};
    if (adminToken) {
      headers.authorization = adminToken;
    }
    if (!opts.omitKid) {
      headers['x-admin-kid'] = opts.kid ?? TEST_KID;
    }
    if (!opts.omitSignature) {
      headers['x-admin-signature'] = opts.signature ?? validSig;
    }

    const req = {
      headers,
      header: (name: string) => headers[name.toLowerCase()],
      body: opts.omitBody ? undefined : payload,
      path: opts.path ?? `/api/v1/offerings/${offeringId}/approve`,
      params: opts.params ?? { id: offeringId },
    } as unknown as AuthenticatedRequest;

    return { req, payload };
  }

  // ── 1. Success Path ──────────────────────────────────────────────────────────
  describe('success path and AdminSignatureContext lifecycle', () => {
    it('sets req.adminSignature with full AdminSignatureContext and calls next() on valid signature', () => {
      const { req, payload } = makeAdminSignedReq();
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();

      // Assert req.user was populated
      expect(req.user).toEqual({
        sub: 'admin-user-1',
        id: 'admin-user-1',
        role: 'admin',
      });

      // Assert req.adminSignature was populated with exact AdminSignatureContext contract
      expect(req.adminSignature).toBeDefined();
      expect(req.adminSignature).toEqual<AdminSignatureContext>({
        kid: TEST_KID,
        action: 'approve',
        offeringId: payload.offeringId,
        nonce: payload.nonce,
        timestamp: payload.timestamp,
      });
    });

    it('attaches sessionToken to req.user when sid is present in JWT', () => {
      const { req } = makeAdminSignedReq({
        adminTokenPayload: { sub: 'admin-user-2', role: 'admin', sid: 'session-xyz-987' },
      });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect(req.user?.sessionToken).toBe('session-xyz-987');
      expect(req.adminSignature).toBeDefined();
    });

    it('verifies successfully when route path contains action segment as middle segment', () => {
      const offeringId = 'offering-uuid-middle';
      const { req } = makeAdminSignedReq({
        path: `/api/v1/offerings/${offeringId}/approve/confirm`,
        body: { offeringId },
        params: { id: offeringId },
      });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect(req.adminSignature).toBeDefined();
      expect(req.adminSignature?.action).toBe('approve');
    });

    it('accepts valid request when expectedAction matches signed action', () => {
      const { req } = makeAdminSignedReq({
        body: { action: 'reject' },
        path: '/api/v1/offerings/offering-uuid-123/reject',
      });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({
        replayCache: customReplayCache,
        expectedAction: 'reject',
      });
      middleware(req as Request, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect(req.adminSignature?.action).toBe('reject');
    });
  });

  // ── 2. Explicit Failure Paths: Bearer and Admin JWT ──────────────────────────
  describe('failure paths: Authorization header and JWT verification', () => {
    it('calls next with 401 and leaves req.adminSignature undefined when Authorization header is missing', () => {
      const { req } = makeAdminSignedReq({ authHeader: '' });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Missing or invalid Authorization header');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 401 and leaves req.adminSignature undefined when scheme is not Bearer', () => {
      const { req } = makeAdminSignedReq({ authHeader: 'Basic dXNlcjpwYXNz' });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Missing or invalid Authorization header');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 401 when admin token format is invalid (evidence: line 157)', () => {
      const { req } = makeAdminSignedReq({ authHeader: 'Bearer not-three-parts' });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Invalid or expired admin token');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 401 when admin token signature is invalid (evidence: line 180)', () => {
      const token = makeJwtToken({ sub: 'admin-1', role: 'admin' }, 'different-secret');
      const { req } = makeAdminSignedReq({ authHeader: `Bearer ${token}` });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Invalid or expired admin token');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 401 when admin token is expired (evidence: line 186)', () => {
      const pastExp = Math.floor(Date.now() / 1000) - 100;
      const token = makeJwtToken({ sub: 'admin-1', role: 'admin', exp: pastExp });
      const { req } = makeAdminSignedReq({ authHeader: `Bearer ${token}` });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Invalid or expired admin token');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 403 and leaves req.adminSignature undefined when JWT role is not admin', () => {
      const { req } = makeAdminSignedReq({ adminTokenPayload: { sub: 'user-1', role: 'investor' } });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 403);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Forbidden: admin role required');
      expect(req.adminSignature).toBeUndefined();
    });
  });

  // ── 3. Explicit Failure Paths: Signature Headers ─────────────────────────────
  describe('failure paths: Ed25519 signature headers', () => {
    it('calls next with 401 and leaves req.adminSignature undefined when x-admin-kid is missing', () => {
      const { req } = makeAdminSignedReq({ omitKid: true });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toContain('Missing required Ed25519 signature headers');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 401 and leaves req.adminSignature undefined when x-admin-signature is missing', () => {
      const { req } = makeAdminSignedReq({ omitSignature: true });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toContain('Missing required Ed25519 signature headers');
      expect(req.adminSignature).toBeUndefined();
    });
  });

  // ── 4. Explicit Failure Paths: Payload Field Validation ──────────────────────
  describe('failure paths: body fields validation', () => {
    it('calls next with 400 when body is omitted', () => {
      const { req } = makeAdminSignedReq({ omitBody: true });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 400);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Signed body missing required field: action');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 400 when action is non-string or missing', () => {
      const { req } = makeAdminSignedReq({ body: { action: undefined } });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 400);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Signed body missing required field: action');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 400 when offeringId is missing or non-string', () => {
      const { req } = makeAdminSignedReq({ body: { offeringId: '' } });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 400);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Signed body missing required field: offeringId');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 400 when nonce is missing or shorter than 8 chars', () => {
      const { req } = makeAdminSignedReq({ body: { nonce: 'short' } });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 400);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Signed body missing valid nonce (>=8 chars)');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 400 when timestamp is missing or not a finite number', () => {
      const { req } = makeAdminSignedReq({ body: { timestamp: 'not-a-number' as unknown as number } });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 400);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Signed body missing valid numeric Unix timestamp');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 400 when action is not in known action map', () => {
      const { req } = makeAdminSignedReq({ body: { action: 'unsupported_action' as unknown as AdminSignedStatusTransitionPayload['action'] } });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 400);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toContain('Invalid action. Must be one of:');
      expect(req.adminSignature).toBeUndefined();
    });
  });

  // ── 5. Explicit Failure Paths: Route and Expected Action Cross-Checking ──────
  describe('failure paths: route segment and expectedAction cross-checking', () => {
    it('calls next with 400 when expectedAction does not match signed action', () => {
      const { req } = makeAdminSignedReq({
        body: { action: 'reject' },
        path: '/api/v1/offerings/offering-uuid-123/reject',
      });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({
        replayCache: customReplayCache,
        expectedAction: 'approve',
      });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 400);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe(
        'Signed action "reject" does not match route expected action "approve"'
      );
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 400 when request route path does not match signed action segment', () => {
      const { req } = makeAdminSignedReq({
        body: { action: 'approve' },
        path: '/api/v1/offerings/offering-uuid-123/publish',
      });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 400);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe(
        'Signed action does not correspond to request route'
      );
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 400 when route param id does not match signed offeringId', () => {
      const { req } = makeAdminSignedReq({
        body: { offeringId: 'offering-uuid-123' },
        params: { id: 'offering-uuid-different' },
      });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 400);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe(
        'Signed offeringId does not match the route offering ID'
      );
      expect(req.adminSignature).toBeUndefined();
    });
  });

  // ── 6. Explicit Failure Paths: Timestamp Skew & Replay Cache ─────────────────
  describe('failure paths: timestamp clock-skew and replay protection', () => {
    it('calls next with 401 when timestamp is stale in the past beyond allowed skew', () => {
      const staleTs = Math.floor(Date.now() / 1000) - 60;
      const { req } = makeAdminSignedReq({ body: { timestamp: staleTs } });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe(
        'Request timestamp outside allowed clock-skew window'
      );
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 401 when timestamp is in the future beyond allowed skew', () => {
      const futureTs = Math.floor(Date.now() / 1000) + 60;
      const { req } = makeAdminSignedReq({ body: { timestamp: futureTs } });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe(
        'Request timestamp outside allowed clock-skew window'
      );
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 409 when nonce replay is detected within allowed window', () => {
      const { req, payload } = makeAdminSignedReq();
      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });

      // First call succeeds
      const next1: NextFunction = jest.fn();
      middleware(req as Request, mockRes(), next1);
      expect(next1).toHaveBeenCalledWith();
      expect(req.adminSignature).toBeDefined();

      // Second call with same (kid, nonce, timestamp) fails with 409
      const req2 = {
        headers: { ...req.headers },
        header: req.header,
        body: payload,
        path: req.path,
        params: req.params,
      } as unknown as AuthenticatedRequest;
      const next2: NextFunction = jest.fn();
      middleware(req2 as Request, mockRes(), next2);

      expectAppError(next2 as unknown as jest.Mock, 409);
      expect((next2 as unknown as jest.Mock).mock.calls[0][0].message).toBe(
        'Replay detected: nonce already used within the allowed window'
      );
      expect(req2.adminSignature).toBeUndefined();
    });
  });

  // ── 7. Explicit Failure Paths: Keys and Ed25519 Verification ─────────────────
  describe('failure paths: public keys availability and cryptographic verification', () => {
    it('calls next with 500 when admin public keys are unavailable (config error)', () => {
      // Clear env and reset cache
      delete process.env.ADMIN_ED25519_PUBKEYS;
      resetAdminPubKeysCache();

      const { req } = makeAdminSignedReq();
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 500);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe(
        'Server configuration error: admin public keys unavailable'
      );
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 401 when kid is unknown', () => {
      const { req } = makeAdminSignedReq({ kid: 'unknown-nonexistent-kid' });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Unknown admin key identifier');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 401 when Ed25519 signature was signed with a different private key', () => {
      // Signed with otherPrivPem, but headers specify TEST_KID (which has adminPubPem)
      const { req } = makeAdminSignedReq({
        kid: TEST_KID,
        signWithKey: otherPrivPem,
      });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect((next as unknown as jest.Mock).mock.calls[0][0].message).toBe('Invalid Ed25519 signature');
      expect(req.adminSignature).toBeUndefined();
    });

    it('calls next with 401 when Ed25519 signature string is malformed', () => {
      const { req } = makeAdminSignedReq({
        signature: 'not-a-valid-base64url-signature',
      });
      const next: NextFunction = jest.fn();

      const middleware = requireAdminWithEd25519Signature({ replayCache: customReplayCache });
      middleware(req as Request, mockRes(), next);

      expectAppError(next as unknown as jest.Mock, 401);
      expect(req.adminSignature).toBeUndefined();
    });
  });
});