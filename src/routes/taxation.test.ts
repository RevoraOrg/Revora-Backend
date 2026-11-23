/**
 * Focused behavior suite for the taxation router
 * (`src/routes/taxation.ts`, Issue #1075).
 *
 * The module had no dedicated fixture. It is a singleton router: at import time
 * it builds a `TaxationService` from the shared pool, wraps it in a
 * `TaxationHandler`, gates every route behind `authMiddleware()`, then registers
 * six routes. This suite pins that wiring (order, methods, paths, shared handler
 * instance, auth gate) and exercises the success and failure paths of the
 * registered endpoints through `supertest`.
 *
 * Collaborators are replaced with deterministic in-memory doubles. Their mock
 * factories are self-contained (no closed-over test state) and expose a
 * `__state` handle that the assertions below read, so the suite neither touches
 * a database nor starts a listener.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

/* ─── collaborator doubles ──────────────────────────────────────────────── */

jest.mock("../middleware/auth", () => {
  const state = { factoryCalls: 0, runs: 0, fail: false };
  const authMiddleware = () => {
    state.factoryCalls += 1;
    return (req: Request, res: Response, next: NextFunction) => {
      state.runs += 1;
      if (state.fail) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      (req as Request & { user?: unknown }).user = { sub: "test-user" };
      next();
    };
  };
  return { authMiddleware, __state: state };
});

jest.mock("../db/pool", () => ({ pool: { marker: "test-pool" } }));

jest.mock("../services/taxation/taxationService", () => {
  const state: { poolArg: unknown; created: unknown } = { poolArg: null, created: null };
  const createTaxationService = (pool: unknown) => {
    state.poolArg = pool;
    state.created = { kind: "taxation-service" };
    return state.created;
  };
  return { createTaxationService, __state: state };
});

jest.mock("../handlers/taxationHandler", () => {
  const state = {
    serviceArg: null as unknown,
    instance: null as unknown,
    calls: [] as string[],
    failOn: null as string | null,
  };
  const respond =
    (name: string) => (req: Request, res: Response, next: NextFunction) => {
      state.calls.push(name);
      if (state.failOn === name) {
        next(new Error(`${name} failed`));
        return;
      }
      res.status(200).json({ handled: name });
    };

  class TaxationHandler {
    constructor(service: unknown) {
      state.serviceArg = service;
      state.instance = this;
    }
    processDisposal = respond("processDisposal");
    previewDisposal = respond("previewDisposal");
    detectWashSales = respond("detectWashSales");
    getGainsSummary = respond("getGainsSummary");
    listLots = respond("listLots");
    createLot = respond("createLot");
  }

  return { TaxationHandler, __state: state };
});

/* ─── imports (mocks are hoisted above these) ───────────────────────────── */

import taxationRouter from "./taxation";
import * as authModule from "../middleware/auth";
import * as serviceModule from "../services/taxation/taxationService";
import * as handlerModule from "../handlers/taxationHandler";

const authState = (authModule as unknown as { __state: { factoryCalls: number; runs: number; fail: boolean } }).__state;
const serviceState = (serviceModule as unknown as { __state: { poolArg: unknown; created: unknown } }).__state;
const handlerState = (handlerModule as unknown as {
  __state: { serviceArg: unknown; instance: unknown; calls: string[]; failOn: string | null };
}).__state;

/* ─── helpers ───────────────────────────────────────────────────────────── */

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/taxation", taxationRouter);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
}

function stack(): RouteLayer[] {
  return (taxationRouter as unknown as { stack: RouteLayer[] }).stack;
}

function routeTable(): Array<{ method: string; path: string }> {
  return stack()
    .filter((layer) => layer.route)
    .map((layer) => ({
      method: Object.keys(layer.route!.methods)[0].toUpperCase(),
      path: layer.route!.path,
    }));
}

beforeEach(() => {
  handlerState.calls.length = 0;
  handlerState.failOn = null;
  authState.fail = false;
  authState.runs = 0;
});

/* ─── wiring ────────────────────────────────────────────────────────────── */

