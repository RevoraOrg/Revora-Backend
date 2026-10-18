import {
  SessionStore,
  PostgresSessionStore,
  hashSessionToken,
  constantTimeHexEqual,
  generateSessionToken,
} from "../sessionStore";
import { globalMetrics } from "../metrics";
import type { SessionRepository } from "../../db/repositories/sessionRepository";

// ─── Fake repository for PostgresSessionStore tests ──────────────────────────

interface Row {
  id: string;
  user_id: string;
  role: string;
  token_hash: string;
  expires_at: Date;
  created_at: Date;
  revoked_at?: Date;
}

class FakeSessionRepository {
  readonly rows = new Map<string, Row>();
  private seq = 0;

  constructor(private readonly clock: () => number = () => Date.now()) { }

  async createWebSession(input: {
    user_id: string;
    role: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<Row> {
    const row: Row = {
      id: `session-${this.seq++}`,
      user_id: input.user_id,
      role: input.role,
      token_hash: input.token_hash,
      expires_at: input.expires_at,
      created_at: new Date(this.clock()),
    };
    this.rows.set(input.token_hash, row);
    return { ...row };
  }

  async findByTokenHash(tokenHash: string): Promise<Row | null> {
    const row = this.rows.get(tokenHash);
    return row ? { ...row } : null;
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    this.rows.delete(tokenHash);
  }

  async touchExpiryByTokenHash(tokenHash: string, expiresAt: Date): Promise<void> {
    const row = this.rows.get(tokenHash);
    if (row) row.expires_at = expiresAt;
  }

  async deleteExpired(): Promise<number> {
    let removed = 0;
    const now = this.clock();
    for (const [hash, row] of this.rows) {
      if (row.expires_at.getTime() <= now) {
        this.rows.delete(hash);
        removed++;
      }
    }
    return removed;
  }

  async countActive(): Promise<number> {
    let count = 0;
    const now = this.clock();
    for (const row of this.rows.values()) {
      if (row.expires_at.getTime() > now && !row.revoked_at) count++;
    }
    return count;
  }

  async deleteAllSessionsByUserId(): Promise<void> {
    this.rows.clear();
  }
}

function makePostgresSuite(now: () => number, ttlMs = 60_000, opts?: { roleTtlMs?: Record<string, number>; maxExtendedExpiry?: number }) {
  const repo = new FakeSessionRepository(now);
  const store = new PostgresSessionStore(repo as unknown as SessionRepository, {
    ttlMs,
    now,
    roleTtlMs: opts?.roleTtlMs,
    maxExtendedExpiry: opts?.maxExtendedExpiry,
  });
  return { repo, store };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Advance Date.now by `ms` milliseconds for `fn`, restoring after. */
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

// ─── Per-role TTL defaults ──────────────────────────────────────────────────

const DEFAULT_ROLE_TTL: Record<string, number> = {
  admin: 30 * 60 * 1000,
  verifier: 60 * 60 * 1000,
  issuer: 2 * 60 * 60 * 1000,
  investor: 4 * 60 * 60 * 1000,
  anonymous: 15 * 60 * 1000,
};

// ─── Suite: In-memory SessionStore ──────────────────────────────────────────

describe("SessionStore – per-role TTL", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    globalMetrics.reset();
  });

  describe("create()", () => {
    it("uses role-specific TTL when roleTtlMs is configured", async () => {
      const store = new SessionStore({
        roleTtlMs: DEFAULT_ROLE_TTL,
        sweepIntervalMs: 0,
      });
      const now = Date.now();

      const admin = await store.create("u1", "admin");
      expect(admin.expiresAt - now).toBeGreaterThanOrEqual(DEFAULT_ROLE_TTL.admin);
      expect(admin.expiresAt - now).toBeLessThan(DEFAULT_ROLE_TTL.admin + 1_000);

      const investor = await store.create("u2", "investor");
      expect(investor.expiresAt - now).toBeGreaterThanOrEqual(DEFAULT_ROLE_TTL.investor);
      expect(investor.expiresAt - now).toBeLessThan(DEFAULT_ROLE_TTL.investor + 1_000);
    });

    it("falls back to default TTL when role has no entry in roleTtlMs", async () => {
      const store = new SessionStore({
        ttlMs: 5_000,
        roleTtlMs: { admin: 10_000 },
        sweepIntervalMs: 0,
      });
      const now = Date.now();

      const session = await store.create("u1", "unknown-role");
      expect(session.expiresAt - now).toBeGreaterThanOrEqual(5_000);
      expect(session.expiresAt - now).toBeLessThan(5_000 + 1_000);
    });

    it("accepts explicit roleTtlMs override of DEFAULT_ROLE_TTL", async () => {
      const store = new SessionStore({
        ttlMs: 10_000,
        roleTtlMs: { ...DEFAULT_ROLE_TTL, admin: 2_000 },
        sweepIntervalMs: 0,
      });
      const now = Date.now();

      const admin = await store.create("u1", "admin");
      expect(admin.expiresAt - now).toBeGreaterThanOrEqual(2_000);
      expect(admin.expiresAt - now).toBeLessThan(2_000 + 1_000);

      const other = await store.create("u2", "unknown");
      expect(other.expiresAt - now).toBeGreaterThanOrEqual(10_000);
      expect(other.expiresAt - now).toBeLessThan(10_000 + 1_000);
    });
  });

  describe("touch()", () => {
    it("extends using the session's own role TTL", async () => {
      const store = new SessionStore({ sweepIntervalMs: 0 });
      const session = await store.create("u1", "admin");
      const before = session.expiresAt;

      await withTimeAdvanced(5_000, () => store.touch(session.token));

      const refreshed = await store.get(session.token);
      expect(refreshed!.expiresAt).toBeGreaterThan(before);
    });

    it("extends using the passed role TTL when role argument is given", async () => {
      const store = new SessionStore({
        roleTtlMs: { admin: 30_000, investor: 240_000 },
        sweepIntervalMs: 0,
      });
      const session = await store.create("u1", "admin"); // admin TTL = 30s

      // Pass "investor" role — should use 240s TTL instead of 30s
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);
      await store.touch(session.token, "investor");
      jest.restoreAllMocks();

      const refreshed = await store.get(session.token);
      expect(refreshed!.expiresAt - now).toBe(240_000);
    });

    it("cannot extend past maxExtendedExpiry", async () => {
      const store = new SessionStore({
        ttlMs: 60_000,
        roleTtlMs: { admin: 60_000 },
        maxExtendedExpiry: 90_000,
        sweepIntervalMs: 0,
      });

      const session = await store.create("u1", "admin");
      const createdAt = session.createdAt;

      // Touch at t=10s — now+ttl = 70s from creation, within cap
      jest.spyOn(Date, "now").mockReturnValue(createdAt + 10_000);
      await store.touch(session.token);
      jest.restoreAllMocks();
      expect((await store.get(session.token))!.expiresAt).toBe(createdAt + 70_000);

      // Touch at t=40s — now+ttl = 100s from creation, capped at 90s
      jest.spyOn(Date, "now").mockReturnValue(createdAt + 40_000);
      await store.touch(session.token);
      jest.restoreAllMocks();
      expect((await store.get(session.token))!.expiresAt).toBe(createdAt + 90_000);
    });

    it("emits session.idle_extended counter on touch", async () => {
      const store = new SessionStore({ sweepIntervalMs: 0 });
      const session = await store.create("u1", "admin");

      const spy = jest.spyOn(globalMetrics, "incrementCounter");
      await store.touch(session.token);

      expect(spy).toHaveBeenCalledWith("session.idle_extended", { role: "admin" });
      spy.mockRestore();
    });
  });
});

