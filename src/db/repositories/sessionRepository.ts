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
}

export interface CreateSessionInput {
  id?: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  parent_id?: string;
}

/**
 * SessionRepository — DB-backed implementation of the SessionRepository
 * interface declared in src/auth/logout/types.ts.
 *
 * Stores session records so tokens can be invalidated on logout.
 */
export class SessionRepository {
  constructor(private db: Pool) {}

  async createSession(input: CreateSessionInput): Promise<Session> {
    // allow explicit session id (for upstream session id generation) or default DB uuid.
    if (input.id) {
      const query = `
        INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING *
      `;
      const result: QueryResult<Session> = await this.db.query(query, [
        input.id,
        input.user_id,
        input.token_hash,
        input.expires_at,
      ]);
      if (result.rows.length === 0) throw new Error('Failed to create session');
      return this.mapSession(result.rows[0]);
    }

    const query = `
      INSERT INTO sessions (id, user_id, token_hash, expires_at, parent_id, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `;
    const result: QueryResult<Session> = await this.db.query(query, [
      input.id || crypto.randomUUID(),
      input.user_id,
      input.token_hash,
      input.expires_at,
      input.parent_id || null,
    ]);
    if (result.rows.length === 0) throw new Error('Failed to create session');
    return this.mapSession(result.rows[0]);
  }

  async createSessionForUser(userId: string): Promise<string> {
    const placeholder = await this.createSession({
      user_id: userId,
      token_hash: '',
      expires_at: new Date(0),
    });
    return placeholder.id;
  }

  async setSessionMetadata(sessionId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET token_hash = $1, expires_at = $2 WHERE id = $3`,
      [tokenHash, expiresAt, sessionId],
    );
  }

  async createSessionForUser(
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

  async findById(id: string): Promise<Session | null> {
    const query = `SELECT * FROM sessions WHERE id = $1 LIMIT 1`;
    const result: QueryResult<Session> = await this.db.query(query, [id]);
    return result.rows.length > 0 ? this.mapSession(result.rows[0]) : null;
  }

  async findByParentId(parentId: string): Promise<Session | null> {
    const query = `SELECT * FROM sessions WHERE parent_id = $1 LIMIT 1`;
    const result: QueryResult<Session> = await this.db.query(query, [parentId]);
    return result.rows.length > 0 ? this.mapSession(result.rows[0]) : null;
  }

  /**
   * Revoke a session and all its descendants.
   */
  async revokeSessionAndDescendants(sessionId: string): Promise<void> {
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
    await this.db.query(query, [sessionId]);
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
  async deleteAllSessionsByUserId(userId: string): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
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
    };
  }
}
