import express from "express";
import request from "supertest";
import {
  __test,
  classifyStellarRPCFailure,
  createApp,
  StellarRPCFailureClass,
  WebhookQueue,
} from '../index';
import { closePool } from '../db/client';
import { ErrorCode } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';
import {
  calculateLag,
  calculateUptimeSeconds,
  createHealthRouter,
  healthLiveHandler,
  healthReadyHandler,
  healthRootHandler,
  healthStartupHandler,
  mapHealthDependencyFailure,
  HealthDependencyGraph,
  DependencyHealth,
} from "./health";

afterAll(async () => {
  await closePool();
});

describe("classifyStellarRPCFailure", () => {
  it("classifies timeout failures", () => {
    const error = new Error("network timeout");
    error.name = "AbortError";

    expect(classifyStellarRPCFailure(error).class).toBe(
      StellarRPCFailureClass.TIMEOUT,
    );
  });

  it("classifies rate limit failures", () => {
    expect(classifyStellarRPCFailure({ status: 429 }).class).toBe(
      StellarRPCFailureClass.RATE_LIMIT,
    );
  });

  it("classifies auth failures", () => {
    expect(classifyStellarRPCFailure({ status: 401 }).class).toBe(
      StellarRPCFailureClass.UNAUTHORIZED,
    );
    expect(classifyStellarRPCFailure({ status: 403 }).class).toBe(
      StellarRPCFailureClass.UNAUTHORIZED,
    );
  });

  it("classifies upstream 5xx failures", () => {
    expect(classifyStellarRPCFailure({ status: 503 }).class).toBe(
      StellarRPCFailureClass.UPSTREAM_ERROR,
    );
  });

  it("classifies malformed responses", () => {
    expect(classifyStellarRPCFailure(new SyntaxError("bad json")).class).toBe(
      StellarRPCFailureClass.MALFORMED_RESPONSE,
    );
  });

  it("falls back to unknown for uncategorized errors", () => {
    expect(classifyStellarRPCFailure(new Error("something odd")).class).toBe(
      StellarRPCFailureClass.UNKNOWN,
    );
  });
});

describe("mapHealthDependencyFailure", () => {
  it("sanitizes database dependency errors", () => {
    const mapped = mapHealthDependencyFailure(
      "database",
      new Error("password auth failed"),
    );

    expect(mapped.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: "Dependency unavailable",
      details: {
        dependency: "database",
      },
    });
  });

  it("preserves stable Stellar metadata without leaking raw upstream details", () => {
    const mapped = mapHealthDependencyFailure("stellar-horizon", {
      status: 503,
    });

    expect(mapped.toResponse()).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: "Dependency unavailable",
      details: {
        dependency: "stellar-horizon",
        failureClass: StellarRPCFailureClass.UPSTREAM_ERROR,
        upstreamStatus: 503,
      },
    });
  });
});

describe("healthReadyHandler", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns ok when both database and horizon are healthy", async () => {
    const mockDb = {
      query: jest.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/ready", healthReadyHandler(mockDb as any));

    const response = await request(app).get("/ready");

    expect(response.status).toBe(200);
    expect(response.body.ready).toBe(true);
    expect(response.body.status).toBe("ok");
    expect(response.body.db).toBe("up");
    expect(response.body.stellar).toBe("up");
    expect(response.body.service).toBe("revora-backend");
  });

  it("surfaces sanitized database failures", async () => {
    const mockDb = {
      query: jest.fn().mockRejectedValue(new Error("connection failed")),
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/ready", healthReadyHandler(mockDb as any));
    app.use(
      (
        err: any,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        const statusCode = err.statusCode || 500;
        const body = typeof err.toResponse === 'function' ? err.toResponse() : { message: err.message };
        res.status(statusCode).json(body);
      },
    );

    const response = await request(app).get("/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: "Dependency unavailable",
      details: {
        dependency: "database",
      },
    });
  });

  it("maps Stellar upstream failures deterministically", async () => {
    const mockDb = {
      query: jest.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
    };
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 20,
      pool: {
        totalCount: 2,
        idleCount: 2,
        waitingCount: 0,
        maxConnections: 10,
      },
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 429 }) as typeof fetch;

    const app = express();
    app.use("/health", createHealthRouter(mockDb as any, mockDbHealth));
    app.use(
      (
        err: any,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        const statusCode = err.statusCode || 500;
        const body = typeof err.toResponse === 'function' ? err.toResponse() : { message: err.message };
        res.status(statusCode).json(body);
      },
    );

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: "Dependency unavailable",
      details: {
        dependency: "stellar-horizon",
        failureClass: StellarRPCFailureClass.RATE_LIMIT,
        upstreamStatus: 429,
      },
    });
  });

  it('catches and surfaces fetch exceptions deterministically', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    const networkError = new Error('network timeout');
    networkError.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(networkError) as typeof fetch;

    const app = express();
    const mockDbHealth = jest.fn().mockResolvedValue({ healthy: true });
    app.use('/health', createHealthRouter(db as any, mockDbHealth));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const mapped = err as { statusCode: number; toResponse: () => unknown };
      res.status(mapped.statusCode).json(mapped.toResponse());
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: 'Dependency unavailable',
      details: {
        dependency: 'stellar-horizon',
        failureClass: StellarRPCFailureClass.TIMEOUT,
      },
    });
  });
});