// ─── Suite: PostgresSessionStore ────────────────────────────────────────────

describe("PostgresSessionStore – per-role TTL", () => {
  afterEach(() => {
    globalMetrics.reset();
  });

  describe("create()", () => {
    it("uses role-specific TTL when roleTtlMs is configured", async () => {
      const { store } = makePostgresSuite(() => 1_000, 60_000, {
        roleTtlMs: DEFAULT_ROLE_TTL,
      });

      const admin = await store.create("u1", "admin");
      expect(admin.expiresAt).toBe(1_000 + DEFAULT_ROLE_TTL.admin);
    });

    it("falls back to default TTL for unknown roles", async () => {
      const { store } = makePostgresSuite(() => 1_000, 5_000, {
        roleTtlMs: DEFAULT_ROLE_TTL,
      });

      const session = await store.create("u1", "superadmin");
      expect(session.expiresAt).toBe(1_000 + 5_000);
    });

    it("accepts explicit roleTtlMs override", async () => {
      const { store } = makePostgresSuite(() => 1_000, 10_000, {
        roleTtlMs: { custom: 2_000 },
      });

      const custom = await store.create("u1", "custom");
      expect(custom.expiresAt).toBe(1_000 + 2_000);

      const unknown = await store.create("u2", "unknown");
      expect(unknown.expiresAt).toBe(1_000 + 10_000);
    });
  });

  describe("touch()", () => {
    it("extends using the session's own role TTL", async () => {
      const { repo, store } = makePostgresSuite(() => 0, 60_000, {
        roleTtlMs: { admin: 30_000 },
      });

      const session = await store.create("u1", "admin");
      expect(session.expiresAt).toBe(0 + 30_000);

      // Advance clock to 10_000 and touch with a shared-repo store
      const store2 = new PostgresSessionStore(repo as unknown as SessionRepository, {
        ttlMs: 60_000,
        now: () => 10_000,
        roleTtlMs: { admin: 30_000 },
      });

      const ok = await store2.touch(session.token);
      expect(ok).toBe(true);

      const row = repo.rows.get(hashSessionToken(session.token));
      expect(row!.expires_at.getTime()).toBe(10_000 + 30_000);
    });

    it("extends using the passed role TTL when different from session role", async () => {
      const { repo, store } = makePostgresSuite(() => 0, 60_000, {
        roleTtlMs: { admin: 30_000, investor: 4 * 60_000 },
      });

      const session = await store.create("u1", "admin");

      const store2 = new PostgresSessionStore(repo as unknown as SessionRepository, {
        ttlMs: 60_000,
        now: () => 10_000,
        roleTtlMs: { admin: 30_000, investor: 4 * 60_000 },
      });

      const ok = await store2.touch(session.token, "investor");
      expect(ok).toBe(true);

      const row = repo.rows.get(hashSessionToken(session.token));
      expect(row!.expires_at.getTime()).toBe(10_000 + 4 * 60_000);
    });

    it("cannot extend past maxExtendedExpiry", async () => {
      const { repo, store } = makePostgresSuite(() => 0, 60_000, {
        roleTtlMs: { admin: 60_000 },
        maxExtendedExpiry: 90_000,
      });

      const session = await store.create("u1", "admin");
      const createdAt = session.createdAt;

      // Touch at t=10s — 10s + 60s = 70s, within 90s cap
      const store2 = new PostgresSessionStore(repo as unknown as SessionRepository, {
        ttlMs: 60_000, now: () => 10_000,
        roleTtlMs: { admin: 60_000 }, maxExtendedExpiry: 90_000,
      });
      await store2.touch(session.token);

      let row = repo.rows.get(hashSessionToken(session.token));
      expect(row!.expires_at.getTime()).toBe(10_000 + 60_000);

      // Touch at t=40s — 40s + 60s = 100s, capped at createdAt+90s = 90s
      const store3 = new PostgresSessionStore(repo as unknown as SessionRepository, {
        ttlMs: 60_000, now: () => 40_000,
        roleTtlMs: { admin: 60_000 }, maxExtendedExpiry: 90_000,
      });
      await store3.touch(session.token);

      row = repo.rows.get(hashSessionToken(session.token));
      expect(row!.expires_at.getTime()).toBe(createdAt + 90_000);
    });

    it("returns false for unknown token", async () => {
      const { store } = makePostgresSuite(() => 0, 60_000);

      expect(await store.touch("nonexistent-token")).toBe(false);
    });

    it("emits session.idle_extended counter on touch", async () => {
      const { store } = makePostgresSuite(() => 0, 60_000);

      const session = await store.create("u1", "admin");

      const spy = jest.spyOn(globalMetrics, "incrementCounter");
      await store.touch(session.token);

      expect(spy).toHaveBeenCalledWith("session.idle_extended", { role: "admin" });
      spy.mockRestore();
    });
  });
});

