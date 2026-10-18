/**
 * Regression suite for createCorsMiddleware — issue #1054
 *
 * Exercises every named throw path in cors.ts and the surrounding
 * normal-path and boundary inputs so that silent behavior changes are
 * caught immediately.
 *
 * Evidence lines under test:
 *   cors.ts:40  throw new Error("ALLOWED_ORIGINS must be configured in production environment")
 *   cors.ts:50  throw new Error("CORS configuration error: Wildcard origin '*' is not allowed when credentials are true")
 */

import express, { Request, Response } from "express";
import request from "supertest";
import { createCorsMiddleware } from "./cors";

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock("../lib/logger", () => ({
  globalLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../config/env", () => ({
  env: {
    ALLOWED_ORIGINS: "",
    ALLOWED_ORIGINS_ARRAY: [] as string[],
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

interface AppOptions {
  allowedOrigins?: string[];
  corsAllowNoOrigin?: string;
  nodeEnv?: string;
}

/**
 * Builds a minimal Express app with the CORS middleware applied.
 * Mutates the jest mock so cors.ts reads the supplied values.
 */
function makeApp(opts: AppOptions = {}) {
  const mockEnv = jest.requireMock("../config/env");
  mockEnv.env.ALLOWED_ORIGINS_ARRAY = opts.allowedOrigins ?? [];

  if (opts.corsAllowNoOrigin !== undefined) {
    process.env.CORS_ALLOW_NO_ORIGIN = opts.corsAllowNoOrigin;
  } else {
    delete process.env.CORS_ALLOW_NO_ORIGIN;
  }

  if (opts.nodeEnv !== undefined) {
    process.env.NODE_ENV = opts.nodeEnv;
  }

  const app = express();
  app.use(createCorsMiddleware());
  app.get("/ping", (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

const originalEnv = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

// ─────────────────────────────────────────────────────────────────────────────
// FAILURE PATH 1 — cors.ts:40
// Production environment with no allowed origins must throw.
// ─────────────────────────────────────────────────────────────────────────────

describe("Failure path: production with empty ALLOWED_ORIGINS_ARRAY (cors.ts:40)", () => {
  it("throws the exact sentinel message when NODE_ENV=production and origins are empty", () => {
    expect(() =>
      makeApp({ nodeEnv: "production", allowedOrigins: [] })
    ).toThrow(
      "ALLOWED_ORIGINS must be configured in production environment"
    );
  });

  it("throws when origins array is explicitly undefined-like (empty after filtering)", () => {
    expect(() =>
      makeApp({ nodeEnv: "production", allowedOrigins: [] })
    ).toThrow(Error);
  });

  it("error is an instance of Error (not a string throw)", () => {
    let caught: unknown;
    try {
      makeApp({ nodeEnv: "production", allowedOrigins: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it("logs a structured security event before throwing", () => {
    const { globalLogger } = jest.requireMock("../lib/logger");
    try {
      makeApp({ nodeEnv: "production", allowedOrigins: [] });
    } catch {
      // expected
    }
    expect(globalLogger.error).toHaveBeenCalledTimes(1);
    const [, meta] = globalLogger.error.mock.calls[0];
    expect(meta).toMatchObject({ securityEvent: "cors_config_error" });
  });

  it("does NOT throw in development with empty origins", () => {
    expect(() =>
      makeApp({ nodeEnv: "development", allowedOrigins: [] })
    ).not.toThrow();
  });

  it("does NOT throw in test environment with empty origins", () => {
    expect(() =>
      makeApp({ nodeEnv: "test", allowedOrigins: [] })
    ).not.toThrow();
  });

  it("does NOT throw in production when at least one origin is configured", () => {
    expect(() =>
      makeApp({
        nodeEnv: "production",
        allowedOrigins: ["https://app.example.com"],
      })
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FAILURE PATH 2 — cors.ts:50
// Wildcard '*' must never be accepted regardless of environment.
// ─────────────────────────────────────────────────────────────────────────────

describe("Failure path: wildcard origin '*' in ALLOWED_ORIGINS_ARRAY (cors.ts:50)", () => {
  it("throws the exact sentinel message when '*' is the only origin", () => {
    expect(() =>
      makeApp({ allowedOrigins: ["*"] })
    ).toThrow(
      "CORS configuration error: Wildcard origin '*' is not allowed when credentials are true"
    );
  });

  it("throws when '*' is mixed with legitimate origins", () => {
    expect(() =>
      makeApp({ allowedOrigins: ["https://app.example.com", "*"] })
    ).toThrow(
      "CORS configuration error: Wildcard origin '*' is not allowed when credentials are true"
    );
  });

  it("throws even in development when '*' is present", () => {
    expect(() =>
      makeApp({ nodeEnv: "development", allowedOrigins: ["*"] })
    ).toThrow();
  });

  it("throws even in production when '*' is present (wildcard check precedes origin-count check? verify order)", () => {
    // In cors.ts the production-empty check fires first (line 33–42),
    // then the wildcard check (line 44–51). With '*' present the array
    // is non-empty so the production check passes and the wildcard check
    // fires.
    expect(() =>
      makeApp({ nodeEnv: "production", allowedOrigins: ["*"] })
    ).toThrow(
      "CORS configuration error: Wildcard origin '*' is not allowed when credentials are true"
    );
  });

  it("error is an instance of Error", () => {
    let caught: unknown;
    try {
      makeApp({ allowedOrigins: ["*"] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it("logs a structured security event before throwing", () => {
    const { globalLogger } = jest.requireMock("../lib/logger");
    try {
      makeApp({ allowedOrigins: ["*"] });
    } catch {
      // expected
    }
    expect(globalLogger.error).toHaveBeenCalledTimes(1);
    const [, meta] = globalLogger.error.mock.calls[0];
    expect(meta).toMatchObject({ securityEvent: "cors_config_error" });
  });

  it("does NOT throw for a legitimate non-wildcard single origin", () => {
    expect(() =>
      makeApp({ allowedOrigins: ["https://app.example.com"] })
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SUCCESS PATH — normal operation after valid configuration
// ─────────────────────────────────────────────────────────────────────────────

describe("Success path: valid configuration returns functioning middleware", () => {
  it("returns a function (Express middleware) when configuration is valid", () => {
    const middleware = makeApp({ allowedOrigins: ["https://app.example.com"] });
    expect(middleware).toBeDefined();
  });

  it("allows a preflight from a listed origin and echoes it back", async () => {
    const app = makeApp({ allowedOrigins: ["https://app.example.com"] });

    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com"
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("allows an actual GET from a listed origin", async () => {
    const app = makeApp({ allowedOrigins: ["https://app.example.com"] });

    const res = await request(app)
      .get("/ping")
      .set("Origin", "https://app.example.com");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com"
    );
  });

  it("logs an info message on successful middleware initialisation", () => {
    const { globalLogger } = jest.requireMock("../lib/logger");
    makeApp({ allowedOrigins: ["https://app.example.com"] });
    expect(globalLogger.info).toHaveBeenCalledWith(
      "CORS middleware initialized",
      expect.objectContaining({ allowedOriginsCount: 1 })
    );
  });

  it("sets credentials: true on all allowed-origin responses", async () => {
    const app = makeApp({
      allowedOrigins: ["https://app.example.com", "https://admin.example.com"],
    });

    for (const origin of [
      "https://app.example.com",
      "https://admin.example.com",
    ]) {
      const res = await request(app).get("/ping").set("Origin", origin);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BOUNDARY INPUTS
// ─────────────────────────────────────────────────────────────────────────────

describe("Boundary inputs: origin validation edge cases", () => {
  it("denies an origin not in the allowlist", async () => {
    const app = makeApp({ allowedOrigins: ["https://app.example.com"] });

    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://evil.com")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("denies a request with no origin when CORS_ALLOW_NO_ORIGIN is unset", async () => {
    const app = makeApp({ allowedOrigins: ["https://app.example.com"] });

    const res = await request(app)
      .options("/ping")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows a request with no origin when CORS_ALLOW_NO_ORIGIN=true", async () => {
    const app = makeApp({
      allowedOrigins: ["https://app.example.com"],
      corsAllowNoOrigin: "true",
    });

    const res = await request(app).get("/ping");
    expect(res.status).toBe(200);
  });

  it("denies a request with no origin when CORS_ALLOW_NO_ORIGIN=false", async () => {
    const app = makeApp({
      allowedOrigins: ["https://app.example.com"],
      corsAllowNoOrigin: "false",
    });

    const res = await request(app)
      .options("/ping")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("is case-sensitive: mixed-case origin is denied even if lower-case is listed", async () => {
    const app = makeApp({ allowedOrigins: ["https://app.example.com"] });

    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://APP.EXAMPLE.COM")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("handles a large allowlist and still matches correctly", async () => {
    const origins = Array.from(
      { length: 50 },
      (_, i) => `https://tenant-${i}.example.com`
    );
    const app = makeApp({ allowedOrigins: origins });

    // last origin in the list should be allowed
    const target = origins[origins.length - 1];
    const res = await request(app)
      .get("/ping")
      .set("Origin", target);

    expect(res.headers["access-control-allow-origin"]).toBe(target);
  });

  it("denies a subdomain not explicitly listed", async () => {
    const app = makeApp({ allowedOrigins: ["https://app.example.com"] });

    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://sub.app.example.com")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("denies an origin that is a prefix of a listed origin", async () => {
    const app = makeApp({ allowedOrigins: ["https://app.example.com"] });

    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://app.example.co")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("exposes X-Request-Id header on allowed-origin responses", async () => {
    const app = makeApp({ allowedOrigins: ["https://app.example.com"] });

    const res = await request(app)
      .get("/ping")
      .set("Origin", "https://app.example.com");

    expect(res.headers["access-control-expose-headers"]).toContain(
      "X-Request-Id"
    );
  });

  it("preflight max-age is set to 86400 (24 h)", async () => {
    const app = makeApp({ allowedOrigins: ["https://app.example.com"] });

    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-max-age"]).toBe("86400");
  });

  it("all documented HTTP methods appear in preflight allow-methods", async () => {
    const app = makeApp({ allowedOrigins: ["https://app.example.com"] });

    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "DELETE");

    const methods = res.headers["access-control-allow-methods"] ?? "";
    for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(methods).toContain(m);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT PRESERVATION
// Public contract of createCorsMiddleware must remain stable.
// ─────────────────────────────────────────────────────────────────────────────

describe("Contract preservation: createCorsMiddleware public interface", () => {
  it("is exported as a named function", () => {
    expect(typeof createCorsMiddleware).toBe("function");
  });

  it("returns a value (the cors handler) when called with valid config", () => {
    const result = makeApp({ allowedOrigins: ["https://app.example.com"] });
    // makeApp wraps the middleware in an express app; verify the app exists
    expect(result).toBeTruthy();
  });

  it("throws synchronously — callers must guard with try/catch at startup", () => {
    // The throw must be synchronous so app startup aborts immediately
    let threw = false;
    try {
      makeApp({ nodeEnv: "production", allowedOrigins: [] });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("throws synchronously for wildcard — callers must guard at startup", () => {
    let threw = false;
    try {
      makeApp({ allowedOrigins: ["*"] });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
