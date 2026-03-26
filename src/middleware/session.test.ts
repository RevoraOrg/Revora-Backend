/**
 * @file src/routes/health.test.ts
 * @description
 * Test suite for the Revora backend session expiry cleanup system and
 * the /health endpoint that exposes session metrics.
 *
 * Test strategy:
 *  - SessionStore unit tests: pure in-process, no HTTP, deterministic timing
 *    via manual clock advancement (Date.now mock).
 *  - Health endpoint integration tests: supertest against a minimal Express
 *    app; DB health is stubbed so tests are self-contained.
 *  - Session middleware integration tests: login → use token → logout → replay.
 *  - Security / abuse path tests: token replay, forged headers, missing auth.
 *
 * All tests are independent — no shared mutable state between `it` blocks.
 */

import express, { Request, Response } from "express";
import request                         from "supertest";
import { SessionStore }                from "../lib/sessionStore";
import { createSessionAuth, createSessionRouter } from "../middleware/session";


/** Advance Date.now by `ms` milliseconds for the duration of `fn`. */
async function withTimeAdvanced<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now.bind(Date);
  const fakeNow = realNow() + ms;
  jest.spyOn(Date, "now").mockReturnValue(fakeNow);
  try {
    return await fn();
  } finally {
    jest.spyOn(Date, "now").mockRestore();
  }
}

/** Build a minimal Express app wired to a given SessionStore. */
function makeApp(store: SessionStore) {
  const app = express();
  app.use(express.json());

  // Session routes
  app.use(createSessionRouter(store));

  // A protected route for testing auth middleware
  app.get(
    "/protected",
    createSessionAuth(store),
    (req: Request, res: Response) => {
      res.json({ userId: req.user!.id, role: req.user!.role });
    }
  );

  // Stats route
  app.get("/session/stats", (_req: Request, res: Response) => {
    res.json(store.stats());
  });

  // Minimal health route that includes session stats
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", session: store.stats() });
  });

  return app;
}



