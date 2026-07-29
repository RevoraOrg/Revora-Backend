import { SessionStore, PostgresSessionStore, hashSessionToken } from "../sessionStore";
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

  constructor(private readonly clock: () => number = () => Date.now()) {}

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

  async deleteAllSessionsByUserId(_userId: string): Promise<void> {
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
      expect(admin.expiresAt - now).toBeLessThan(DEFAULT_ROLE_TTL.admin + 10);

      const investor = await store.create("u2", "investor");
      expect(investor.expiresAt - now).toBeGreaterThanOrEqual(DEFAULT_ROLE_TTL.investor);
      expect(investor.expiresAt - now).toBeLessThan(DEFAULT_ROLE_TTL.investor + 10);
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
      expect(session.expiresAt - now).toBeLessThan(5_005);
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
      expect(admin.expiresAt - now).toBeLessThan(2_005);

      const other = await store.create("u2", "unknown");
      expect(other.expiresAt - now).toBeGreaterThanOrEqual(10_000);
      expect(other.expiresAt - now).toBeLessThan(10_010);
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
