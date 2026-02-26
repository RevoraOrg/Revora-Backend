import { Request, Response, NextFunction } from 'express';
import { requireAuth } from './auth';
import { signJwt } from '../utils/jwt';
import { AuthenticatedRequest } from '../auth/logout/types';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
});

const mockRes = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
};

const mockNext: NextFunction = jest.fn();

const makeReq = (authHeader?: string): AuthenticatedRequest =>
  ({
    headers: authHeader ? { authorization: authHeader } : {},
  }) as AuthenticatedRequest;

describe('requireAuth middleware', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls next() and sets req.auth for a valid token', () => {
    const token = signJwt({ sub: 'user-123', sid: 'session-abc' });
    const req = makeReq(`Bearer ${token}`);
    const res = mockRes();

    requireAuth(req as Request, res, mockNext);

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