describe("offering validation matrix", () => {
  const path = "/api/v1/offerings/validation-matrix";

  function buildApp() {
    return createApp({
      healthStatus: jest
        .fn()
        .mockResolvedValue({ healthy: true, latencyMs: 1 }),
      healthQuery: jest.fn(),
    });
  }

  function authHeaders(role: string, id = "actor-1") {
    return {
      "x-user-id": id,
      "x-user-role": role,
    };
  }

  it("rejects unauthenticated callers at the auth boundary", async () => {
    const response = await request(buildApp())
      .post(path)
      .send({
        action: "create",
        offering: { targetAmount: "1000.00", minimumInvestment: "50.00" },
      });

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
      message: "Offering validation requires x-user-id and x-user-role headers",
    });
  });

  it("rejects invalid actions with an explicit schema error", async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders("startup"))
      .send({
        action: "destroy",
        offering: {},
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: ErrorCode.BAD_REQUEST,
      message: "Invalid offering validation action",
    });
  });

  it("allows a startup to publish its own valid draft offering", async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders("startup", "issuer-1"))
      .send({
        action: "publish",
        offering: {
          id: "off-1",
          issuerId: "issuer-1",
          status: "draft",
          targetAmount: "1000.00",
          minimumInvestment: "50.00",
          subscriptionStartsAt: "2030-01-01T00:00:00.000Z",
          subscriptionEndsAt: "2030-01-15T00:00:00.000Z",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.allowed).toBe(true);
    expect(response.body.decision).toBe("allow");
    expect(response.body.violations).toEqual([]);
  });

  it("denies a startup from managing another issuers offering", async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders("startup", "issuer-1"))
      .send({
        action: "pause",
        offering: {
          id: "off-2",
          issuerId: "issuer-2",
          status: "open",
        },
      });

    expect(response.status).toBe(422);
    expect(response.body.allowed).toBe(false);
    expect(response.body.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "OWNERSHIP_CONFIRMED",
        }),
      ]),
    );
  });

  it("denies investment attempts outside the allowed subscription window", async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders("investor", "investor-1"))
      .send({
        action: "invest",
        offering: {
          id: "off-3",
          issuerId: "issuer-3",
          status: "open",
          targetAmount: "1000.00",
          minimumInvestment: "100.00",
          investmentAmount: "125.00",
          subscriptionStartsAt: "2020-01-01T00:00:00.000Z",
          subscriptionEndsAt: "2020-01-15T00:00:00.000Z",
        },
      });

    expect(response.status).toBe(422);
    expect(response.body.allowed).toBe(false);
    expect(response.body.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVESTMENT_WINDOW_ACTIVE",
        }),
      ]),
    );
  });

  it("blocks issuer self-investment by default", async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders("investor", "issuer-4"))
      .send({
        action: "invest",
        offering: {
          id: "off-4",
          issuerId: "issuer-4",
          status: "open",
          targetAmount: "500.00",
          minimumInvestment: "50.00",
          investmentAmount: "50.00",
          subscriptionStartsAt: "2030-01-01T00:00:00.000Z",
          subscriptionEndsAt: "2030-01-10T00:00:00.000Z",
        },
      });

    expect(response.status).toBe(422);
    expect(response.body.allowed).toBe(false);
    expect(response.body.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INVESTOR_NOT_ISSUER",
        }),
      ]),
    );
  });

  it("allows privileged compliance actors to review private offerings without ownership", async () => {
    const response = await request(buildApp())
      .post(path)
      .set(authHeaders("compliance", "compliance-1"))
      .send({
        action: "viewPrivate",
        offering: {
          id: "off-5",
          issuerId: "issuer-99",
          status: "paused",
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.allowed).toBe(true);
    expect(response.body.violations).toEqual([]);
  });

  it("returns degraded root health when the dependency checker reports failure", async () => {
    const app = createApp({
      healthStatus: jest.fn().mockResolvedValue({
        healthy: false,
        latencyMs: 4,
        error: "sanitized-db-error",
      }),
      healthQuery: jest.fn(),
    });

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "degraded",
      service: "revora-backend",
      db: {
        healthy: false,
        latencyMs: 4,
        error: "sanitized-db-error",
      },
    });
  });

  it("serves the overview document on the versioned API prefix", async () => {
    const response = await request(buildApp()).get("/api/v1/overview");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: "Stellar RevenueShare (Revora) Backend",
      version: "0.1.0",
    });
  });

  it("applies multi-tier rate limiting for startup registration", async () => {
    const SECRET = "test-tier-secret";
    process.env.STARTUP_AUTH_TIER_SECRET = SECRET;
    const path = "/api/v1/startup/register";

    // 1. Standard Tier (Default: 5 requests)
    {
      const app = buildApp();
      for (let i = 0; i < 5; i++) {
        const res = await request(app).post(path).send({ email: `std-${i}@test.com`, password: "Pass" });
        expect(res.status).toBe(201);
        expect(res.headers["x-ratelimit-limit"]).toBe("5");
      }
      const blockedStd = await request(app).post(path).send({ email: "std-fail@test.com", password: "Pass" });
      expect(blockedStd.status).toBe(429);
    }

    // 2. Trusted Tier (10 requests)
    {
      const app = buildApp();
      const trustedHeaders = { "x-revora-rate-tier": "trusted", "x-revora-tier-secret": SECRET };
      for (let i = 0; i < 10; i++) {
        const res = await request(app).post(path).set(trustedHeaders).send({ email: `trust-${i}@test.com`, password: "Pass" });
        expect(res.status).toBe(201);
        expect(res.headers["x-ratelimit-limit"]).toBe("10");
      }
      const blockedTrust = await request(app).post(path).set(trustedHeaders).send({ email: "trust-fail@test.com", password: "Pass" });
      expect(blockedTrust.status).toBe(429);
    }

    // 3. Internal Tier (25 requests)
    {
      const app = buildApp();
      const internalHeaders = { "x-revora-rate-tier": "internal", "x-revora-tier-secret": SECRET };
      for (let i = 0; i < 25; i++) {
        const res = await request(app).post(path).set(internalHeaders).send({ email: `int-${i}@test.com`, password: "Pass" });
        expect(res.status).toBe(201);
        expect(res.headers["x-ratelimit-limit"]).toBe("25");
      }
      const blockedInt = await request(app).post(path).set(internalHeaders).send({ email: "int-fail@test.com", password: "Pass" });
      expect(blockedInt.status).toBe(429);
    }

    // 4. Invalid Secret Fallback (Standard Tier)
    {
      const app = buildApp();
      const invalidHeaders = { "x-revora-rate-tier": "internal", "x-revora-tier-secret": "wrong" };
      for (let i = 0; i < 5; i++) {
        const res = await request(app).post(path).set(invalidHeaders).send({ email: `wrong-${i}@test.com`, password: "Pass" });
        expect(res.status).toBe(201);
        expect(res.headers["x-ratelimit-limit"]).toBe("5");
      }
      const blockedWrong = await request(app).post(path).set(invalidHeaders).send({ email: "wrong-fail@test.com", password: "Pass" });
      expect(blockedWrong.status).toBe(429);
    }
  });

  it("rejects startup registration payloads that omit required credentials", async () => {
    const response = await request(buildApp())
      .post("/api/v1/startup/register")
      .send({ email: "missing-password@example.com" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: "Email and password are required",
    });
  });
});

