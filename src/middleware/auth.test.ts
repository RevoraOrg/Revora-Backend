import {Request, Response, NextFunction} from "express";
import {authMiddleware, AuthenticatedRequest} from "./auth";
import {issueToken, getJwtSecret, getJwtAlgorithm} from "../lib/jwt";

// Set up test JWT_SECRET before importing auth middleware
process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-characters-long!";

describe("authMiddleware", () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonSpy: jest.SpyInstance;
  let statusSpy: jest.SpyInstance;

  beforeEach(() => {
    mockReq = {
      headers: {},
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
    jsonSpy = jest.spyOn(mockRes, "json");
    statusSpy = jest.spyOn(mockRes, "status");
  });

  describe("valid token", () => {
    it("should attach user to request with valid token", () => {
      const token = issueToken({
        subject: "user-123",
        email: "test@example.com",
      });
      mockReq.headers = {authorization: `Bearer ${token}`};

      const middleware = authMiddleware();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      const req = mockReq as AuthenticatedRequest;
      expect(req.user?.sub).toBe("user-123");
      expect(req.user?.email).toBe("test@example.com");
      expect(statusSpy).not.toHaveBeenCalledWith(401);
    });

    it("should work with token containing only sub", () => {
      const token = issueToken({subject: "user-456"});
      mockReq.headers = {authorization: `Bearer ${token}`};

      const middleware = authMiddleware();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      const req = mockReq as AuthenticatedRequest;
      expect(req.user?.sub).toBe("user-456");
    });
  });

  describe("missing token", () => {
    it("should return 401 when Authorization header is missing", () => {
      mockReq.headers = {};

      const middleware = authMiddleware();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(jsonSpy).toHaveBeenCalledWith({
        error: "Unauthorized",
        message: "Authorization header missing",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 when Authorization header is empty", () => {
      mockReq.headers = {authorization: ""};

      const middleware = authMiddleware();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe("invalid token", () => {
    it("should return 401 with invalid token format", () => {
      mockReq.headers = {authorization: "InvalidFormat token123"};

      const middleware = authMiddleware();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(jsonSpy).toHaveBeenCalledWith({
        error: "Unauthorized",
        message:
          "Invalid authorization header format. Expected: Bearer <token>",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 with Basic auth instead of Bearer", () => {
      mockReq.headers = {authorization: "Basic dXNlcjpwYXNz"};

      const middleware = authMiddleware();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 with malformed token", () => {
      mockReq.headers = {authorization: "Bearer not-a-valid-jwt"};

      const middleware = authMiddleware();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(jsonSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          error: "Unauthorized",
        }),
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("should return 401 with wrong secret", () => {
      // Create token with different secret
      const wrongSecretToken =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImlhdCI6MTcwMDAwMDAwMH0.invalid";
      mockReq.headers = {authorization: `Bearer ${wrongSecretToken}`};

      const middleware = authMiddleware();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(jsonSpy).toHaveBeenCalledWith({
        error: "Unauthorized",
        message: "Invalid token signature",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe("expired token", () => {
    it("should return 401 with expired token", () => {
      // Create an expired token
      const expiredToken = issueToken({
        subject: "user-123",
        expiresIn: "-1s", // Expired 1 second ago
      });

      mockReq.headers = {authorization: `Bearer ${expiredToken}`};

      const middleware = authMiddleware();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(statusSpy).toHaveBeenCalledWith(401);
      expect(jsonSpy).toHaveBeenCalledWith({
        error: "Unauthorized",
        message: "Token has expired",
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });
});

describe("authMiddleware integration with requestLog", () => {
  it("should work with requestLog middleware pattern", () => {
    const token = issueToken({subject: "user-789"});

    const mockReq = {
      headers: {authorization: `Bearer ${token}`},
      method: "GET",
      path: "/api/test",
      ip: "127.0.0.1",
      get: jest.fn().mockReturnValue("TestAgent"),
    } as unknown as Request;

    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      end: jest.fn(),
    } as unknown as Response;

    const mockNext = jest.fn();

    const middleware = authMiddleware();
    middleware(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect((mockReq as AuthenticatedRequest).user?.sub).toBe("user-789");
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { verifyJwt, requireInvestor, AuthenticatedRequest } from './auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'test-secret';

function makeToken(
  payload: Record<string, unknown>,
  secret: string = SECRET
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString(
    'base64url'
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function makeMockRes(): jest.Mocked<Response> {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Response>;
  return res;
}

// ---------------------------------------------------------------------------
// verifyJwt
// ---------------------------------------------------------------------------

describe('verifyJwt', () => {
  it('should decode a valid token', () => {
    const token = makeToken({ sub: 'user-1', role: 'investor' });
    const payload = verifyJwt(token, SECRET);
    expect(payload.sub).toBe('user-1');
    expect(payload.role).toBe('investor');
  });

  it('should throw on a malformed token', () => {
    expect(() => verifyJwt('not.a.valid.token', SECRET)).toThrow(
      'Invalid token format'
    );
  });

  it('should throw on wrong secret', () => {
    const token = makeToken({ sub: 'user-1', role: 'investor' });
    expect(() => verifyJwt(token, 'wrong-secret')).toThrow(
      'Invalid token signature'
    );
  });

  it('should throw on an expired token', () => {
    const pastExp = Math.floor(Date.now() / 1000) - 60;
    const token = makeToken({ sub: 'user-1', role: 'investor', exp: pastExp });
    expect(() => verifyJwt(token, SECRET)).toThrow('Token expired');
  });

  it('should accept a token with a future expiry', () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeToken({ sub: 'user-1', role: 'investor', exp: futureExp });
    const payload = verifyJwt(token, SECRET);
    expect(payload.sub).toBe('user-1');
  });
});

// ---------------------------------------------------------------------------
// requireInvestor middleware
// ---------------------------------------------------------------------------

describe('requireInvestor', () => {
  const originalSecret = process.env['JWT_SECRET'];

  beforeEach(() => {
    process.env['JWT_SECRET'] = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env['JWT_SECRET'];
    } else {
      process.env['JWT_SECRET'] = originalSecret;
    }
  });

  function makeReq(authHeader?: string): Request {
    return {
      headers: authHeader ? { authorization: authHeader } : {},
    } as unknown as Request;
  }

  it('should call next() for a valid investor token', () => {
    const token = makeToken({ sub: 'investor-1', role: 'investor' });
    const req = makeReq(`Bearer ${token}`);
    const res = makeMockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as AuthenticatedRequest).user).toEqual({
      id: 'investor-1',
      role: 'investor',
    });
  });

  it('should return 401 when Authorization header is missing', () => {
    const req = makeReq();
    const res = makeMockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 when Authorization header does not start with Bearer', () => {
    const req = makeReq('Basic some-credentials');
    const res = makeMockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 for an invalid token', () => {
    const req = makeReq('Bearer invalid.token.here');
    const res = makeMockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 403 for a non-investor role', () => {
    const token = makeToken({ sub: 'admin-1', role: 'admin' });
    const req = makeReq(`Bearer ${token}`);
    const res = makeMockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 500 when JWT_SECRET is not set', () => {
    delete process.env['JWT_SECRET'];
    const token = makeToken({ sub: 'investor-1', role: 'investor' });
    const req = makeReq(`Bearer ${token}`);
    const res = makeMockRes();
    const next: NextFunction = jest.fn();

    requireInvestor(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(next).not.toHaveBeenCalled();
  });
});
