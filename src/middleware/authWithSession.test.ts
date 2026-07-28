import { Request, Response, NextFunction } from 'express';
import { Errors } from '../lib/errors';

// Mock dependencies
const mockVerifyToken = jest.fn();
const mockIsSessionExpired = jest.fn();

jest.mock('../lib/jwt', () => ({
  verifyToken: (...args: any[]) => mockVerifyToken(...args),
}));

jest.mock('../auth/session', () => ({
  isSessionExpired: (...args: any[]) => mockIsSessionExpired(...args),
}));

jest.mock('../lib/logger', () => ({
  globalLogger: {
    warn: jest.fn(),
    error: jest.fn(),
    critical: jest.fn(),
    info: jest.fn(),
  },
}));

describe('authWithSession middleware', () => {
  let mockSessionRepository: any;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let next: NextFunction;
  let middleware: any;

  beforeEach(() => {
    // Re-require the middleware to ensure it uses the fresh mocks
    const { createRequireAuthWithSession } = require('./authWithSession');
    
    mockSessionRepository = {
      findById: jest.fn(),
    };
    middleware = createRequireAuthWithSession(mockSessionRepository);
    
    mockReq = {
      headers: {},
      path: '/test',
      method: 'GET',
      ip: '127.0.0.1',
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('should call next() for a valid token and session', async () => {
    mockReq.headers!.authorization = 'Bearer valid-token';
    const mockPayload = { sub: 'user-123', sid: 'session-456', role: 'investor' };
    mockVerifyToken.mockReturnValue(mockPayload);
    
    const mockSession = {
      id: 'session-456',
      user_id: 'user-123',
      expires_at: new Date(Date.now() + 10000),
      revoked_at: null,
    };
    mockSessionRepository.findById.mockResolvedValue(mockSession);
    mockIsSessionExpired.mockReturnValue(false);

    await middleware(mockReq as Request, mockRes as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect((mockReq as any).auth).toEqual({
      userId: 'user-123',
      sessionId: 'session-456',
      role: 'investor',
    });
  });

  it('should return 401 if Authorization header is missing', async () => {
    await middleware(mockReq as Request, mockRes as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Missing or invalid token',
    }));
  });

  it('should return 401 if Authorization header does not start with Bearer', async () => {
    mockReq.headers!.authorization = 'Basic some-auth';
    await middleware(mockReq as Request, mockRes as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Missing or invalid token',
    }));
  });

  it('should return 401 if token is missing session identifier', async () => {
    mockReq.headers!.authorization = 'Bearer token-without-sid';
    mockVerifyToken.mockReturnValue({ sub: 'user-123' });

    await middleware(mockReq as Request, mockRes as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Invalid token payload: missing session identifier',
    }));
  });

  it('should return 401 if session is not found in database', async () => {
    mockReq.headers!.authorization = 'Bearer valid-token';
    mockVerifyToken.mockReturnValue({ sub: 'user-123', sid: 'non-existent' });
    mockSessionRepository.findById.mockResolvedValue(null);

    await middleware(mockReq as Request, mockRes as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Session not found',
    }));
  });

  it('should return 401 if session is revoked', async () => {
    mockReq.headers!.authorization = 'Bearer valid-token';
    mockVerifyToken.mockReturnValue({ sub: 'user-123', sid: 'revoked-session' });
    mockSessionRepository.findById.mockResolvedValue({
      id: 'revoked-session',
      revoked_at: new Date(),
    });

    await middleware(mockReq as Request, mockRes as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Session has been revoked',
    }));
  });

  it('should return 401 if session is expired', async () => {
    mockReq.headers!.authorization = 'Bearer valid-token';
    mockVerifyToken.mockReturnValue({ sub: 'user-123', sid: 'expired-session' });
    mockSessionRepository.findById.mockResolvedValue({
      id: 'expired-session',
      expires_at: new Date(Date.now() - 10000),
    });
    mockIsSessionExpired.mockReturnValue(true);

    await middleware(mockReq as Request, mockRes as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Session has expired',
    }));
  });

  it('should return 401 if token verification fails', async () => {
    mockReq.headers!.authorization = 'Bearer invalid-token';
    mockVerifyToken.mockImplementation(() => {
      throw new Error('Invalid token');
    });

    await middleware(mockReq as Request, mockRes as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Invalid or expired token',
    }));
  });

  it('should return 401 if token verification fails with non-Error value', async () => {
    mockReq.headers!.authorization = 'Bearer invalid-token';
    mockVerifyToken.mockImplementation(() => {
      throw 'Not an Error object';
    });

    await middleware(mockReq as Request, mockRes as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      statusCode: 401,
      message: 'Invalid or expired token',
    }));
  });
});
