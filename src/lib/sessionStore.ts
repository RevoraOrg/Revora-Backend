/**
 * @module session/SessionStore
 * @description
 * In-memory session registry with TTL-based expiry for the Revora backend.
 *
 * Design rationale:
 *  - Sessions are keyed by a server-issued opaque token (not user-controlled).
 *  - Every read transparently evicts expired sessions so memory doesn't grow
 *    unbounded even if the background sweep is delayed.
 *  - The background sweep is a belt-and-suspenders mechanism; correctness does
 *    not depend on it running on time.
 *  - All public methods are synchronous-safe but return Promises so the
 *    interface can be backed by Redis or Postgres without callers changing.
 *
 * @security
 *  - Session tokens are generated with `crypto.randomBytes` (128 bits of
 *    entropy) — not user-supplied values, not UUIDs, not sequential ids.
 *  - TTL is enforced at creation time; callers cannot extend a session without
 *    explicit renewal through `touch()`.
 *  - Expired sessions are never returned to callers — they are treated as
 *    if they never existed (no "session found but expired" branch that an
 *    attacker could observe).
 */

import { randomBytes, createHash, timingSafeEqual } from "crypto";
import type { SessionRepository } from "../db/repositories/sessionRepository";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Session {
  /** Opaque server-generated token. */
  token:     string;
  userId:    string;
  role:      string;
  /** Absolute expiry timestamp (ms since epoch). */
  expiresAt: number;
  createdAt: number;
  /** Last time the session was touched/used. */
  lastSeenAt: number;
}

/**
 * The minimal surface the HTTP session middleware depends on. Both the
 * in-memory {@link SessionStore} and the {@link PostgresSessionStore} satisfy
 * it, so the middleware can be wired to either without changes.
 */
export interface ISessionStore {
  create(userId: string, role: string): Promise<Session>;
  get(token: string): Promise<Session | null>;
  touch(token: string): Promise<boolean>;
  delete(token: string): Promise<void>;
  deleteAllForUser(userId: string): Promise<void>;
}

export interface SessionStoreOptions {
  /**
   * How long a new session lives without activity (milliseconds).
   * @default 3_600_000  (1 hour)
   */
  ttlMs?: number;
  /**
   * How often the background sweep runs (milliseconds).
   * Set to 0 to disable the sweep (useful in tests).
   * @default 300_000  (5 minutes)
   */
  sweepIntervalMs?: number;
}

export interface SessionStats {
  activeSessions:  number;
  expiredCleaned:  number;
  totalCreated:    number;
}

