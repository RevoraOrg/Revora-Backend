/**
 * @file src/lib/postgresSessionStore.test.ts
 * @description
 * Unit tests for PostgresSessionStore.
 *
 * Strategy: a lightweight in-memory fake of SessionRepository keyed by
 * token_hash stands in for Postgres. Because the fake is just a Map, sharing
 * one fake across two PostgresSessionStore instances faithfully simulates two
 * app instances (or a restart) talking to the same database.
 *
 * Security invariants verified:
 *  - The raw token is never persisted — only its SHA-256 hash.
 *  - Lookups use a constant-time hash comparison (a tampered stored hash is
 *    rejected).
 *  - Expired and revoked sessions are rejected and indistinguishable from
 *    unknown ones.
 */

import {
  PostgresSessionStore,
  hashSessionToken,
} from "./sessionStore";
import type { SessionRepository } from "../db/repositories/sessionRepository";

// ─── In-memory fake repository ──────────────────────────────────────────────

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
  readonly rows = new Map<string, Row>(); // keyed by token_hash
  private seq = 0;

  // The real repo compares against the DB's NOW(); the fake mirrors that with
  // the same injectable clock the store under test uses, so time-travel tests
  // stay consistent across both layers.
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
}

function makeStore(repo: FakeSessionRepository, now: () => number, ttlMs = 60_000) {
  // Normalize all known roles to ttlMs for backward-compatible test behavior.
  const flatRoleTtl: Record<string, number> = {
    admin: ttlMs,
    verifier: ttlMs,
    issuer: ttlMs,
    investor: ttlMs,
    anonymous: ttlMs,
  };
  return new PostgresSessionStore(repo as unknown as SessionRepository, {
    ttlMs,
    now,
    roleTtlMs: flatRoleTtl,
  });
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe("PostgresSessionStore", () => {
  describe("create()", () => {
    it("returns a session with a 128-bit hex token and the supplied role", async () => {
      const repo = new FakeSessionRepository();
      const store = makeStore(repo, () => 1_000);

      const session = await store.create("user-1", "admin");

      expect(session.token).toMatch(/^[0-9a-f]{32}$/);
      expect(session.userId).toBe("user-1");
      expect(session.role).toBe("admin");
      expect(session.expiresAt).toBe(1_000 + 60_000);
    });

    it("stores only the SHA-256 hash of the token, never the plaintext", async () => {
      const repo = new FakeSessionRepository();
      const store = makeStore(repo, () => 0);

      const session = await store.create("user-1", "client");

      const stored = [...repo.rows.values()];
      expect(stored).toHaveLength(1);
      // The plaintext token must not appear anywhere in the stored row.
      expect(JSON.stringify(stored[0])).not.toContain(session.token);
      // The stored hash must equal the SHA-256 of the token.
      expect(stored[0].token_hash).toBe(hashSessionToken(session.token));
      expect(repo.rows.has(session.token)).toBe(false);
    });
  });

  describe("get()", () => {
    it("returns the session for a valid token", async () => {
      const repo = new FakeSessionRepository();
      const store = makeStore(repo, () => 0);

      const created = await store.create("user-1", "admin");
      const found = await store.get(created.token);

      expect(found).not.toBeNull();
      expect(found!.userId).toBe("user-1");
      expect(found!.role).toBe("admin");
    });

    it("returns null for an unknown token", async () => {
      const repo = new FakeSessionRepository();
      const store = makeStore(repo, () => 0);

      expect(await store.get("deadbeef".repeat(4))).toBeNull();
    });

    it("rejects and evicts an expired session", async () => {
      const repo = new FakeSessionRepository();
      let nowValue = 0;
      const store = makeStore(repo, () => nowValue, 1_000);

      const created = await store.create("user-1", "admin");
      nowValue = 2_000; // past the 1s TTL

      const found = await store.get(created.token);

      expect(found).toBeNull();
      // Expired row is lazily deleted.
      expect(repo.rows.size).toBe(0);
    });

    it("rejects a revoked session", async () => {
      const repo = new FakeSessionRepository();
      const store = makeStore(repo, () => 0);

      const created = await store.create("user-1", "admin");
      // Simulate revocation in the DB.
      repo.rows.get(hashSessionToken(created.token))!.revoked_at = new Date(0);

      expect(await store.get(created.token)).toBeNull();
    });

    it("rejects when the stored hash does not match (constant-time guard)", async () => {
      const repo = new FakeSessionRepository();
      const store = makeStore(repo, () => 0);

      const created = await store.create("user-1", "admin");
      const realHash = hashSessionToken(created.token);
      const row = repo.rows.get(realHash)!;
      // Re-key the row under the looked-up hash but tamper the stored hash
      // to a different value of equal length.
      row.token_hash = "f".repeat(realHash.length);

      expect(await store.get(created.token)).toBeNull();
    });
  });

  describe("touch()", () => {
    it("extends the expiry of a live session and returns true", async () => {
      const repo = new FakeSessionRepository();
      let nowValue = 0;
      const store = makeStore(repo, () => nowValue, 60_000);

      const created = await store.create("user-1", "admin");
      nowValue = 30_000;

      const ok = await store.touch(created.token);
      expect(ok).toBe(true);

      const row = repo.rows.get(hashSessionToken(created.token))!;
      expect(row.expires_at.getTime()).toBe(30_000 + 60_000);
    });

    it("returns false for an unknown token", async () => {
      const repo = new FakeSessionRepository();
      const store = makeStore(repo, () => 0);
      expect(await store.touch("ab".repeat(16))).toBe(false);
    });
  });

  describe("delete()", () => {
    it("removes the session so subsequent get() returns null", async () => {
      const repo = new FakeSessionRepository();
      const store = makeStore(repo, () => 0);

      const created = await store.create("user-1", "admin");
      await store.delete(created.token);

      expect(await store.get(created.token)).toBeNull();
      expect(repo.rows.size).toBe(0);
    });

    it("is idempotent for an unknown token", async () => {
      const repo = new FakeSessionRepository();
      const store = makeStore(repo, () => 0);
      await expect(store.delete("cd".repeat(16))).resolves.toBeUndefined();
    });
  });

  describe("cleanupExpired()", () => {
    it("removes only expired rows and returns the count", async () => {
      let nowValue = 0;
      const repo = new FakeSessionRepository(() => nowValue);
      const store = makeStore(repo, () => nowValue, 1_000);

      const shortLived = await store.create("u1", "admin"); // expires at 1_000
      const longStore = makeStore(repo, () => nowValue, 100_000);
      const longLived = await longStore.create("u2", "client"); // expires at 100_000

      nowValue = 5_000;
      const removed = await store.cleanupExpired();

      expect(removed).toBe(1);
      expect(repo.rows.has(hashSessionToken(shortLived.token))).toBe(false);
      expect(repo.rows.has(hashSessionToken(longLived.token))).toBe(true);
    });
  });

  describe("persistence across restart / shared instances", () => {
    it("a second store over the same DB resolves a token created by the first", async () => {
      const repo = new FakeSessionRepository();
      const storeA = makeStore(repo, () => 0);

      const created = await storeA.create("user-1", "admin");

      // Simulate a restart / a different app instance: brand-new store object,
      // same backing database.
      const storeB = makeStore(repo, () => 0);
      const found = await storeB.get(created.token);

      expect(found).not.toBeNull();
      expect(found!.userId).toBe("user-1");
      expect(found!.role).toBe("admin");
    });
  });

  describe("stats()", () => {
    it("counts only live sessions", async () => {
      let nowValue = 0;
      const repo = new FakeSessionRepository(() => nowValue);
      const store = makeStore(repo, () => nowValue, 1_000);

      await store.create("u1", "admin"); // expires at 1_000
      const longStore = makeStore(repo, () => nowValue, 100_000);
      await longStore.create("u2", "client"); // expires at 100_000

      nowValue = 5_000;
      expect(await store.stats()).toEqual({ activeSessions: 1 });
    });
  });
});