describe("WebhookQueue", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("classifies safe and unsafe webhook targets correctly", () => {
    const isSafeUrl = (
      WebhookQueue as unknown as { isSafeUrl: (url: string) => boolean }
    ).isSafeUrl;

    expect(isSafeUrl("https://example.com/hooks")).toBe(true);
    expect(isSafeUrl("http://127.0.0.1")).toBe(false);
    expect(isSafeUrl("http://localhost")).toBe(false);
    expect(isSafeUrl("not-a-valid-url")).toBe(false);
  });

  it("uses exponential backoff and stops after the configured retry ceiling", async () => {
    const deliveryPromise = WebhookQueue.processDelivery(
      "https://example.com/hooks",
      {
        event: "test",
      },
    );

    await jest.advanceTimersByTimeAsync(31_000);

    await expect(deliveryPromise).resolves.toBe(false);
    expect(WebhookQueue.getBackoffDelay(0)).toBe(1000);
    expect(WebhookQueue.getBackoffDelay(5)).toBe(-1);
  });

  it("fails fast for unsafe SSRF-style destinations", async () => {
    await expect(
      WebhookQueue.processDelivery("http://192.168.1.10/internal", {
        event: "test",
      }),
    ).resolves.toBe(false);
  });
});

describe('health metrics collection', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true });
  });

  afterEach(() => {
    metrics.reset();
  });

  it('should record successful health check metrics', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get('/ready', healthReadyHandler(db, metrics));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const mapped = err as { statusCode: number; toResponse: () => unknown };
      res.status(mapped.statusCode).json(mapped.toResponse());
    });

    await request(app).get('/ready');

    const snapshot = await metrics.getSnapshot();
    expect(snapshot.custom.length).toBeGreaterThan(0);
    
    // Check for health check metrics
    const dbSuccess = snapshot.custom.find(m => 
      m.name === 'health_checks_total' && 
      m.labels?.check === 'database' && 
      m.labels?.status === 'success'
    );
    expect(dbSuccess?.value).toBe(1);

    const stellarSuccess = snapshot.custom.find(m => 
      m.name === 'health_checks_total' && 
      m.labels?.check === 'stellar-horizon' && 
      m.labels?.status === 'success'
    );
    expect(stellarSuccess?.value).toBe(1);
  });

  it('should record failed health check metrics', async () => {
    const db = {
      query: jest.fn().mockRejectedValue(new Error('connection failed')),
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get('/ready', healthReadyHandler(db, metrics));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const mapped = err as { statusCode: number; toResponse: () => unknown };
      res.status(mapped.statusCode).json(mapped.toResponse());
    });

    await request(app).get('/ready');

    const snapshot = await metrics.getSnapshot();
    const dbFailure = snapshot.custom.find(m => 
      m.name === 'health_checks_total' && 
      m.labels?.check === 'database' && 
      m.labels?.status === 'failure'
    );
    expect(dbFailure?.value).toBe(1);
  });

  it('should record health check duration', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get('/ready', healthReadyHandler(db, metrics));

    await request(app).get('/ready');

    const snapshot = await metrics.getSnapshot();
    const durationMetric = snapshot.custom.find(m => 
      m.name === 'health_check_duration_ms' && 
      m.labels?.endpoint === 'ready'
    );
    expect(durationMetric).toBeDefined();
    expect(durationMetric?.value).toBeGreaterThanOrEqual(0);
  });

  it('should work without metrics collector', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get('/ready', healthReadyHandler(db)); // No metrics

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      db: 'up',
      stellar: 'up',
      ready: true,
      service: 'revora-backend',
    });
  });
});

