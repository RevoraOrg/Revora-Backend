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
  });
});