// ─── Suite: get() failure/empty-result contract ──────────────────────────────
//
// Regression coverage for the explicit failure branches in sessionStore.ts:
//   - L188  `if (!session) return null;`            → unknown in-memory token
//   - L192  `return null;` after lazy eviction       → expired in-memory session
//   - L412  `if (!row) return null;`                → no matching DB row
//
// The security invariant under test: an unknown / expired / revoked session is
// indistinguishable from a session that never existed. Callers get `null`, not a
// distinguishable error, so the lookup cannot be used as an oracle.

/** Pin `Date.now` to a fixed instant so expiry boundaries are deterministic. */
function mockNow(ts: number): void {
  jest.spyOn(Date, "now").mockReturnValue(ts);
}

const BASE = 1_700_000_000_000;

/**
 * Build a memory store whose TTL is `ttlMs` for every role used below.
 * Required because `SessionStore` merges `DEFAULT_ROLE_TTL` on top of `ttlMs`,
 * so a bare `ttlMs` would be ignored for known roles like `admin`.
 */
function makeStore(ttlMs: number, extra: Partial<{ sweepIntervalMs: number }> = {}): SessionStore {
  return new SessionStore({
    ttlMs,
    roleTtlMs: { admin: ttlMs, verifier: ttlMs, investor: ttlMs, anonymous: ttlMs },
    sweepIntervalMs: extra.sweepIntervalMs ?? 0,
  });
}

