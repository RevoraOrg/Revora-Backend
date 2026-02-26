// Set up test JWT_SECRET before importing jwt module
process.env.JWT_SECRET = "test-secret-key-that-is-at-least-32-characters-long!";

import {
  issueToken,
  verifyToken,
  decodePayload,
  issueRefreshToken,
  getJwtSecret,
  getJwtAlgorithm,
  TOKEN_EXPIRY,
  REFRESH_TOKEN_EXPIRY,
  JwtPayload,
  TokenOptions,
} from "./jwt";

describe("jwt utilities", () => {
  describe("getJwtSecret", () => {
    it("should return JWT_SECRET from environment", () => {
      expect(getJwtSecret()).toBe(
        "test-secret-key-that-is-at-least-32-characters-long!",
      );
    });

    it("should throw error when JWT_SECRET is not set", () => {
      delete process.env.JWT_SECRET;
      expect(() => getJwtSecret()).toThrow(
        "JWT_SECRET environment variable is not set",
      );
    });

    it("should throw error when JWT_SECRET is too short", () => {
      process.env.JWT_SECRET = "short";
      expect(() => getJwtSecret()).toThrow(
        "JWT_SECRET must be at least 32 characters for security",
      );
    });
  });

  describe("getJwtAlgorithm", () => {
    it("should return HS256 algorithm", () => {
      expect(getJwtAlgorithm()).toBe("HS256");
    });
  });

  describe("issueToken", () => {
    it("should issue a valid JWT token", () => {
      const token = issueToken({subject: "user-123"});

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.split(".")).toHaveLength(3); // JWT has 3 parts
    });

    it("should include subject in token payload", () => {
      const token = issueToken({subject: "user-456"});
      const payload = decodePayload(token);

      expect(payload?.sub).toBe("user-456");
    });

    it("should include additional payload data", () => {
      const options: TokenOptions = {
        subject: "user-789",
        additionalPayload: {
          email: "test@example.com",
          role: "admin",
        },
      };

      const token = issueToken(options);
      const payload = decodePayload(token);

      expect(payload?.sub).toBe("user-789");
      expect(payload?.email).toBe("test@example.com");
      expect(payload?.role).toBe("admin");
    });

    it("should use default expiry of 1 hour", () => {
      const token = issueToken({subject: "user-123"});
      const payload = decodePayload(token);

      expect(payload?.exp).toBeDefined();
      // exp - iat should be approximately 3600 seconds (1 hour)
      expect(payload!.exp! - payload!.iat!).toBeCloseTo(3600, 0);
    });

    it("should use custom expiry when provided", () => {
      const token = issueToken({
        subject: "user-123",
        expiresIn: "30m",
      });
      const payload = decodePayload(token);

      expect(payload?.exp).toBeDefined();
      // exp - iat should be approximately 1800 seconds (30 minutes)
      expect(payload!.exp! - payload!.iat!).toBeCloseTo(1800, 0);
    });
  });

  describe("verifyToken", () => {
    it("should verify valid token and return payload", () => {
      const token = issueToken({
        subject: "user-123",
        email: "test@example.com",
      });

      const payload = verifyToken(token);

      expect(payload.sub).toBe("user-123");
      expect(payload.email).toBe("test@example.com");
    });

    it("should throw on invalid token", () => {
      expect(() => verifyToken("invalid-token")).toThrow();
    });

    it("should throw on expired token", () => {
      const expiredToken = issueToken({
        subject: "user-123",
        expiresIn: "-1s",
      });

      expect(() => verifyToken(expiredToken)).toThrow("Token has expired");
    });

    it("should throw on token with wrong secret", () => {
      const token = issueToken({subject: "user-123"});

      // Modify the token payload to make signature invalid
      const parts = token.split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64").toString());
      payload.sub = "different-user";
      const modifiedPayload = Buffer.from(JSON.stringify(payload)).toString(
        "base64url",
      );
      const modifiedToken = `${parts[0]}.${modifiedPayload}.${parts[2]}`;

      expect(() => verifyToken(modifiedToken)).toThrow();
    });
  });

  describe("decodePayload", () => {
    it("should decode valid token without verification", () => {
      const token = issueToken({subject: "user-123"});

      const payload = decodePayload(token);

      expect(payload?.sub).toBe("user-123");
    });

    it("should return null for invalid token", () => {
      const payload = decodePayload("invalid-token");

      expect(payload).toBeNull();
    });

    it("should decode expired token (without verification)", () => {
      const expiredToken = issueToken({
        subject: "user-123",
        expiresIn: "-1s",
      });

      const payload = decodePayload(expiredToken);

      // decode doesn't verify, so it should still decode
      expect(payload?.sub).toBe("user-123");
    });
  });

  describe("issueRefreshToken", () => {
    it("should issue refresh token with 7 day expiry", () => {
      const token = issueRefreshToken("user-123");

      const payload = decodePayload(token);

      expect(payload?.sub).toBe("user-123");
      // 7 days = 604800 seconds
      expect(payload!.exp! - payload!.iat!).toBeCloseTo(604800, 0);
    });
  });

  describe("TOKEN_EXPIRY and REFRESH_TOKEN_EXPIRY", () => {
    it("should have correct default values", () => {
      expect(TOKEN_EXPIRY).toBe("1h");
      expect(REFRESH_TOKEN_EXPIRY).toBe("7d");
    });
  });
});