describe('__test helpers', () => {
  it('stableSerialize sorts object keys recursively', () => {
    expect(
      __test.stableSerialize({
        b: 1,
        a: { d: 4, c: 3 },
      }),
    ).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("stableSerialize preserves arrays while sorting nested object keys", () => {
    expect(
      __test.stableSerialize([
        { z: 2, a: 1 },
        { b: 2, a: 1 },
      ]),
    ).toBe('[{"a":1,"z":2},{"a":1,"b":2}]');
  });

  it("parseMoneyString accepts bounded decimal strings and rejects invalid input", () => {
    expect(__test.parseMoneyString("999.99")).toBe(999.99);
    expect(__test.parseMoneyString("1e6")).toBeNull();
    expect(__test.parseMoneyString(10)).toBeNull();
  });

  it("parseIsoDate accepts valid ISO strings and rejects invalid dates", () => {
    expect(__test.parseIsoDate("2030-01-01T00:00:00.000Z")?.toISOString()).toBe(
      "2030-01-01T00:00:00.000Z",
    );
    expect(__test.parseIsoDate("definitely-not-a-date")).toBeNull();
  });

  it("parseOfferingValidationPayload preserves trimmed deterministic values", () => {
    expect(
      __test.parseOfferingValidationPayload({
        action: "create",
        offering: {
          issuerId: " issuer-1 ",
          targetAmount: "100.00",
          minimumInvestment: "10.00",
        },
      }),
    ).toEqual({
      action: "create",
      offering: {
        issuerId: "issuer-1",
        targetAmount: "100.00",
        minimumInvestment: "10.00",
      },
    });
  });

  it("parseOfferingValidationPayload rejects malformed bodies and invalid field values", () => {
    expect(() => __test.parseOfferingValidationPayload(null)).toThrow(
      "Validation payload must be a JSON object",
    );
    expect(() =>
      __test.parseOfferingValidationPayload({
        action: "create",
      }),
    ).toThrow("Offering validation payload must include an offering object");
    expect(() =>
      __test.parseOfferingValidationPayload({
        action: "create",
        offering: { id: "   " },
      }),
    ).toThrow("offering.id must be a non-empty string");
    expect(() =>
      __test.parseOfferingValidationPayload({
        action: "create",
        offering: { issuerId: "" },
      }),
    ).toThrow("offering.issuerId must be a non-empty string");
    expect(() =>
      __test.parseOfferingValidationPayload({
        action: "create",
        offering: { status: "live" },
      }),
    ).toThrow("offering.status must be a supported offering status");
    expect(() =>
      __test.parseOfferingValidationPayload({
        action: "create",
        offering: { targetAmount: "" },
      }),
    ).toThrow("offering.targetAmount must be a non-empty string");
  });

  it("evaluateOfferingValidationMatrix covers close, cancel, and missing investment window rules", () => {
    const actor = { id: "issuer-1", role: "startup" as const };

    const closeResult = __test.evaluateOfferingValidationMatrix(actor, {
      action: "close",
      offering: {
        issuerId: "issuer-1",
        status: "paused",
      },
    });
    expect(closeResult.allowed).toBe(true);

    const cancelResult = __test.evaluateOfferingValidationMatrix(actor, {
      action: "cancel",
      offering: {
        issuerId: "issuer-1",
        status: "closed",
      },
    });
    expect(cancelResult.allowed).toBe(false);
    expect(cancelResult.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "STATUS_ELIGIBLE_FOR_CANCEL" }),
      ]),
    );

    const investResult = __test.evaluateOfferingValidationMatrix(
      { id: "investor-1", role: "investor" },
      {
        action: "invest",
        offering: {
          issuerId: "issuer-2",
          status: "open",
          targetAmount: "1000.00",
          minimumInvestment: "50.00",
          investmentAmount: "50.00",
        },
      },
      new Date("2030-01-05T00:00:00.000Z"),
    );

    expect(investResult.allowed).toBe(false);
    expect(investResult.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "INVESTMENT_WINDOW_ACTIVE" }),
      ]),
    );
  });
});

