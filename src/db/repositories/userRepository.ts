import { Pool, QueryResult } from 'pg';

export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: 'startup' | 'investor';
  created_at: Date;
}

export interface CreateUserInput {
  email: string;
  password_hash: string;
  role: 'startup' | 'investor';
}

export interface UpdateUserInput {
  id: string;
  email?: string;
  password_hash?: string;
  role?: 'startup' | 'investor';
}

export class UserRepository {
  constructor(private db: Pool) {}

  async findUserById(id: string): Promise<User | null> {
    const query = `SELECT * FROM users WHERE id = $1 LIMIT 1`;
    const result: QueryResult = await this.db.query(query, [id]);
    if (result.rows.length === 0) return null;
    return this.mapUser(result.rows[0]);
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const query = `SELECT * FROM users WHERE email = $1 LIMIT 1`;
    const result: QueryResult = await this.db.query(query, [email]);
    if (result.rows.length === 0) return null;
    return this.mapUser(result.rows[0]);
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const query = `
      INSERT INTO users (email, password_hash, role, created_at)
      VALUES ($1, $2, $3, NOW())
      RETURNING *
    `;

    const values = [input.email, input.password_hash, input.role];
    const result: QueryResult = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('Failed to create user');
    return this.mapUser(result.rows[0]);
  }

  async updateUser(input: UpdateUserInput): Promise<User> {
    // Build dynamic set clause
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (input.email !== undefined) {
      sets.push(`email = $${idx++}`);
      values.push(input.email);
    }
    if (input.password_hash !== undefined) {
      sets.push(`password_hash = $${idx++}`);
      values.push(input.password_hash);
    }
    if (input.role !== undefined) {
      sets.push(`role = $${idx++}`);
      values.push(input.role);
    }

    if (sets.length === 0) {
      // Nothing to update; return existing user
      const existing = await this.findUserById(input.id);
      if (!existing) throw new Error('User not found');
      return existing;
    }

    const query = `
      UPDATE users SET ${sets.join(', ')},
        /* updated_at column not present by default; keep created_at unchanged */
        /* If you add updated_at in future migrations, consider updating it here */
      WHERE id = $${idx} RETURNING *
    `;
    values.push(input.id);

    const result: QueryResult = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('Failed to update user');
    return this.mapUser(result.rows[0]);
  }

  private mapUser(row: any): User {
    return {
      id: row.id,
      email: row.email,
      password_hash: row.password_hash,
      role: row.role,
      created_at: row.created_at,
    };
  }
}
