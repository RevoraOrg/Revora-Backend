import { Pool, QueryResult } from 'pg';

export interface Session {
  id: string;
  user_id: string;
  token_ref: string;
  expires_at: Date;
  created_at: Date;
}

export interface CreateSessionInput {
  user_id: string;
  token_ref: string;
  expires_at: Date;
}

export class SessionRepository {
  constructor(private db: Pool) {}

  async createSession(input: CreateSessionInput): Promise<Session> {
    const query = `
      INSERT INTO sessions (user_id, token_ref, expires_at, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING *
    `;

    const values = [input.user_id, input.token_ref, input.expires_at];
    const result: QueryResult = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('Failed to create session');
    return this.mapSession(result.rows[0]);
  }

  async findSessionByToken(tokenRef: string): Promise<Session | null> {
    const query = `SELECT * FROM sessions WHERE token_ref = $1 LIMIT 1`;
    const result: QueryResult = await this.db.query(query, [tokenRef]);
    if (result.rows.length === 0) return null;
    return this.mapSession(result.rows[0]);
  }

  async deleteSessionByToken(tokenRef: string): Promise<boolean> {
    const query = `DELETE FROM sessions WHERE token_ref = $1`;
    const result = await this.db.query(query, [tokenRef]);
    // result.rowCount may be undefined depending on driver mocking; treat >0 as success
    // @ts-ignore
    return (result.rowCount || 0) > 0;
  }

  private mapSession(row: any): Session {
    return {
      id: row.id,
      user_id: row.user_id,
      token_ref: row.token_ref,
      expires_at: row.expires_at,
      created_at: row.created_at,
    };
  }
}