// ─── SessionStore ─────────────────────────────────────────────────────────────

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs:           number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Running total of sessions deleted by any cleanup path. */
  private expiredCleaned = 0;
  /** Running total of sessions ever created. */
  private totalCreated = 0;

  constructor(opts: SessionStoreOptions = {}) {
    this.ttlMs           = opts.ttlMs           ?? 3_600_000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 300_000;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the background expiry sweep.
   * Must be called once after construction (handled by the bootstrap layer).
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  startSweep(): void {
    if (this.sweepTimer !== null || this.sweepIntervalMs === 0) return;

    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);

    // Don't let the timer prevent the process from exiting cleanly.
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /**
   * Stop the background sweep and clear all sessions.
   * Call during graceful shutdown so the process exits cleanly.
   */
  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.sessions.clear();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Create a new session for the given user and return its token.
   *
   * @param userId - The authenticated user's id.
   * @param role   - The user's role claim.
   * @returns      The opaque session token the client should store.
   */
  async create(userId: string, role: string): Promise<Session> {
    const token = randomBytes(16).toString("hex"); // 128-bit entropy
    const now   = Date.now();

    const session: Session = {
      token,
      userId,
      role,
      expiresAt:  now + this.ttlMs,
      createdAt:  now,
      lastSeenAt: now,
    };

    this.sessions.set(token, session);
    this.totalCreated += 1;
    return session;
  }

  /**
   * Look up a session by token.
   * Returns `null` if the token is unknown OR if the session has expired.
   * Expired sessions are evicted on first read (lazy expiry).
   *
   * @param token - The opaque session token.
   */
  async get(token: string): Promise<Session | null> {
    const session = this.sessions.get(token);
    if (!session) return null;

    if (this.isExpired(session)) {
      this.evict(token);
      return null;
    }

    return session;
  }

  /**
   * Extend a session's TTL by resetting its expiry to `now + ttlMs`.
   * Returns `false` if the session is not found or has already expired.
   *
   * @param token - The opaque session token.
   */
  async touch(token: string): Promise<boolean> {
    const session = this.sessions.get(token);
    if (!session || this.isExpired(session)) {
      if (session) this.evict(token);
      return false;
    }

    const now = Date.now();
    session.expiresAt  = now + this.ttlMs;
    session.lastSeenAt = now;
    return true;
  }

  /**
   * Explicitly invalidate (delete) a session.
   * Idempotent — safe to call on an already-expired or missing token.
   *
   * @param token - The opaque session token.
   */
  async delete(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  /**
   * Delete all sessions for a specific user.
   */
  async deleteAllForUser(userId: string): Promise<void> {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId) {
        this.evict(token);
      }
    }
  }

  /**
   * Return a snapshot of current store metrics.
   * Safe to call at any time; does not trigger a sweep.
   */
  stats(): SessionStats {
    // Count only live (non-expired) sessions in the active count.
    const now = Date.now();
    let active = 0;
    for (const s of this.sessions.values()) {
      if (s.expiresAt > now) active += 1;
    }

    return {
      activeSessions: active,
      expiredCleaned: this.expiredCleaned,
      totalCreated:   this.totalCreated,
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Synchronous sweep — iterates all sessions and evicts expired ones.
   * Called by the background timer and exposed for deterministic testing.
   * @returns Number of sessions evicted in this sweep.
   */
  sweep(): number {
    let evicted = 0;
    for (const [token, session] of this.sessions) {
      if (this.isExpired(session)) {
        this.evict(token);
        evicted += 1;
      }
    }
    return evicted;
  }

  private isExpired(session: Session): boolean {
    return Date.now() >= session.expiresAt;
  }

  private evict(token: string): void {
    this.sessions.delete(token);
    this.expiredCleaned += 1;
  }
}

/** Singleton instance shared across the application. */
export const sessionStore = new SessionStore();

// ─── Token hashing helpers ──────────────────────────────────────────────────

/**
 * Derive the at-rest representation of a session token.
 *
 * We store a SHA-256 hash, never the plaintext token. SHA-256 (not scrypt) is
 * the correct choice here: the token already carries 128 bits of cryptographic
 * entropy, so it is not brute-forceable from its hash — a slow KDF would only
 * add latency to every request with no security benefit.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Generate a new opaque session token (128 bits of entropy, hex-encoded). */
export function generateSessionToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Constant-time comparison of two hex-encoded hashes of equal length.
 * Returns false (without leaking via timing) when lengths differ.
 */
export function constantTimeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─── PostgresSessionStore ────────────────────────────────────────────────────

export interface PostgresSessionStoreOptions {
  /**
   * Session lifetime in milliseconds.
   * @default 3_600_000 (1 hour)
   */
  ttlMs?: number;
  /**
   * How often the cleanup job removes expired rows (milliseconds).
   * Set to 0 to disable (the default — call {@link PostgresSessionStore.startCleanup}
   * explicitly from the bootstrap layer).
   * @default 0
   */
  cleanupIntervalMs?: number;
  /** Injectable clock for deterministic testing. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Postgres-backed {@link ISessionStore}.
 *
 * Unlike the in-memory {@link SessionStore}, sessions here survive process
 * restarts and are shared across instances. Tokens are stored as SHA-256
 * hashes (never plaintext) and validated with a constant-time comparison.
 */
export class PostgresSessionStore implements ISessionStore {
  private readonly ttlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly now: () => number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repo: SessionRepository,
    opts: PostgresSessionStoreOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.cleanupIntervalMs = opts.cleanupIntervalMs ?? 0;
    this.now = opts.now ?? Date.now;
  }

  // ─── ISessionStore ─────────────────────────────────────────────────────────

  async create(userId: string, role: string): Promise<Session> {
    const token = generateSessionToken();
    const tokenHash = hashSessionToken(token);
    const now = this.now();
    const expiresAt = new Date(now + this.ttlMs);

    const row = await this.repo.createWebSession({
      user_id: userId,
      role,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });

    return this.toSession(row, token);
  }

  async get(token: string): Promise<Session | null> {
    const tokenHash = hashSessionToken(token);
    const row = await this.repo.findByTokenHash(tokenHash);
    if (!row) return null;

    // Constant-time guard against any non-exact DB match.
    if (!constantTimeHexEqual(row.token_hash, tokenHash)) return null;

    // Revoked and expired sessions are treated as if they never existed.
    if (row.revoked_at) return null;
    if (new Date(row.expires_at).getTime() <= this.now()) {
      // Lazy cleanup — best-effort, never blocks the rejection.
      await this.repo.deleteByTokenHash(tokenHash).catch(() => undefined);
      return null;
    }

    return this.toSession(row, token);
  }

  async touch(token: string): Promise<boolean> {
    const existing = await this.get(token);
    if (!existing) return false;
    const expiresAt = new Date(this.now() + this.ttlMs);
    await this.repo.touchExpiryByTokenHash(hashSessionToken(token), expiresAt);
    return true;
  }

  async delete(token: string): Promise<void> {
    await this.repo.deleteByTokenHash(hashSessionToken(token));
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.repo.deleteAllSessionsByUserId(userId);
  }

  // ─── Cleanup job ─────────────────────────────────────────────────────────

  /** Remove every expired session row. Returns the number deleted. */
  async cleanupExpired(): Promise<number> {
    return this.repo.deleteExpired();
  }

  /** Start the periodic cleanup job. No-op if already running or disabled. */
  startCleanup(): void {
    if (this.cleanupTimer !== null || this.cleanupIntervalMs === 0) return;
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpired().catch(() => undefined);
    }, this.cleanupIntervalMs);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Stop the periodic cleanup job. */
  stop(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Snapshot of store metrics (active = non-expired, non-revoked). */
  async stats(): Promise<{ activeSessions: number }> {
    return { activeSessions: await this.repo.countActive() };
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private toSession(row: { user_id: string; role?: string | null; expires_at: Date }, token: string): Session {
    const now = this.now();
    return {
      token,
      userId: row.user_id,
      role: row.role ?? "",
      expiresAt: new Date(row.expires_at).getTime(),
      createdAt: now,
      lastSeenAt: now,
    };
  }
}