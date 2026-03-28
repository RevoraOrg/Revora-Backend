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

import { randomBytes } from "crypto";

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