import { Pool, QueryResult } from 'pg';

export interface User {
  id: string;
  email: string;
  password_hash: string;
  name?: string;
  role: string;
  created_at: Date;
  updated_at: Date;
}

export interface CreateUserInput {
  email: string;
  password_hash: string;
  name?: string;
  role?: string;
}

export class UserRepository {
  constructor(private db: Pool) {}

  async createUser(input: CreateUserInput): Promise<User> {
    const query = `
      INSERT INTO users (
        email,
        password_hash,
        name,
        role,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING *
    `;

    const values = [
      input.email,
      input.password_hash,
      input.name,
      input.role || 'startup_admin',
    ];

    const result: QueryResult<User> = await this.db.query(query, values);

    if (result.rows.length === 0) {
      throw new Error('Failed to create user');
    }

    return this.mapUser(result.rows[0]);
  }

  async findByEmail(email: string): Promise<User | null> {
    const query = 'SELECT * FROM users WHERE email = $1';
    const result: QueryResult<User> = await this.db.query(query, [email]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapUser(result.rows[0]);
  }

  private mapUser(row: any): User {
    return {
      id: row.id,
      email: row.email,
      password_hash: row.password_hash,
      name: row.name,
      role: row.role,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
