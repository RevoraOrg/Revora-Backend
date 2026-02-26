import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { authMiddleware, verifyJwt, requireInvestor, AuthenticatedRequest } from './auth';
import { requireAuth } from './requireAuth';
import { signJwt } from '../utils/jwt';
import { issueToken } from '../lib/jwt';
import { AuthenticatedRequest as LogoutAuthenticatedRequest } from '../auth/logout/types';

// ── Shared secret setup ───────────────────────────────────────────────────────
beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough-32chars!';
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const SECRET = process.env.JWT_SECRET ?? 'test-secret-that-is-long-enough-32chars!';

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

// ── requireAuth (feature/change-password-api) ─────────────────────────────────
describe('requireAuth middleware', () => {
  const mockNext: NextFunction = jest.fn();

  const makeReq = (authHeader?: string): LogoutAuthenticatedRequest =>
    ({ headers: authHeader ? { authorization: authHeader } : {} }) as LogoutAuthenticatedRequest;

  beforeEach(() => jest.clearAllMocks());

  it('calls next() and sets req.auth for a valid token', () => {
    const token = signJwt({ sub: 'user-123', sid: 'session-abc' });
    const req = makeReq(`Bearer ${token}`);

    requireAuth(req as Request, mockRes(), mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(req.auth?.userId).toBe('user-123');
    expect(req.auth?.sessionId).toBe('session-abc');
    expect(req.auth?.tokenId).toBe(token);
  });

  it('returns 401 when Authorization header is missing', () => {
    const req = makeReq();
    const res = mockRes();

    requireAuth(req as Request, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('returns 401 when the header is not Bearer scheme', () => {
    const req = makeReq('Basic dXNlcjpwYXNz');
    const res = mockRes();

    requireAuth(req as Request, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid/tampered token', () => {
    const req = makeReq('Bearer invalid.token.here');
    const res = mockRes();

    requireAuth(req as Request, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('returns 401 for an expired token', () => {
    const token = signJwt({ sub: 'user-123', sid: 'session-abc' }, -1);
    const req = makeReq(`Bearer ${token}`);
    const res = mockRes();

    requireAuth(req as Request, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });
});

// ── authMiddleware (master — JWT factory fn) ──────────────────────────────────
describe('authMiddleware', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('valid token', () => {
    it('attaches user to request with valid token', () => {
      const token = issueToken({ subject: 'user-123', email: 'test@example.com' });
      const req = { headers: { authorization: `Bearer ${token}` } } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(next).toHaveBeenCalled();
      expect((req as AuthenticatedRequest).user?.sub).toBe('user-123');
      expect((req as AuthenticatedRequest).user?.email).toBe('test@example.com');
    });

    it('works with token containing only sub', () => {
      const token = issueToken({ subject: 'user-456' });
      const req = { headers: { authorization: `Bearer ${token}` } } as Request;
      const next = jest.fn();

      authMiddleware()(req, mockRes(), next);

      expect(next).toHaveBeenCalled();
      expect((req as AuthenticatedRequest).user?.sub).toBe('user-456');
    });
  });

  describe('missing token', () => {
    it('returns 401 when Authorization header is missing', () => {
      const req = { headers: {} } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Unauthorized',
        message: 'Authorization header missing',
      });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('invalid token', () => {
    it('returns 401 with invalid token format', () => {
      const req = { headers: { authorization: 'InvalidFormat token123' } } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 with malformed token', () => {
      const req = { headers: { authorization: 'Bearer not-a-valid-jwt' } } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 with wrong secret', () => {
      const req = {
        headers: {
          authorization:
            'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImlhdCI6MTcwMDAwMDAwMH0.invalid',
        },
      } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('expired token', () => {
    it('returns 401 with expired token', () => {
      const token = issueToken({ subject: 'user-123', expiresIn: '-1s' });
      const req = { headers: { authorization: `Bearer ${token}` } } as Request;
      const res = mockRes();
      const next = jest.fn();

      authMiddleware()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });
});

// ── verifyJwt ─────────────────────────────────────────────────────────────────
describe('verifyJwt', () => {
  it('decodes a valid token', () => {
    const token = makeJwtToken({ sub: 'user-1', role: 'investor' });
    const payload = verifyJwt(token, SECRET);
    expect(payload.sub).toBe('user-1');
    expect(payload.role).toBe('investor');
  });

  it('throws on a malformed token', () => {
    expect(() => verifyJwt('not.a.valid.token', SECRET)).toThrow('Invalid token format');
  });

  it('throws on wrong secret', () => {
    const token = makeJwtToken({ sub: 'user-1', role: 'investor' });
    expect(() => verifyJwt(token, 'wrong-secret')).toThrow('Invalid token signature');
  });

  it('throws on an expired token', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 60;
    const token = makeJwtToken({ sub: 'user-1', role: 'investor', exp: pastExp });
    expect(() => verifyJwt(token, SECRET)).toThrow('Token expired');
  });

  it('accepts a token with a future expiry', () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeJwtToken({ sub: 'user-1', role: 'investor', exp: futureExp });
    expect(verifyJwt(token, SECRET).sub).toBe('user-1');
  });
});

// ── requireInvestor ───────────────────────────────────────────────────────────
describe('requireInvestor', () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => { process.env.JWT_SECRET = SECRET; });
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

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as AuthenticatedRequest).user).toEqual({ id: 'investor-1', role: 'investor' });
  });

  it('returns 401 when Authorization header is missing', () => {
    const res = mockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(makeReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for Basic auth', () => {
    const res = mockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(makeReq('Basic some-credentials'), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid token', () => {
    const res = mockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(makeReq('Bearer invalid.token.here'), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-investor role', () => {
    const token = makeJwtToken({ sub: 'admin-1', role: 'admin' });
    const res = mockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(makeReq(`Bearer ${token}`), res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 when JWT_SECRET is not set', () => {
    delete process.env.JWT_SECRET;
    const token = makeJwtToken({ sub: 'investor-1', role: 'investor' });
    const res = mockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(makeReq(`Bearer ${token}`), res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});