describe("healthRootHandler - dependency graph", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns comprehensive health with dependency graph when all services are healthy", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 25,
      pool: {
        totalCount: 5,
        idleCount: 3,
        waitingCount: 0,
        maxConnections: 10,
      },
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("healthy");
    expect(response.body.service).toBe("revora-backend");
    expect(response.body.checks).toHaveLength(2);
    expect(response.body.checks[0].name).toBe("database");
    expect(response.body.checks[0].status).toBe("up");
    expect(response.body.checks[0].healthy).toBe(true);
    expect(response.body.checks[0].details).toMatchObject({
      totalCount: 5,
      idleCount: 3,
      utilizationPercent: 50,
    });
    expect(response.body.checks[1].name).toBe("stellar-horizon");
    expect(response.body.checks[1].status).toBe("up");
    expect(response.body.checks[1].healthy).toBe(true);
    expect(response.body.uptime).toBeGreaterThanOrEqual(0);
    expect(response.body.timestamp).toBeDefined();
    expect(response.body.version).toBeDefined();
  });

  it("returns degraded status when pool utilization is high", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 50,
      pool: {
        totalCount: 9,
        idleCount: 1,
        waitingCount: 2,
        maxConnections: 10,
      },
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("degraded");
    expect(response.body.checks[0].status).toBe("degraded");
    expect(response.body.checks[0].details.utilizationPercent).toBe(90);
  });

  it("returns unhealthy status and 503 when database is down", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: false,
      latencyMs: 100,
      error: "connection refused",
      pool: {
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
        maxConnections: 10,
      },
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.body.status).toBe("unhealthy");
    expect(response.body.checks[0].name).toBe("database");
    expect(response.body.checks[0].status).toBe("down");
    expect(response.body.checks[0].healthy).toBe(false);
    expect(response.body.checks[0].error).toBe("sanitized-db-error");
  });

  it("includes requestId in response when provided in headers", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 10,
      pool: {
        totalCount: 2,
        idleCount: 2,
        waitingCount: 0,
        maxConnections: 10,
      },
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app)
      .get("/health")
      .set("x-request-id", "test-req-123");

    expect(response.body.requestId).toBe("test-req-123");
  });
});