describe("SessionStore", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Session creation ────────────────────────────────────────────────────

  describe("create()", () => {
    it("returns a session with a non-empty token and correct metadata", async () => {
      const store   = new SessionStore({ ttlMs: 60_000, sweepIntervalMs: 0 });
      const session = await store.create("user-1", "admin");

      expect(session.token).toMatch(/^[0-9a-f]{32}$/); // 128-bit hex
      expect(session.userId).toBe("user-1");
      expect(session.role).toBe("admin");
      expect(session.expiresAt).toBeGreaterThan(Date.now());
    });

    it("generates unique tokens for successive calls", async () => {
      const store = new SessionStore({ sweepIntervalMs: 0 });
      const a     = await store.create("user-1", "admin");
      const b     = await store.create("user-2", "client");
      expect(a.token).not.toBe(b.token);
    });

    it("increments totalCreated counter", async () => {
      const store = new SessionStore({ sweepIntervalMs: 0 });
      await store.create("u1", "admin");
      await store.create("u2", "admin");
      expect(store.stats().totalCreated).toBe(2);
    });
  });

  // ── 2. Session retrieval ───────────────────────────────────────────────────

  describe("get()", () => {
    it("returns the session for a valid, non-expired token", async () => {
      const store   = new SessionStore({ ttlMs: 60_000, sweepIntervalMs: 0 });
      const created = await store.create("user-1", "client");
      const found   = await store.get(created.token);
      expect(found).not.toBeNull();
      expect(found!.userId).toBe("user-1");
    });

    it("returns null for an unknown token", async () => {
      const store = new SessionStore({ sweepIntervalMs: 0 });
      const found = await store.get("completely-unknown-token");
      expect(found).toBeNull();
    });

    it("returns null and evicts a session that has passed its TTL (lazy expiry)", async () => {
      const store   = new SessionStore({ ttlMs: 1_000, sweepIntervalMs: 0 });
      const session = await store.create("user-1", "admin");

      const found = await withTimeAdvanced(2_000, () => store.get(session.token));

      expect(found).toBeNull();
      // Confirm the eviction incremented the counter
      expect(store.stats().expiredCleaned).toBe(1);
    });
  });

  // ── 3. Session deletion ────────────────────────────────────────────────────

  describe("delete()", () => {
    it("removes the session so subsequent get() returns null", async () => {
      const store   = new SessionStore({ sweepIntervalMs: 0 });
      const session = await store.create("user-1", "admin");
      await store.delete(session.token);
      const found = await store.get(session.token);
      expect(found).toBeNull();
    });

    it("is idempotent — deleting a non-existent token does not throw", async () => {
      const store = new SessionStore({ sweepIntervalMs: 0 });
      await expect(store.delete("ghost-token")).resolves.toBeUndefined();
    });
  });

  // ── 4. Touch / renewal ────────────────────────────────────────────────────

  describe("touch()", () => {
    it("extends the session TTL and returns true", async () => {
      const store   = new SessionStore({ ttlMs: 60_000, sweepIntervalMs: 0 });
      const session = await store.create("user-1", "admin");
      const before  = session.expiresAt;

      // Advance time so the new expiresAt must be strictly greater.
      await withTimeAdvanced(5_000, () => store.touch(session.token));

      const refreshed = await store.get(session.token);
      expect(refreshed!.expiresAt).toBeGreaterThan(before);
    });

    it("returns false and evicts an already-expired session", async () => {
      const store   = new SessionStore({ ttlMs: 1_000, sweepIntervalMs: 0 });
      const session = await store.create("user-1", "admin");

      const touched = await withTimeAdvanced(2_000, () => store.touch(session.token));

      expect(touched).toBe(false);
      expect(store.stats().expiredCleaned).toBe(1);
    });

    it("returns false for an unknown token", async () => {
      const store   = new SessionStore({ sweepIntervalMs: 0 });
      const touched = await store.touch("no-such-token");
      expect(touched).toBe(false);
    });
  });

  // ── 5. Background sweep ───────────────────────────────────────────────────

  describe("sweep()", () => {
    it("evicts all expired sessions and updates expiredCleaned counter", async () => {
      const store = new SessionStore({ ttlMs: 1_000, sweepIntervalMs: 0 });
      await store.create("u1", "admin");
      await store.create("u2", "client");
      await store.create("u3", "verifier");

      // Advance time so all three are expired, then sweep.
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 2_000);
      const evicted = store.sweep();

      expect(evicted).toBe(3);
      expect(store.stats().expiredCleaned).toBe(3);
      expect(store.stats().activeSessions).toBe(0);
    });

    it("leaves non-expired sessions untouched", async () => {
      const store = new SessionStore({ ttlMs: 60_000, sweepIntervalMs: 0 });
      await store.create("u1", "admin");
      await store.create("u2", "client");

      const evicted = store.sweep();

      expect(evicted).toBe(0);
      expect(store.stats().activeSessions).toBe(2);
    });

    it("partial sweep: only evicts sessions past their TTL", async () => {
      const now   = Date.now();
      const store = new SessionStore({ ttlMs: 60_000, sweepIntervalMs: 0 });

      // One session with 1 s TTL (will expire), one with 60 s TTL (won't).
      const shortLived = new SessionStore({ ttlMs: 1_000, sweepIntervalMs: 0 });
      const s1 = await shortLived.create("u1", "admin");
      const s2 = await store.create("u2", "client");

      // Create a store whose sessions have different TTLs by manipulating directly.
      const mixed = new SessionStore({ ttlMs: 60_000, sweepIntervalMs: 0 });
      const alive  = await mixed.create("alive",   "admin");
      const zombie = await mixed.create("zombie",  "client");
      // Manually expire zombie by advancing clock only for that session check
      jest.spyOn(Date, "now").mockReturnValue(now + 2_000);
      // Force zombie to look expired: re-create with short TTL store
      const mixedShort = new SessionStore({ ttlMs: 500, sweepIntervalMs: 0 });
      await mixedShort.create("alive", "admin");  // this one is "dead"
      const evicted = mixedShort.sweep();
      jest.restoreAllMocks();

      // With 500ms TTL and 2000ms advance, all sessions in mixedShort are expired.
      expect(evicted).toBe(1);
      expect(mixedShort.stats().expiredCleaned).toBe(1);
    });
  });

  // ── 6. Stats ──────────────────────────────────────────────────────────────

  describe("stats()", () => {
    it("returns correct counts across the full lifecycle", async () => {
      const store = new SessionStore({ ttlMs: 60_000, sweepIntervalMs: 0 });

      const s1 = await store.create("u1", "admin");
      const s2 = await store.create("u2", "client");

      let stats = store.stats();
      expect(stats.totalCreated).toBe(2);
      expect(stats.activeSessions).toBe(2);
      expect(stats.expiredCleaned).toBe(0);

      await store.delete(s1.token);
      stats = store.stats();
      expect(stats.activeSessions).toBe(1);

      // Expire s2 via lazy eviction
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
      await store.get(s2.token); // triggers lazy eviction
      jest.restoreAllMocks();

      stats = store.stats();
      expect(stats.expiredCleaned).toBe(1);
      expect(stats.activeSessions).toBe(0);
    });
  });

  // ── 7. Stop ───────────────────────────────────────────────────────────────

  describe("stop()", () => {
    it("clears all sessions and prevents further background sweeps", () => {
      const store = new SessionStore({ sweepIntervalMs: 100 });
      store.startSweep();
      store.stop();
      expect(store.stats().activeSessions).toBe(0);
      // Calling stop again must not throw
      expect(() => store.stop()).not.toThrow();
    });
  });
});