describe("SessionStore – get() failure paths", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    globalMetrics.reset();
  });

  describe("unknown token (L188 `if (!session) return null`)", () => {
    it("returns null for a token that was never issued", async () => {
      const store = makeStore(60_000);

      await expect(store.get("deadbeefdeadbeefdeadbeefdeadbeef")).resolves.toBeNull();
    });

    it("returns null for an empty token without throwing", async () => {
      const store = makeStore(60_000);

      await expect(store.get("")).resolves.toBeNull();
    });

    it("returns null for a near-miss token one hex digit off a live token", async () => {
      const store = makeStore(60_000);
      const session = await store.create("u1", "admin");

      const flipped = `${session.token.slice(0, -1)}${session.token.endsWith("0") ? "1" : "0"}`;
      expect(flipped).not.toBe(session.token);

      await expect(store.get(flipped)).resolves.toBeNull();
      // The real token is untouched by the failed lookup.
      await expect(store.get(session.token)).resolves.toMatchObject({ userId: "u1" });
    });

    it("does not count an unknown lookup as an evicted session", async () => {
      const store = makeStore(60_000);

      await store.get("nonexistent");
      await store.get("also-nonexistent");

      const stats = store.stats();
      expect(stats.expiredCleaned).toBe(0);
      expect(stats.activeSessions).toBe(0);
      expect(stats.totalCreated).toBe(0);
    });

    it("returns null after an explicit delete (token becomes unknown)", async () => {
      const store = makeStore(60_000);
      const session = await store.create("u1", "admin");

      await store.delete(session.token);

      await expect(store.get(session.token)).resolves.toBeNull();
      expect(store.stats().expiredCleaned).toBe(0);
    });
  });

  describe("expired session (L192 `return null` after lazy eviction)", () => {
    it("returns null once the TTL has elapsed", async () => {
      const store = makeStore(1_000);
      mockNow(BASE);
      const session = await store.create("u1", "admin");

      mockNow(BASE + 1_000);
      await expect(store.get(session.token)).resolves.toBeNull();
    });

    it("evicts the expired session so it can never be resurrected", async () => {
      const store = makeStore(1_000);
      mockNow(BASE);
      const session = await store.create("u1", "admin");

      mockNow(BASE + 1_000);
      await store.get(session.token);

      expect(store.stats().expiredCleaned).toBe(1);
      expect(store.stats().activeSessions).toBe(0);

      // Re-reading the same token now takes the unknown-token branch (L188):
      // expiry is not re-counted, so metrics stay stable.
      await expect(store.get(session.token)).resolves.toBeNull();
      expect(store.stats().expiredCleaned).toBe(1);
    });

    it("counts the session as created but not as active once expired", async () => {
      const store = makeStore(1_000);
      mockNow(BASE);
      const session = await store.create("u1", "admin");

      mockNow(BASE + 5_000);
      await store.get(session.token);

      expect(store.stats().totalCreated).toBe(1);
      expect(store.stats().expiredCleaned).toBe(1);
      expect(store.stats().activeSessions).toBe(0);
    });

    it("sweep() reports the same eviction count the read path would apply", async () => {
      const store = makeStore(1_000);
      mockNow(BASE);
      await store.create("u1", "admin");
      await store.create("u2", "admin");
      mockNow(BASE + 1_000);
      await store.create("u3", "admin"); // expires at BASE + 2_000

      mockNow(BASE + 1_500);
      expect(store.sweep()).toBe(2);
      expect(store.stats().expiredCleaned).toBe(2);
      expect(store.stats().activeSessions).toBe(1);
    });

    it("returns null for an expired session but not for a live sibling", async () => {
      const store = makeStore(1_000);
      mockNow(BASE);
      const live = await store.create("u1", "admin");
      mockNow(BASE + 1_000);
      const expiring = await store.create("u2", "admin");

      // `expiring` was created at BASE+1000 so it lives until BASE+2000.
      mockNow(BASE + 1_999);
      await expect(store.get(live.token)).resolves.toBeNull();
      await expect(store.get(expiring.token)).resolves.not.toBeNull();

      mockNow(BASE + 2_000);
      await expect(store.get(expiring.token)).resolves.toBeNull();
    });
  });

  describe("expiry boundary (normal vs failure path)", () => {
    it("returns the session 1ms before expiry and null exactly at expiry", async () => {
      const store = makeStore(1_000);
      mockNow(BASE);
      const session = await store.create("u1", "admin");
      expect(session.expiresAt).toBe(BASE + 1_000);

      mockNow(BASE + 999);
      const alive = await store.get(session.token);
      expect(alive).not.toBeNull();
      expect(alive!.token).toBe(session.token);

      mockNow(BASE + 1_000);
      await expect(store.get(session.token)).resolves.toBeNull();
    });

    it("never extends a session that is already expired, even via touch()", async () => {
      const store = makeStore(1_000);
      mockNow(BASE);
      const session = await store.create("u1", "admin");

      mockNow(BASE + 1_000);
      await expect(store.touch(session.token)).resolves.toBe(false);
      await expect(store.get(session.token)).resolves.toBeNull();
    });

    it("touch() on an unknown token returns false without touching metrics", async () => {
      const store = makeStore(60_000);
      const spy = jest.spyOn(globalMetrics, "incrementCounter");

      await expect(store.touch("nope")).resolves.toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(store.stats().expiredCleaned).toBe(0);
      spy.mockRestore();
    });

    it("treats a zero-length TTL session as already expired", async () => {
      const store = makeStore(0);
      mockNow(BASE);
      const session = await store.create("u1", "admin");

      await expect(store.get(session.token)).resolves.toBeNull();
      expect(store.stats().expiredCleaned).toBe(1);
    });
  });

  describe("normal path (no failure)", () => {
    it("returns the live session with the full public shape", async () => {
      const store = makeStore(60_000);
      mockNow(BASE);
      const session = await store.create("u1", "verifier");

      mockNow(BASE + 10_000);
      const found = await store.get(session.token);

      expect(found).toEqual({
        token: session.token,
        userId: "u1",
        role: "verifier",
        expiresAt: BASE + 60_000,
        createdAt: BASE,
        lastSeenAt: BASE,
      });
      expect(store.stats().expiredCleaned).toBe(0);
      expect(store.stats().activeSessions).toBe(1);
    });

    it("keeps sessions independent and returns null for a deleted user's token", async () => {
      const store = makeStore(60_000);
      mockNow(BASE);
      const alice = await store.create("alice", "admin");
      const bob = await store.create("bob", "investor");

      await expect(store.get(alice.token)).resolves.toMatchObject({ userId: "alice" });
      await expect(store.get(bob.token)).resolves.toMatchObject({ userId: "bob", role: "investor" });

      await store.deleteAllForUser("alice");
      await expect(store.get(alice.token)).resolves.toBeNull();
      await expect(store.get(bob.token)).resolves.not.toBeNull();
    });

    it("stop() clears sessions so subsequent lookups miss", async () => {
      const store = makeStore(60_000, { sweepIntervalMs: 10 });
      mockNow(BASE);
      const session = await store.create("u1", "admin");
      store.startSweep();
      store.startSweep(); // idempotent

      await expect(store.get(session.token)).resolves.not.toBeNull();
      store.stop();
      await expect(store.get(session.token)).resolves.toBeNull();
      expect(store.stats().activeSessions).toBe(0);
    });
  });
});

