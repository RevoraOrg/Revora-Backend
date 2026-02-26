import { Pool, QueryResult } from 'pg';

/**
 * Full user row — password_hash included for internal auth use only.
 * Never expose this type in API responses.
 */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
}

/** Safe public shape — never includes password_hash */
export type SafeUser = Omit<User, 'password_hash'>;

export class UserRepository {
  constructor(private db: Pool) {}

  /**
   * Find a user by ID (includes password_hash for internal auth flows).
   */
  async findById(id: string): Promise<User | null> {
    const query = `
      SELECT id, email, password_hash, created_at, updated_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `;
    const result: QueryResult<User> = await this.db.query(query, [id]);
    return result.rows.length > 0 ? this.mapUser(result.rows[0]) : null;
  }

  /**
   * Find a user by email (used during login).
   */
  async findByEmail(email: string): Promise<User | null> {
    const query = `
      SELECT id, email, password_hash, created_at, updated_at
      FROM users
      WHERE email = $1
      LIMIT 1
    `;
    const result: QueryResult<User> = await this.db.query(query, [email]);
    return result.rows.length > 0 ? this.mapUser(result.rows[0]) : null;
  }

  /**
   * Update a user's password hash.
   */
  async updatePasswordHash(userId: string, newPasswordHash: string): Promise<void> {
    const query = `
      UPDATE users
      SET password_hash = $1, updated_at = NOW()
      WHERE id = $2
    `;
    await this.db.query(query, [newPasswordHash, userId]);
  }

  private mapUser(row: any): User {
    return {
      id: row.id,
      email: row.email,
      password_hash: row.password_hash,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}