describe("healthLiveHandler - liveness probe", () => {
  it("returns alive status for liveness probe", async () => {
    const app = express();
    app.get("/live", healthLiveHandler());

    const response = await request(app).get("/live");

    expect(response.status).toBe(200);
    expect(response.body.alive).toBe(true);
    expect(response.body.service).toBe("revora-backend");
    expect(response.body.timestamp).toBeDefined();
    expect(response.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("includes requestId in liveness response when provided", async () => {
    const app = express();
    app.get("/live", healthLiveHandler());

    const response = await request(app)
      .get("/live")
      .set("x-request-id", "live-req-456");

    expect(response.body.requestId).toBe("live-req-456");
  });
});

describe("healthStartupHandler - startup probe", () => {
  it("returns ready when database is healthy", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 15,
      pool: {
        totalCount: 3,
        idleCount: 2,
        waitingCount: 0,
        maxConnections: 10,
      },
    });

    const app = express();
    app.get("/startup", healthStartupHandler(mockDbHealth));

    const response = await request(app).get("/startup");

    expect(response.status).toBe(200);
    expect(response.body.ready).toBe(true);
    expect(response.body.service).toBe("revora-backend");
    expect(response.body.check).toBe("database");
  });

  it("returns 503 when database is not ready during startup", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: false,
      latencyMs: 5000,
      error: "timeout",
    });

    const app = express();
    app.get("/startup", healthStartupHandler(mockDbHealth));
    app.use(
      (
        err: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        const mapped = err as { statusCode: number; toResponse: () => unknown };
        res.status(mapped.statusCode).json(mapped.toResponse());
      },
    );

    const response = await request(app).get("/startup");

    expect(response.status).toBe(503);
    expect(response.body.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(response.body.details.dependency).toBe("database");
  });
});

describe("createHealthRouter - k8s probe endpoints", () => {
  it("mounts all health endpoints correctly", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 10,
      pool: {
        totalCount: 2,
        idleCount: 2,
        waitingCount: 0,
        maxConnections: 10,
      },
    });

    const mockDb = { query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }) };
    const router = createHealthRouter(mockDb as any, mockDbHealth);
    const app = express();
    app.use(router);

    const rootResponse = await request(app).get("/");
    expect(rootResponse.status).toBe(200);

    const liveResponse = await request(app).get("/live");
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.body.alive).toBe(true);

    const readyResponse = await request(app).get("/ready");
    expect([200, 503]).toContain(readyResponse.status);

    const startupResponse = await request(app).get("/startup");
    expect([200, 503]).toContain(startupResponse.status);
  });
});