// ─── Suite: PostgresSessionStore get() failure paths ─────────────────────────

/**
 * Mirrors the real `sessions` table shape, where `role` is nullable for
 * non-web (API/JWT) sessions.
 */
interface StubRow extends Omit<Row, "role"> {
  role: string | null;
}

/**
 * Minimal repository stub that lets a test control the row returned by
 * `findByTokenHash` and observe the side effects of the lazy-cleanup path.
 */
class StubSessionRepository {
  row: StubRow | null = null;
  /** Rows the store asked to delete (lazy expiry cleanup). */
  readonly deleted: string[] = [];
  /** When set, `deleteByTokenHash` rejects to exercise the best-effort guard. */
  deleteError: Error | null = null;
  touchCalls = 0;
  deleteAllCalls: string[] = [];

  async findByTokenHash(): Promise<StubRow | null> {
    return this.row ? { ...this.row } : null;
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    this.deleted.push(tokenHash);
    if (this.deleteError) throw this.deleteError;
  }

  async touchExpiryByTokenHash(): Promise<void> {
    this.touchCalls += 1;
  }

  async deleteAllSessionsByUserId(userId: string): Promise<void> {
    this.deleteAllCalls.push(userId);
  }

  async countActive(): Promise<number> {
    return this.row ? 1 : 0;
  }