describe("taxation router wiring", () => {
  it("exposes an express router as the default export", () => {
    expect(typeof taxationRouter).toBe("function");
    expect(stack()).toBeDefined();
  });

  it("registers the auth middleware once, before every route", () => {
    expect(authState.factoryCalls).toBe(1);
    expect(stack()[0].route).toBeUndefined(); // first layer is the auth gate
    expect(stack().slice(1).every((layer) => layer.route)).toBe(true);
  });

  it("registers exactly the documented routes in declaration order", () => {
    expect(routeTable()).toEqual([
      { method: "POST", path: "/dispose" },
      { method: "POST", path: "/preview" },
      { method: "POST", path: "/wash-sale-detection" },
      { method: "GET", path: "/gains-summary" },
      { method: "GET", path: "/lots" },
      { method: "POST", path: "/lots" },
    ]);
  });

  it("builds the service from the shared pool and shares one handler across routes", () => {
    expect(serviceState.poolArg).toEqual({ marker: "test-pool" });
    expect(handlerState.serviceArg).toBe(serviceState.created);
    expect(handlerState.instance).toBeDefined();
  });

  it("binds each route to the matching handler method", () => {
    const handles = stack()
      .filter((layer) => layer.route)
      .map((layer) => layer.route!.stack[0].handle);
    const instance = handlerState.instance as Record<string, unknown>;

    expect(handles).toEqual([
      instance.processDisposal,
      instance.previewDisposal,
      instance.detectWashSales,
      instance.getGainsSummary,
      instance.listLots,
      instance.createLot,
    ]);
  });
});

/* ─── behavior ──────────────────────────────────────────────────────────── */

describe("taxation router behavior", () => {
  it("routes POST /dispose to processDisposal", async () => {
    const res = await request(makeApp()).post("/taxation/dispose").send({ amount: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handled: "processDisposal" });
    expect(handlerState.calls).toEqual(["processDisposal"]);
  });

  it("routes POST /preview to previewDisposal", async () => {
    const res = await request(makeApp()).post("/taxation/preview").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handled: "previewDisposal" });
  });

  it("routes POST /wash-sale-detection to detectWashSales", async () => {
    const res = await request(makeApp()).post("/taxation/wash-sale-detection").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handled: "detectWashSales" });
  });

  it("routes GET /gains-summary to getGainsSummary", async () => {
    const res = await request(makeApp()).get("/taxation/gains-summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handled: "getGainsSummary" });
  });

  it("routes GET /lots to listLots and POST /lots to createLot", async () => {
    const app = makeApp();
    const list = await request(app).get("/taxation/lots");
    const create = await request(app).post("/taxation/lots").send({ units: 3 });

    expect(list.body).toEqual({ handled: "listLots" });
    expect(create.body).toEqual({ handled: "createLot" });
    expect(handlerState.calls).toEqual(["listLots", "createLot"]);
  });

  it("rejects an unsupported method on a registered path with 404", async () => {
    const res = await request(makeApp()).get("/taxation/dispose");
    expect(res.status).toBe(404);
    expect(handlerState.calls).toEqual([]);
  });

  it("returns 404 for an unregistered path", async () => {
    const res = await request(makeApp()).get("/taxation/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("surfaces a handler failure through the error pipeline", async () => {
    handlerState.failOn = "processDisposal";
    const res = await request(makeApp()).post("/taxation/dispose").send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "processDisposal failed" });
  });
});

/* ─── auth gate ─────────────────────────────────────────────────────────── */

describe("taxation router auth gate", () => {
  it("runs the auth middleware on every request", async () => {
    await request(makeApp()).get("/taxation/lots");
    await request(makeApp()).post("/taxation/dispose").send({});
    expect(authState.runs).toBe(2);
  });

  it("blocks the request with 401 when auth fails, without reaching the handler", async () => {
    authState.fail = true;
    const res = await request(makeApp()).get("/taxation/gains-summary");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(handlerState.calls).toEqual([]);
  });
});
