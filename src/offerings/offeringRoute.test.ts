/**
 * Focused behavior suite for `createOfferingRouter`
 * (`src/offerings/offeringRoute.ts`, Issue #1062).
 *
 * The module is a factory that, for each call, wires three repositories onto the
 * supplied `pg` pool, builds an `OfferingService`, wraps it in an
 * `OfferingHandler`, and exposes two read routes. This suite pins the factory
 * contract (repository/service construction order and the exact routes) and
 * drives the routes end to end through `supertest` against the real
 * `OfferingHandler`, so the zod query validation and the `next(error)` failure
 * paths are exercised rather than stubbed.
 *
 * Only the data layer (repositories + service) is doubled; no database or
 * network is touched.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

/* ─── data-layer doubles ────────────────────────────────────────────────── */

jest.mock("../db/repositories/investmentRepository", () => {
  const state = { instances: [] as unknown[], poolArgs: [] as unknown[] };
  class InvestmentRepository {
    constructor(pool: unknown) {
      state.instances.push(this);
      state.poolArgs.push(pool);
    }
  }
  return { InvestmentRepository, __state: state };
});

jest.mock("../db/repositories/distributionRepository", () => {
  const state = { instances: [] as unknown[], poolArgs: [] as unknown[] };
  class DistributionRepository {
    constructor(pool: unknown) {
      state.instances.push(this);
      state.poolArgs.push(pool);
    }
  }
  return { DistributionRepository, __state: state };
});

jest.mock("../db/repositories/offeringRepository", () => {
  const state = { instances: [] as unknown[], poolArgs: [] as unknown[] };
  class OfferingRepository {
    constructor(pool: unknown) {
      state.instances.push(this);
      state.poolArgs.push(pool);
    }
  }
  return { OfferingRepository, __state: state };
});

jest.mock("./offeringService", () => {
  const state = {
    constructorArgs: [] as unknown[],
    catalogCalls: [] as Array<[number, number, string[]]>,
    statsCalls: [] as string[],
    catalog: [] as unknown[],
    stats: {} as unknown,
    catalogError: null as Error | null,
    statsError: null as Error | null,
  };
  class OfferingService {
    constructor(...args: unknown[]) {
      state.constructorArgs = args;
    }
    async getCatalog(limit: number, offset: number, statuses: string[]) {
      state.catalogCalls.push([limit, offset, statuses]);
      if (state.catalogError) throw state.catalogError;
      return state.catalog;
    }
    async getOfferingStats(id: string) {
      state.statsCalls.push(id);
      if (state.statsError) throw state.statsError;
      return state.stats;
    }
  }
  return { OfferingService, __state: state };
});

/* ─── imports (mocks are hoisted above these) ───────────────────────────── */

import { createOfferingRouter } from "./offeringRoute";
import * as investmentModule from "../db/repositories/investmentRepository";
import * as distributionModule from "../db/repositories/distributionRepository";
import * as offeringRepoModule from "../db/repositories/offeringRepository";
import * as serviceModule from "./offeringService";

const investmentState = (investmentModule as unknown as {
  __state: { instances: unknown[]; poolArgs: unknown[] };
}).__state;
const distributionState = (distributionModule as unknown as {
  __state: { instances: unknown[]; poolArgs: unknown[] };
}).__state;
const offeringRepoState = (offeringRepoModule as unknown as {
  __state: { instances: unknown[]; poolArgs: unknown[] };
}).__state;
const serviceState = (serviceModule as unknown as {
  __state: {
    constructorArgs: unknown[];
    catalogCalls: Array<[number, number, string[]]>;
    statsCalls: string[];
    catalog: unknown[];
    stats: unknown;
    catalogError: Error | null;
    statsError: Error | null;
  };
}).__state;

/* ─── helpers ───────────────────────────────────────────────────────────── */

const POOL = { marker: "pg-pool" };

function makeApp() {
  const router = createOfferingRouter(POOL as never);
  const app = express();
  app.use(express.json());
  app.use("/api/offerings", router);
  app.use((err: Error & { statusCode?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.statusCode ?? 500).json({ code: err.code ?? "UNKNOWN", message: err.message });
  });
  return app;
}

beforeEach(() => {
  investmentState.instances.length = 0;
  investmentState.poolArgs.length = 0;
  distributionState.instances.length = 0;
  distributionState.poolArgs.length = 0;
  offeringRepoState.instances.length = 0;
  offeringRepoState.poolArgs.length = 0;
  serviceState.constructorArgs = [];
  serviceState.catalogCalls.length = 0;
  serviceState.statsCalls.length = 0;
  serviceState.catalog = [];
  serviceState.stats = {};
  serviceState.catalogError = null;
  serviceState.statsError = null;
});

/* ─── factory wiring ────────────────────────────────────────────────────── */