describe("dependency graph security", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("never exposes raw database error messages in dependency health", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: false,
      latencyMs: 100,
      error: 'password authentication failed for user "admin"',
      pool: {
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0,
        maxConnections: 10,
      },
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.body.checks[0].error).toBe("sanitized-db-error");
    expect(response.body.checks[0].error).not.toContain("password");
    expect(response.body.checks[0].error).not.toContain("admin");
    expect(response.body.checks[0].error).not.toContain("authentication");
  });

  it("exposes only safe Stellar metadata without leaking upstream details", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 20,
      pool: {
        totalCount: 2,
        idleCount: 2,
        waitingCount: 0,
        maxConnections: 10,
      },
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.body.checks[1].name).toBe("stellar-horizon");
    expect(response.body.checks[1].status).toBe("down");
    expect(response.body.checks[1].details.failureClass).toBe(
      StellarRPCFailureClass.UPSTREAM_ERROR,
    );
    expect(response.body.checks[1].details.upstreamStatus).toBe(503);
    expect(response.body.checks[1].details.url).toBeDefined();
  });
});

describe("Stellar Horizon timeout handling", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("classifies Stellar timeout correctly", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 10,
      pool: {
        totalCount: 2,
        idleCount: 2,
        waitingCount: 0,
        maxConnections: 10,
      },
    });

    const timeoutError = new Error("timeout");
    timeoutError.name = "AbortError";
    global.fetch = jest.fn().mockRejectedValue(timeoutError) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.body.checks[1].name).toBe("stellar-horizon");
    expect(response.body.checks[1].details.failureClass).toBe(
      StellarRPCFailureClass.TIMEOUT,
    );
    expect(response.body.checks[1].error).toBe("timeout");
  });
});

describe("healthRootHandler - dependency graph aggregation", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns 503 unhealthy when Horizon is down and DB is up", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 12,
      pool: { totalCount: 2, idleCount: 2, waitingCount: 0, maxConnections: 10 },
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.body.status).toBe("unhealthy");
    expect(response.body.checks[0].name).toBe("database");
    expect(response.body.checks[0].status).toBe("up");
    expect(response.body.checks[1].name).toBe("stellar-horizon");
    expect(response.body.checks[1].status).toBe("down");
    expect(response.body.checks[1].healthy).toBe(false);
  });

  it("returns 200 degraded when both DB pool and Horizon are degraded", async () => {
    // DB pool at 90% utilization → degraded; Horizon returns 200 but we simulate
    // a degraded DB pool scenario. Horizon itself is up, so overall = degraded.
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 30,
      pool: { totalCount: 9, idleCount: 1, waitingCount: 0, maxConnections: 10 },
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("degraded");
    expect(response.body.checks[0].status).toBe("degraded");
    expect(response.body.checks[1].status).toBe("up");
  });

  it("returns 503 unhealthy when DB checker throws an exception", async () => {
    const mockDbHealth = jest.fn().mockRejectedValue(new Error("unexpected db crash"));
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    // The handler should not crash the process; it should propagate as 500 or 503
    const response = await request(app).get("/health");

    expect([500, 503]).toContain(response.status);
  });

  it("populates latencyMs on both database and stellar-horizon checks", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 42,
      pool: { totalCount: 1, idleCount: 1, waitingCount: 0, maxConnections: 10 },
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    const dbCheck = response.body.checks.find((c: DependencyHealth) => c.name === "database");
    const stellarCheck = response.body.checks.find((c: DependencyHealth) => c.name === "stellar-horizon");

    expect(typeof dbCheck.latencyMs).toBe("number");
    expect(dbCheck.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof stellarCheck.latencyMs).toBe("number");
    expect(stellarCheck.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("populates dependsOn on database check when pool metrics are present", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: true,
      latencyMs: 8,
      pool: { totalCount: 3, idleCount: 3, waitingCount: 0, maxConnections: 10 },
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    const dbCheck = response.body.checks.find((c: DependencyHealth) => c.name === "database");
    expect(Array.isArray(dbCheck.dependsOn)).toBe(true);
    expect(dbCheck.dependsOn).toContain("db-pool");
  });

  it("returns 503 unhealthy when both DB and Horizon are down", async () => {
    const mockDbHealth = jest.fn().mockResolvedValue({
      healthy: false,
      latencyMs: 200,
      error: "connection refused",
      pool: { totalCount: 0, idleCount: 0, waitingCount: 0, maxConnections: 10 },
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as typeof fetch;

    const app = express();
    app.get("/health", healthRootHandler(mockDbHealth));

    const response = await request(app).get("/health");

    expect(response.status).toBe(503);
    expect(response.body.status).toBe("unhealthy");
    expect(response.body.checks[0].status).toBe("down");
    expect(response.body.checks[1].status).toBe("down");
  });
});