  async deleteExpired(): Promise<number> {
    return 0;
  }
}

function makeRow(overrides: Partial<StubRow> = {}): StubRow {
  return {
    id: "session-1",
    user_id: "u1",
    role: "admin",
    token_hash: hashSessionToken("placeholder-token"),
    expires_at: new Date(BASE + 60_000),
    created_at: new Date(BASE),
    ...overrides,
  };
}

describe("PostgresSessionStore – get() failure paths", () => {
  let repo: StubSessionRepository;
  let store: PostgresSessionStore;

  beforeEach(() => {
    repo = new StubSessionRepository();
    store = new PostgresSessionStore(repo as unknown as SessionRepository, {
      ttlMs: 60_000,
      now: () => BASE,
    });
    globalMetrics.reset();
  });

  describe("missing row (L412 `if (!row) return null`)", () => {
    it("returns null when the repository finds no row", async () => {
      repo.row = null;

      await expect(store.get("missing-token")).resolves.toBeNull();
    });

    it("returns null for an empty token and never queries a real session", async () => {
      repo.row = null;

      await expect(store.get("")).resolves.toBeNull();
      expect(repo.deleted).toHaveLength(0);
    });

    it("performs no delete side effect for a missing row", async () => {
      repo.row = null;

      await store.get("missing-token");

      expect(repo.deleted).toEqual([]);
    });

    it("keeps returning null across repeated lookups of the same missing token", async () => {
      repo.row = null;

      await expect(store.get("missing-token")).resolves.toBeNull();
      await expect(store.get("missing-token")).resolves.toBeNull();
      expect(repo.deleted).toHaveLength(0);
    });
  });

  describe("rejected rows are indistinguishable from missing rows", () => {
    it("returns null when the stored hash does not match the presented token", async () => {
      repo.row = makeRow({ token_hash: hashSessionToken("some-other-token") });

      await expect(store.get("presented-token")).resolves.toBeNull();
    });

    it("returns null for a revoked row without attempting cleanup", async () => {
      const token = "presented-token";
      repo.row = makeRow({
        token_hash: hashSessionToken(token),
        revoked_at: new Date(BASE - 1),
      });

      await expect(store.get(token)).resolves.toBeNull();
      expect(repo.deleted).toEqual([]);
    });

    it("returns null for a row whose revocation is in the future relative to the clock", async () => {
      // `revoked_at` is presence-checked, not compared — any non-null value wins.
      const token = "presented-token";
      repo.row = makeRow({
        token_hash: hashSessionToken(token),
        revoked_at: new Date(BASE + 1),
      });

      await expect(store.get(token)).resolves.toBeNull();
    });

    it("returns null for an empty stored hash (unusable row)", async () => {
      repo.row = makeRow({ token_hash: "" });

      await expect(store.get("presented-token")).resolves.toBeNull();
    });
  });

  describe("expired row triggers best-effort lazy cleanup", () => {
    it("returns null and deletes the row when expiry has passed", async () => {
      const token = "presented-token";
      repo.row = makeRow({
        token_hash: hashSessionToken(token),
        expires_at: new Date(BASE - 1),
      });

      await expect(store.get(token)).resolves.toBeNull();
      expect(repo.deleted).toEqual([hashSessionToken(token)]);
    });

    it("still returns null when the cleanup delete rejects", async () => {
      const token = "presented-token";
      repo.row = makeRow({
        token_hash: hashSessionToken(token),
        expires_at: new Date(BASE - 1),
      });
      repo.deleteError = new Error("db unavailable");

      await expect(store.get(token)).resolves.toBeNull();
      expect(repo.deleted).toEqual([hashSessionToken(token)]);
    });

    it("treats expires_at exactly equal to now as expired", async () => {
      const token = "presented-token";
      repo.row = makeRow({
        token_hash: hashSessionToken(token),
        expires_at: new Date(BASE),
      });

      await expect(store.get(token)).resolves.toBeNull();
      expect(repo.deleted).toHaveLength(1);
    });

    it("returns the session when expiry is 1ms in the future", async () => {
      const token = "presented-token";
      repo.row = makeRow({
        token_hash: hashSessionToken(token),
        expires_at: new Date(BASE + 1),
      });

      const found = await store.get(token);
      expect(found).not.toBeNull();
      expect(found!.token).toBe(token);
      expect(repo.deleted).toHaveLength(0);
    });
  });

  describe("touch() mirrors the get() failure contract", () => {
    it("returns false when no row exists", async () => {
      repo.row = null;

      await expect(store.touch("missing-token")).resolves.toBe(false);
      expect(repo.touchCalls).toBe(0);
    });

    it("returns false for an expired row and does not extend it", async () => {
      const token = "presented-token";
      repo.row = makeRow({
        token_hash: hashSessionToken(token),
        expires_at: new Date(BASE - 1),
      });

      await expect(store.touch(token)).resolves.toBe(false);
      expect(repo.touchCalls).toBe(0);
    });

    it("returns false for a revoked row", async () => {
      const token = "presented-token";
      repo.row = makeRow({
        token_hash: hashSessionToken(token),
        revoked_at: new Date(BASE),
      });

      await expect(store.touch(token)).resolves.toBe(false);
    });

    it("extends a live row and honours maxExtendedExpiry", async () => {
      const token = "presented-token";
      repo.row = makeRow({
        token_hash: hashSessionToken(token),
        created_at: new Date(BASE - 200_000),
        expires_at: new Date(BASE + 60_000),
      });

      const capped = new PostgresSessionStore(repo as unknown as SessionRepository, {
        ttlMs: 60_000,
        now: () => BASE,
        maxExtendedExpiry: 300_000,
      });

      await expect(capped.touch(token)).resolves.toBe(true);
      expect(repo.touchCalls).toBe(1);
    });
  });

  describe("normal path and mapping", () => {
    it("returns the live session mapped from the row", async () => {
      const token = generateSessionToken();
      repo.row = makeRow({
        user_id: "u42",
        role: "investor",
        token_hash: hashSessionToken(token),
        expires_at: new Date(BASE + 90_000),
        created_at: new Date(BASE - 5_000),
      });

      await expect(store.get(token)).resolves.toEqual({
        token,
        userId: "u42",
        role: "investor",
        expiresAt: BASE + 90_000,
        createdAt: BASE - 5_000,
        lastSeenAt: BASE,
      });
      expect(repo.deleted).toHaveLength(0);
    });

    it("maps a null role to an empty string rather than leaking null", async () => {
      const token = generateSessionToken();
      repo.row = makeRow({ token_hash: hashSessionToken(token), role: null });

      const found = await store.get(token);
      expect(found).not.toBeNull();
      expect(found!.role).toBe("");
    });

    it("delete() and deleteAllForUser() delegate by hashed token / user id", async () => {
      const token = generateSessionToken();

      await store.delete(token);
      await store.deleteAllForUser("u1");

      expect(repo.deleted).toEqual([hashSessionToken(token)]);
      expect(repo.deleteAllCalls).toEqual(["u1"]);
    });

    it("stats() delegates the active count to the repository", async () => {
      repo.row = makeRow();

      await expect(store.stats()).resolves.toEqual({ activeSessions: 1 });
    });
  });
});

// ─── Suite: token-hash helpers ───────────────────────────────────────────────

describe("constantTimeHexEqual – boundary inputs", () => {
  it("returns true for identical hashes", () => {
    const hash = hashSessionToken("t");
    expect(constantTimeHexEqual(hash, hash)).toBe(true);
  });

  it("returns false for different hashes of equal length", () => {
    expect(constantTimeHexEqual(hashSessionToken("a"), hashSessionToken("b"))).toBe(false);
  });

  it("returns false for differing lengths without throwing", () => {
    expect(constantTimeHexEqual("aabb", "aabbcc")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(constantTimeHexEqual("", "")).toBe(false);
  });

  it("hashSessionToken is a stable lowercase hex SHA-256", () => {
    const hash = hashSessionToken("stable-input");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken("stable-input")).toBe(hash);
    expect(hashSessionToken("other-input")).not.toBe(hash);
  });

  it("generateSessionToken produces unique 128-bit hex tokens", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateSessionToken()));
    expect(tokens.size).toBe(500);
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});