describe("createOfferingRouter wiring", () => {
  it("constructs each repository with the supplied pool", () => {
    createOfferingRouter(POOL as never);

    expect(investmentState.poolArgs).toEqual([POOL]);
    expect(distributionState.poolArgs).toEqual([POOL]);
    expect(offeringRepoState.poolArgs).toEqual([POOL]);
  });

  it("builds the service with the three repositories, in order", () => {
    createOfferingRouter(POOL as never);

    expect(serviceState.constructorArgs).toEqual([
      investmentState.instances[0],
      distributionState.instances[0],
      offeringRepoState.instances[0],
    ]);
  });

  it("registers the two documented GET routes in order", () => {
    const router = createOfferingRouter(POOL as never);
    const layers = (router as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    }).stack;

    expect(
      layers
        .filter((layer) => layer.route)
        .map((layer) => ({
          method: Object.keys(layer.route!.methods)[0].toUpperCase(),
          path: layer.route!.path,
        })),
    ).toEqual([
      { method: "GET", path: "/catalog" },
      { method: "GET", path: "/:id/stats" },
    ]);
  });

  it("builds independent wiring per factory call", () => {
    createOfferingRouter(POOL as never);
    createOfferingRouter(POOL as never);

    expect(investmentState.instances).toHaveLength(2);
    expect(investmentState.instances[0]).not.toBe(investmentState.instances[1]);
  });
});

/* ─── GET /catalog ──────────────────────────────────────────────────────── */

describe("GET /catalog", () => {
  it("returns the catalog with default pagination and statuses", async () => {
    serviceState.catalog = [{ id: "o1" }, { id: "o2" }];

    const res = await request(makeApp()).get("/api/offerings/catalog");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [{ id: "o1" }, { id: "o2" }],
      pagination: { limit: 10, offset: 0, count: 2 },
    });
    expect(serviceState.catalogCalls).toEqual([[10, 0, ["active", "completed"]]]);
  });

  it("passes explicit pagination through to the service", async () => {
    const res = await request(makeApp()).get(
      "/api/offerings/catalog?limit=5&offset=2&statuses=active,completed",
    );

    expect(res.status).toBe(200);
    expect(serviceState.catalogCalls).toEqual([[5, 2, ["active", "completed"]]]);
    expect(res.body.pagination).toEqual({ limit: 5, offset: 2, count: 0 });
  });

  it("accepts repeated status parameters as an array", async () => {
    await request(makeApp()).get("/api/offerings/catalog?statuses=active&statuses=paused");
    expect(serviceState.catalogCalls).toEqual([[10, 0, ["active", "paused"]]]);
  });

  it("trims and drops blank entries from a comma-separated status list", async () => {
    await request(makeApp()).get("/api/offerings/catalog?statuses=active%2C%20%2Ccompleted");
    expect(serviceState.catalogCalls[0][2]).toEqual(["active", "completed"]);
  });

  it("marks the response publicly cacheable for 60 seconds", async () => {
    const res = await request(makeApp()).get("/api/offerings/catalog");
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("rejects limit=0 with a validation error and never calls the service", async () => {
    const res = await request(makeApp()).get("/api/offerings/catalog?limit=0");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(serviceState.catalogCalls).toEqual([]);
  });

  it("rejects limit above 100", async () => {
    const res = await request(makeApp()).get("/api/offerings/catalog?limit=101");
    expect(res.status).toBe(400);
    expect(serviceState.catalogCalls).toEqual([]);
  });

  it("rejects a non-numeric limit", async () => {
    const res = await request(makeApp()).get("/api/offerings/catalog?limit=abc");
    expect(res.status).toBe(400);
    expect(serviceState.catalogCalls).toEqual([]);
  });

  it("rejects a negative offset", async () => {
    const res = await request(makeApp()).get("/api/offerings/catalog?offset=-1");
    expect(res.status).toBe(400);
    expect(serviceState.catalogCalls).toEqual([]);
  });

  it("surfaces a service failure through the error pipeline", async () => {
    serviceState.catalogError = new Error("catalog boom");
    const res = await request(makeApp()).get("/api/offerings/catalog");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: "UNKNOWN", message: "catalog boom" });
  });
});

/* ─── GET /:id/stats ────────────────────────────────────────────────────── */

describe("GET /:id/stats", () => {
  it("returns the stats for the requested offering", async () => {
    serviceState.stats = { totalRaised: 500, holders: 3 };

    const res = await request(makeApp()).get("/api/offerings/offering-42/stats");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ totalRaised: 500, holders: 3 });
    expect(serviceState.statsCalls).toEqual(["offering-42"]);
  });

  it("url-decodes the offering id before handing it to the service", async () => {
    await request(makeApp()).get("/api/offerings/a%20b/stats");
    expect(serviceState.statsCalls).toEqual(["a b"]);
  });

  it("surfaces a service failure through the error pipeline", async () => {
    serviceState.statsError = new Error("stats boom");
    const res = await request(makeApp()).get("/api/offerings/offering-42/stats");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: "UNKNOWN", message: "stats boom" });
    expect(serviceState.statsCalls).toEqual(["offering-42"]);
  });

  it("does not match a single-segment /stats path", async () => {
    const res = await request(makeApp()).get("/api/offerings/stats");
    expect(res.status).toBe(404);
    expect(serviceState.statsCalls).toEqual([]);
  });
});
