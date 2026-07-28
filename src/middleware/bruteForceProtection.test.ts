import { NextFunction, Request, Response } from "express";
import {
  createRateTierMiddleware,
  createStartupAuthBruteForceProtection,
  RateTiers,
} from "./bruteForceProtection";
import { InMemoryRateLimitStore } from "./rateLimit";

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let payload: unknown;

  const res: any = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    getHeader: jest.fn((k: string) => headers[k.toLowerCase()]),
    status: jest.fn(function (code: number) {
      statusCode = code;
      return res;
    }),
    json: jest.fn(function (data: unknown) {
      payload = data;
      return res;
    }),
    get statusCode() {
      return statusCode;
    },
    get payload() {
      return payload;
    },
    get headers() {
      return headers;
    },
  };

  return res as unknown as Response & {
    statusCode: number;
    payload: unknown;
    headers: Record<string, string>;
  };
}

describe("RateTiers", () => {
  it("defines AUTH tier with strict limits", () => {
    expect(RateTiers.AUTH.limit).toBe(5);
    expect(RateTiers.AUTH.windowMs).toBe(15 * 60 * 1000);
    expect(RateTiers.AUTH.description).toBe("Authentication attempts");
  });

  it("defines STANDARD tier for general API usage", () => {
    expect(RateTiers.STANDARD.limit).toBe(100);
    expect(RateTiers.STANDARD.windowMs).toBe(60 * 1000);
    expect(RateTiers.STANDARD.description).toBe("Standard API requests");
  });

  it("defines HIGH_VOLUME tier for authenticated users", () => {
    expect(RateTiers.HIGH_VOLUME.limit).toBe(1000);
    expect(RateTiers.HIGH_VOLUME.windowMs).toBe(60 * 1000);
    expect(RateTiers.HIGH_VOLUME.description).toBe("High-volume requests");
  });
});

describe("createStartupAuthBruteForceProtection", () => {
  it("passes through when under the limit", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createStartupAuthBruteForceProtection({ store });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
    expect(res.headers["x-ratelimit-remaining"]).toBe("4");
    expect(res.statusCode).toBe(200);
  });

  it("blocks when limit is exceeded", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createStartupAuthBruteForceProtection({ store });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    // Make 6 requests (limit is 5)
    for (let i = 0; i < 6; i++) {
      mw(req, res, next);
    }

    expect(next).toHaveBeenCalledTimes(6); // All 6 calls go through (5 allowed + 1 error)
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    // The last call should pass an error to next()
    const lastCallError = next.mock.calls[5][0];
    expect(lastCallError).toBeDefined();
    expect(lastCallError.httpCode).toBe(429);
  });

  it("uses custom tier when provided", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createStartupAuthBruteForceProtection({
      tier: RateTiers.STANDARD,
      store,
    });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);

    expect(res.headers["x-ratelimit-limit"]).toBe("100");
    expect(res.headers["x-ratelimit-remaining"]).toBe("99");
  });

  it("tracks different IPs independently", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createStartupAuthBruteForceProtection({ store });
    const nextA: NextFunction = jest.fn();
    const nextB: NextFunction = jest.fn();

    const reqA = makeReq({ ip: "1.1.1.1" });
    const reqB = makeReq({ ip: "2.2.2.2" });

    // IP A makes 6 requests (over limit)
    for (let i = 0; i < 6; i++) {
      mw(reqA, makeRes(), nextA);
    }

    // IP B makes 1 request (should be allowed)
    mw(reqB, makeRes(), nextB);

    expect(nextA).toHaveBeenCalledTimes(6); // 5 allowed + 1 error
    expect(nextB).toHaveBeenCalledTimes(1);
  });

  it("sets Retry-After header when limit exceeded", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createStartupAuthBruteForceProtection({ store });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    // Exceed limit
    for (let i = 0; i < 6; i++) {
      mw(req, res, next);
    }

    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("uses custom key prefix when provided", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createStartupAuthBruteForceProtection({
      keyPrefix: "custom_prefix",
      store,
    });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);

    // Should not interfere with default prefix
    const defaultMw = createStartupAuthBruteForceProtection({ store });
    const next2: NextFunction = jest.fn();
    defaultMw(req, makeRes(), next2);

    expect(next2).toHaveBeenCalledTimes(1); // Should still be allowed
  });

  it("uses custom message when provided", () => {
    const store = new InMemoryRateLimitStore();
    const customMessage = "Custom rate limit message";
    const mw = createStartupAuthBruteForceProtection({
      message: customMessage,
      store,
    });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    // Exceed limit
    for (let i = 0; i < 6; i++) {
      mw(req, res, next);
    }

    const lastCallError = next.mock.calls[5][0];
    expect(lastCallError).toBeDefined();
    expect(lastCallError.message).toBe(customMessage);
  });

  it("handles requests without IP address", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createStartupAuthBruteForceProtection({ store });
    const req = makeReq({
      ip: undefined,
      socket: { remoteAddress: undefined },
    });
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
    expect(res.headers["x-ratelimit-remaining"]).toBe("4");
  });
});

