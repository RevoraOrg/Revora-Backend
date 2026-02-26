import { Pool, QueryResult } from 'pg';

export interface Session {
  id: string;
  user_id: string;
  token_hash: string;   // store a hash of the token, never the raw JWT
  expires_at: Date;
  created_at: Date;
}

export interface CreateSessionInput {
  user_id: string;
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

  async createSession(input: CreateSessionInput): Promise<Session> {
    const query = `
      INSERT INTO sessions (user_id, token_hash, expires_at, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING *
    `;
    const result: QueryResult<Session> = await this.db.query(query, [
      input.user_id,
      input.token_hash,
      input.expires_at,
    ]);
    if (result.rows.length === 0) throw new Error('Failed to create session');
    return this.mapSession(result.rows[0]);
  }

  async findById(id: string): Promise<Session | null> {
    const query = `SELECT * FROM sessions WHERE id = $1 LIMIT 1`;
    const result: QueryResult<Session> = await this.db.query(query, [id]);
    return result.rows.length > 0 ? this.mapSession(result.rows[0]) : null;
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
    };
  }
}