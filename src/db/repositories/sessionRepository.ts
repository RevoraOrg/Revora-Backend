import { Pool, QueryResult } from 'pg';
import crypto from 'crypto';

export interface Session {
  id: string;
  user_id: string;
  token_hash: string;   // store a hash of the token, never the raw JWT
  expires_at: Date;
  created_at: Date;
  parent_id?: string;
  revoked_at?: Date;
  token_consumed_at?: Date | null;
  /** Authorization role carried by the session (web/browser sessions). */
  role?: string | null;
}

export interface CreateSessionInput {
  id?: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  parent_id?: string;
}

export interface CreateWebSessionInput {
  id?: string;
  user_id: string;
  role: string;
  token_hash: string;
  expires_at: Date;
}

/**
 * SessionRepository — DB-backed implementation of the SessionRepository
 * interface declared in src/auth/logout/types.ts.
 *
 * Stores session records so tokens can be invalidated on logout.
 */
export class SessionRepository {
  constructor(private db: Pool) {}

  async createSession(input: CreateSessionInput, client?: Pool): Promise<Session> {
    const db = client || this.db;
    // allow explicit session id (for upstream session id generation) or default DB uuid.
    if (input.id) {
      const query = `
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, parent_id)
        VALUES ($1, $2, $3, $4, NOW(), $5)
        RETURNING *
      `;
      const result: QueryResult<Session> = await db.query(query, [
        input.id,
        input.user_id,
        input.token_hash,
        input.expires_at,
        input.parent_id || null,
      ]);
      if (result.rows.length === 0) throw new Error('Failed to create session');
      return this.mapSession(result.rows[0]);
    }

    const query = `
      INSERT INTO sessions (id, user_id, token_hash, expires_at, parent_id, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `;
    const result: QueryResult<Session> = await db.query(query, [
      crypto.randomUUID(),
      input.user_id,
      input.token_hash,
      input.expires_at,
      input.parent_id || null,
    ]);
    if (result.rows.length === 0) throw new Error('Failed to create session');
    return this.mapSession(result.rows[0]);
  }