describe("createRateTierMiddleware", () => {
  it("passes through when under the limit", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateTierMiddleware(RateTiers.STANDARD, { store });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers["x-ratelimit-limit"]).toBe("100");
    expect(res.headers["x-ratelimit-remaining"]).toBe("99");
  });

  it("blocks when limit is exceeded", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateTierMiddleware(RateTiers.STANDARD, { store });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    // Make 101 requests (limit is 100)
    for (let i = 0; i < 101; i++) {
      mw(req, res, next);
    }

    expect(next).toHaveBeenCalledTimes(101); // 100 allowed + 1 error
    const lastCallError = next.mock.calls[100][0];
    expect(lastCallError).toBeDefined();
    expect(lastCallError.httpCode).toBe(429);
  });

  it("uses user ID when authenticated", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateTierMiddleware(RateTiers.HIGH_VOLUME, { store });
    const req = makeReq({ user: { sub: "user-123" } } as any);
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers["x-ratelimit-limit"]).toBe("1000");
  });

  it("tracks different users independently", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateTierMiddleware(RateTiers.STANDARD, { store });
    const nextA: NextFunction = jest.fn();
    const nextB: NextFunction = jest.fn();

    const reqA = makeReq({ user: { sub: "user-a" } } as any);
    const reqB = makeReq({ user: { sub: "user-b" } } as any);

    // User A makes 101 requests (over limit)
    for (let i = 0; i < 101; i++) {
      mw(reqA, makeRes(), nextA);
    }

    // User B makes 1 request (should be allowed)
    mw(reqB, makeRes(), nextB);

    expect(nextA).toHaveBeenCalledTimes(101); // 100 allowed + 1 error
    expect(nextB).toHaveBeenCalledTimes(1);
  });

  it("sets X-RateLimit-Tier header", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateTierMiddleware(RateTiers.HIGH_VOLUME, { store });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);

    expect(res.headers["x-ratelimit-tier"]).toBe("High-volume requests");
  });

  it("uses custom key prefix when provided", () => {
    const store = new InMemoryRateLimitStore();
    const mw = createRateTierMiddleware(RateTiers.STANDARD, {
      keyPrefix: "custom_tier",
      store,
    });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    mw(req, res, next);

    // Should not interfere with default prefix
    const defaultMw = createRateTierMiddleware(RateTiers.STANDARD, { store });
    const next2: NextFunction = jest.fn();
    defaultMw(req, makeRes(), next2);

    expect(next2).toHaveBeenCalledTimes(1);
  });

  it("uses custom message when provided", () => {
    const store = new InMemoryRateLimitStore();
    const customMessage = "Custom tier limit message";
    const mw = createRateTierMiddleware(RateTiers.STANDARD, {
      message: customMessage,
      store,
    });
    const req = makeReq();
    const res = makeRes();
    const next: NextFunction = jest.fn();

    // Exceed limit
    for (let i = 0; i < 101; i++) {
      mw(req, res, next);
    }

    const lastCallError = next.mock.calls[100][0];
    expect(lastCallError).toBeDefined();
    expect(lastCallError.message).toBe(customMessage);
  });

  it("isolates counters by tier", () => {
    const store = new InMemoryRateLimitStore();
    const standardMw = createRateTierMiddleware(RateTiers.STANDARD, { store });
    const highVolumeMw = createRateTierMiddleware(RateTiers.HIGH_VOLUME, {
      store,
    });

    const req = makeReq();
    const nextStandard: NextFunction = jest.fn();
    const nextHighVolume: NextFunction = jest.fn();

    // Use standard tier (limit 100)
    for (let i = 0; i < 101; i++) {
      standardMw(req, makeRes(), nextStandard);
    }

    // High volume tier should still work (limit 1000)
    for (let i = 0; i < 10; i++) {
      highVolumeMw(req, makeRes(), nextHighVolume);
    }

    expect(nextStandard).toHaveBeenCalledTimes(101); // 100 allowed + 1 error
    expect(nextHighVolume).toHaveBeenCalledTimes(10);
  });
});
