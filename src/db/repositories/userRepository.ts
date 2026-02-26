import { Pool, QueryResult } from 'pg';

/**
 * Full user row — password_hash included for internal auth use only.
 * Never expose this type in API responses.
 */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  name?: string;
  role: 'startup' | 'investor';
  created_at: Date;
  updated_at: Date;
}

/** Safe public shape — never includes password_hash */
export type SafeUser = Omit<User, 'password_hash'>;

export interface CreateUserInput {
  email: string;
  password_hash: string;
  name?: string;
  role?: 'startup' | 'investor';
}

export interface UpdateUserInput {
  id: string;
  email?: string;
  password_hash?: string;
  role?: 'startup' | 'investor';
}

export class UserRepository {
  constructor(private db: Pool) {}

  /**
   * Find a user by ID (includes password_hash for internal auth flows).
   */
  async findById(id: string): Promise<User | null> {
    const query = `
      SELECT id, email, password_hash, name, role, created_at, updated_at
      FROM users
      WHERE id = $1
      LIMIT 1
    `;
    const result: QueryResult<User> = await this.db.query(query, [id]);
    return result.rows.length > 0 ? this.mapUser(result.rows[0]) : null;
  }

  // Alias used by routes/users.ts
  async findUserById(id: string): Promise<User | null> {
    return this.findById(id);
  }

  /**
   * Find a user by email (used during login).
   */
  async findByEmail(email: string): Promise<User | null> {
    const query = `
      SELECT id, email, password_hash, name, role, created_at, updated_at
      FROM users
      WHERE email = $1
      LIMIT 1
    `;
    const result: QueryResult<User> = await this.db.query(query, [email]);
    return result.rows.length > 0 ? this.mapUser(result.rows[0]) : null;
  }

  // Alias
  async findUserByEmail(email: string): Promise<User | null> {
    return this.findByEmail(email);
  }

  async createUser(input: CreateUserInput): Promise<User> {
    const query = `
      INSERT INTO users (email, password_hash, name, role, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING *
    `;
    const values = [
      input.email,
      input.password_hash,
      input.name ?? null,
      input.role ?? 'startup',
    ];
    const result: QueryResult<User> = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('Failed to create user');
    return this.mapUser(result.rows[0]);
  }

  async updateUser(input: UpdateUserInput): Promise<User> {
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
      const existing = await this.findById(input.id);
      if (!existing) throw new Error('User not found');
      return existing;
    }

    sets.push(`updated_at = NOW()`);
    values.push(input.id);

    const query = `
      UPDATE users
      SET ${sets.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `;
    const result: QueryResult<User> = await this.db.query(query, values);
    if (result.rows.length === 0) throw new Error('Failed to update user');
    return this.mapUser(result.rows[0]);
  }

  /**
   * Update a user's password hash directly.
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
      name: row.name ?? undefined,
      role: row.role as 'startup' | 'investor',
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}