  async setSessionMetadata(sessionId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET token_hash = $1, expires_at = $2 WHERE id = $3`,
      [tokenHash, expiresAt, sessionId],
    );
  }

  async setSessionConsumed(sessionId: string, client?: Pool): Promise<void> {
    const db = client || this.db;
    await db.query(`UPDATE sessions SET token_consumed_at = NOW() WHERE id = $1`, [sessionId]);
  }

  /**
   * Backward-compatible helper retained for legacy callers/tests.
   * Creates a session shell and returns its id so metadata can be set later.
   */
  async createSessionForUser(userId: string): Promise<string> {
    const created = await this.createSession({
      id: crypto.randomUUID(),
      user_id: userId,
      token_hash: '',
      expires_at: new Date(0),
    });
    return created.id;
  }

  async createSessionWithId(
    userId: string,
    sessionId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<string> {
    const session = await this.createSession({
      id: sessionId,
      user_id: userId,
      token_hash: tokenHash,
      expires_at: expiresAt,
    });
    return session.id;
  }

  async findById(id: string, client?: Pool): Promise<Session | null> {
    const db = client || this.db;
    const query = `SELECT * FROM sessions WHERE id = $1 LIMIT 1`;
    const result: QueryResult<Session> = await db.query(query, [id]);
    return result.rows.length > 0 ? this.mapSession(result.rows[0]) : null;
  }

  async findByIdForUpdate(id: string, client: Pool): Promise<Session | null> {
    const query = `SELECT * FROM sessions WHERE id = $1 LIMIT 1 FOR UPDATE`;
    const result: QueryResult<Session> = await client.query(query, [id]);
    return result.rows.length > 0 ? this.mapSession(result.rows[0]) : null;
  }

  async findByParentId(parentId: string, client?: Pool): Promise<Session | null> {
    const db = client || this.db;
    const query = `SELECT * FROM sessions WHERE parent_id = $1 LIMIT 1`;
    const result: QueryResult<Session> = await db.query(query, [parentId]);
    return result.rows.length > 0 ? this.mapSession(result.rows[0]) : null;
  }

  /**
   * Revoke a session and all its descendants.
   */
  async revokeSessionAndDescendants(sessionId: string, client?: Pool): Promise<void> {
    const db = client || this.db;
    const query = `
      WITH RECURSIVE descendants AS (
        SELECT id FROM sessions WHERE id = $1
        UNION ALL
        SELECT s.id FROM sessions s
        JOIN descendants d ON s.parent_id = d.id
      )
      UPDATE sessions
      SET revoked_at = NOW()
      WHERE id IN (SELECT id FROM descendants)
        AND revoked_at IS NULL;
    `;
    await db.query(query, [sessionId]);
  }

  /**
   * Satisfies the SessionRepository interface from src/auth/logout/types.ts.
   * Called by LogoutService.
   */
  async deleteSessionById(sessionId: string): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  }

  /**
   * Delete all sessions belonging to a user (e.g. on password change).
   */
  async deleteAllSessionsByUserId(userId: string, client?: Pool): Promise<void> {
    const db = client || this.db;
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  }

  // ─── Web/browser session helpers (used by PostgresSessionStore) ────────────
  //
  // These methods back the SessionStore interface consumed by the HTTP session
  // middleware.  They always operate on the SHA-256 `token_hash` of an opaque,
  // high-entropy token — the raw token is never stored or queried.

  /**
   * Create a browser session row carrying an authorization `role`.
   * The caller is responsible for hashing the token before it reaches here.
   */
  async createWebSession(input: CreateWebSessionInput, client?: Pool): Promise<Session> {
    const db = client || this.db;
    const query = `
      INSERT INTO sessions (id, user_id, role, token_hash, expires_at, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `;
    const result: QueryResult<Session> = await db.query(query, [
      input.id || crypto.randomUUID(),
      input.user_id,
      input.role,
      input.token_hash,
      input.expires_at,
    ]);
    if (result.rows.length === 0) throw new Error('Failed to create session');
    return this.mapSession(result.rows[0]);
  }

  /**
   * Look up a session by its token hash. Returns the row regardless of
   * expiry/revocation state — the caller (PostgresSessionStore) performs the
   * constant-time hash comparison and the expiry/revocation checks so those
   * decisions live in one auditable place.
   */
  async findByTokenHash(tokenHash: string, client?: Pool): Promise<Session | null> {
    const db = client || this.db;
    const query = `SELECT * FROM sessions WHERE token_hash = $1 LIMIT 1`;
    const result: QueryResult<Session> = await db.query(query, [tokenHash]);
    return result.rows.length > 0 ? this.mapSession(result.rows[0]) : null;
  }

  /** Delete a single session by its token hash (used for logout). Idempotent. */
  async deleteByTokenHash(tokenHash: string, client?: Pool): Promise<void> {
    const db = client || this.db;
    await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
  }

  /** Extend a session's expiry (sliding window) by token hash. */
  async touchExpiryByTokenHash(tokenHash: string, expiresAt: Date, client?: Pool): Promise<void> {
    const db = client || this.db;
    await db.query(
      `UPDATE sessions SET expires_at = $1 WHERE token_hash = $2`,
      [expiresAt, tokenHash],
    );
  }

  /**
   * Delete all sessions whose expiry has passed. Returns the number removed.
   * Backs the periodic cleanupExpired job.
   */
  async deleteExpired(client?: Pool): Promise<number> {
    const db = client || this.db;
    const result = await db.query(`DELETE FROM sessions WHERE expires_at <= NOW()`);
    return result.rowCount ?? 0;
  }

  /** Count sessions that are neither expired nor revoked. */
  async countActive(client?: Pool): Promise<number> {
    const db = client || this.db;
    const result = await db.query(
      `SELECT COUNT(*)::int AS count FROM sessions
        WHERE expires_at > NOW() AND revoked_at IS NULL`,
    );
    return result.rows[0]?.count ?? 0;
  }

  /**
   * Get the date of the oldest expired or revoked session.
   * Useful for calculating retention lag before compaction.
   */
  async getOldestCompactedSessionDate(cutoffDate: Date, client?: Pool): Promise<Date | null> {
    const db = client || this.db;
    const query = `
      SELECT MIN(LEAST(COALESCE(expires_at, 'infinity'::timestamp), COALESCE(revoked_at, 'infinity'::timestamp))) AS oldest
      FROM sessions
      WHERE expires_at < $1 OR revoked_at < $1
    `;
    const result = await db.query(query, [cutoffDate]);
    return result.rows[0]?.oldest ?? null;
  }

  /**
   * Delete expired or revoked sessions older than a specific cutoff date.
   * Uses a bounded batch size to avoid long-held locks.
   * 
   * Returns the number of rows deleted in this batch.
   */
  async purgeOlderThan(cutoffDate: Date, batchSize: number, client?: Pool): Promise<number> {
    const db = client || this.db;
    const query = `
      DELETE FROM sessions 
      WHERE id IN (
        SELECT id FROM sessions 
        WHERE expires_at < $1 OR revoked_at < $1 
        LIMIT $2
      )
    `;
    const result = await db.query(query, [cutoffDate, batchSize]);
    return result.rowCount ?? 0;
  }

  /**
   * Run VACUUM on the sessions table to reclaim space after bulk deletions.
   * Note: VACUUM cannot be run inside a transaction block.
   */
  async vacuumSessions(): Promise<void> {
    // We use the direct pool because VACUUM cannot run in a transaction block
    // and passing a client could inadvertently be inside one.
    await this.db.query(`VACUUM sessions;`);
  }

  private mapSession(row: any): Session {
    return {
      id: row.id,
      user_id: row.user_id,
      token_hash: row.token_hash,
      expires_at: row.expires_at,
      created_at: row.created_at,
      parent_id: row.parent_id,
      revoked_at: row.revoked_at,
      token_consumed_at: row.token_consumed_at,
      role: row.role ?? null,
    };
  }
}