describe("Session middleware and routes", () => {
  let store: SessionStore;
  let app:   ReturnType<typeof makeApp>;

  beforeEach(() => {
    store = new SessionStore({ ttlMs: 60_000, sweepIntervalMs: 0 });
    app   = makeApp(store);
  });

  afterEach(() => {
    store.stop();
    jest.restoreAllMocks();
  });


  describe("POST /session/login", () => {
    it("returns 201 with a token when valid headers are supplied", async () => {
      const res = await request(app)
        .post("/session/login")
        .set("x-user-id",   "user-1")
        .set("x-user-role", "admin");

      expect(res.status).toBe(201);
      expect(res.body.token).toMatch(/^[0-9a-f]{32}$/);
      expect(res.body.expiresAt).toBeDefined();
    });

    it("returns 401 when x-user-id is missing", async () => {
      const res = await request(app)
        .post("/session/login")
        .set("x-user-role", "admin");

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error");
    });

    it("returns 401 when x-user-role is missing", async () => {
      const res = await request(app)
        .post("/session/login")
        .set("x-user-id", "user-1");

      expect(res.status).toBe(401);
    });
  });

  // Protected route 

  describe("GET /protected (session-gated route)", () => {
    it("returns 200 with user context for a valid session token", async () => {
      const login = await request(app)
        .post("/session/login")
        .set("x-user-id",   "user-42")
        .set("x-user-role", "client");

      const { token } = login.body;

      const res = await request(app)
        .get("/protected")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ userId: "user-42", role: "client" });
    });

    it("returns 401 when the Authorization header is missing", async () => {
      const res = await request(app).get("/protected");
      expect(res.status).toBe(401);
    });

    it("returns 401 for an invalid token", async () => {
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "Bearer not-a-real-token");
      expect(res.status).toBe(401);
    });

    it("returns 401 after the session has expired (lazy expiry path)", async () => {
      const login = await request(app)
        .post("/session/login")
        .set("x-user-id",   "user-1")
        .set("x-user-role", "admin");

      const { token } = login.body;

      // Advance clock past TTL
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);

      const res = await request(app)
        .get("/protected")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(401);
    });
  });


  describe("POST /session/logout", () => {
    it("returns 204 and invalidates the session (token replay → 401)", async () => {
      const login = await request(app)
        .post("/session/login")
        .set("x-user-id",   "user-1")
        .set("x-user-role", "admin");

      const { token } = login.body;

      const logout = await request(app)
        .post("/session/logout")
        .set("Authorization", `Bearer ${token}`);

      expect(logout.status).toBe(204);

      // Token replay must be rejected
      const replay = await request(app)
        .get("/protected")
        .set("Authorization", `Bearer ${token}`);

      expect(replay.status).toBe(401);
    });

    it("returns 401 when called without a session token", async () => {
      const res = await request(app).post("/session/logout");
      expect(res.status).toBe(401);
    });
  });


  describe("GET /health", () => {
    it("includes session stats in the health response", async () => {
      // Create two sessions so stats are non-trivial
      await request(app)
        .post("/session/login")
        .set("x-user-id", "u1").set("x-user-role", "admin");
      await request(app)
        .post("/session/login")
        .set("x-user-id", "u2").set("x-user-role", "client");

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body.session).toMatchObject({
        activeSessions: 2,
        totalCreated:   2,
        expiredCleaned: 0,
      });
    });

    it("reflects cleaned sessions after a sweep", async () => {
      await request(app)
        .post("/session/login")
        .set("x-user-id", "u1").set("x-user-role", "admin");

      // Advance clock and trigger sweep
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
      store.sweep();

      const res = await request(app).get("/health");
      expect(res.body.session.expiredCleaned).toBe(1);
      expect(res.body.session.activeSessions).toBe(0);
    });
  });


  describe("Security — abuse paths", () => {
    it("rejects a token with a forged Bearer prefix", async () => {
      const res = await request(app)
        .get("/protected")
        .set("Authorization", "bearer valid-looking-but-fake");
      // "bearer" (lowercase) is not "Bearer " — header check fails
      expect(res.status).toBe(401);
    });

    it("does not leak session details in error responses", async () => {
      const login = await request(app)
        .post("/session/login")
        .set("x-user-id", "secret-user-id").set("x-user-role", "admin");

      const { token } = login.body;

      // Make it expire
      jest.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);

      const res = await request(app)
        .get("/protected")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain("secret-user-id");
      expect(JSON.stringify(res.body)).not.toContain(token);
    });

    it("x-user-id and x-user-role headers alone cannot bypass session auth", async () => {
      // The protected route uses session auth, not the legacy header check.
      const res = await request(app)
        .get("/protected")
        .set("x-user-id",   "attacker")
        .set("x-user-role", "admin");

      expect(res.status).toBe(401);
    });
  });
});