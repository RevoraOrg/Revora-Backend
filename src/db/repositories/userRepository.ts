import { Pool, QueryResult } from 'pg';
import { UniqueConstraintError } from '../../lib/errors';
import {
  DEFAULT_KYC_RISK_TIER,
  KycRiskTier,
  parseKycRiskTier,
} from '../../lib/kycRiskTierCaps';

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
  /** KYC risk tier used to scale per-offering investment caps. */
  kyc_risk_tier: KycRiskTier;
  last_oidc_groups?: string[] | null;
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
  kyc_risk_tier?: KycRiskTier;
}

export interface UpdateUserInput {
  id: string;
  email?: string;
  name?: string;
  password_hash?: string;
  role?: 'startup' | 'investor';
  kyc_risk_tier?: KycRiskTier;
  last_oidc_groups?: string[] | null;
}

/**
 * Inspects a caught error from a `pg` query and translates known PostgreSQL
 * error codes into typed domain errors.  Always throws — never returns.
 *
 * - `23505` (`unique_violation`) → {@link UniqueConstraintError} with `field: "email"`
 * - anything else → re-throws the original error unchanged
 */
function handlePgError(err: unknown): never {
  if ((err as any).code === '23505') {
    throw new UniqueConstraintError('email');
  }
  throw err;
}

export class UserRepository {
  constructor(private db: Pool) {}

  /**
   * Find a user by ID (includes password_hash for internal auth flows).
   */
  async findById(id: string): Promise<User | null> {
    const query = `
      SELECT id, email, password_hash, name, role, kyc_risk_tier, last_oidc_groups, created_at, updated_at
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
      SELECT id, email, password_hash, name, role, kyc_risk_tier, last_oidc_groups, created_at, updated_at
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

  /**
   * Insert a new user row and return the created record.
   *
   * @throws {UniqueConstraintError} When the `email` column violates the
   *   `UNIQUE` constraint (PostgreSQL error code `23505`).  This can happen
   *   when two concurrent registrations race past the application-layer
   *   duplicate check in `RegisterService`.
   */
  async createUser(input: CreateUserInput): Promise<User> {
    const query = `
      INSERT INTO users (email, password_hash, name, role, kyc_risk_tier, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING *
    `;
    const values = [
      input.email,
      input.password_hash,
      input.name ?? null,
      input.role ?? 'startup',
      input.kyc_risk_tier ?? DEFAULT_KYC_RISK_TIER,
    ];
    let result: QueryResult<User>;
    try {
      result = await this.db.query(query, values);
    } catch (err) {
      handlePgError(err);
    }
    if (result.rows.length === 0) throw new Error('Failed to create user');
    return this.mapUser(result.rows[0]);
  }

  /**
   * Update an existing user's fields and return the updated record.
   *
   * @throws {UniqueConstraintError} When the new `email` value already exists
   *   in the `users` table for a *different* user (PostgreSQL error code
   *   `23505`).  Callers should catch this and return HTTP 409.
   *
   * @remarks
   * **Same-email no-op**: If the caller passes the same email the user already
   * holds, PostgreSQL will not raise a uniqueness violation (the row is simply
   * updated in place with the identical value), so no error is thrown and the
   * existing user record is returned normally.
   *
   * Callers are responsible for passing a normalised (lowercased + trimmed)
   * email so that the database constraint and the application-layer check
   * operate on the same canonical form.
   */
  async updateUser(input: UpdateUserInput): Promise<User> {
    const sets: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (input.email !== undefined) {
      sets.push(`email = $${idx++}`);
      values.push(input.email);
    }
    if (input.name !== undefined) {
      sets.push(`name = $${idx++}`);
      values.push(input.name);
    }
    if (input.password_hash !== undefined) {
      sets.push(`password_hash = $${idx++}`);
      values.push(input.password_hash);
    }
    if (input.role !== undefined) {
      sets.push(`role = $${idx++}`);
      values.push(input.role);
    }
    if (input.kyc_risk_tier !== undefined) {
      sets.push(`kyc_risk_tier = $${idx++}`);
      values.push(input.kyc_risk_tier);
    }
    if (input.last_oidc_groups !== undefined) {
      sets.push(`last_oidc_groups = $${idx++}`);
      values.push(input.last_oidc_groups === null ? null : JSON.stringify(input.last_oidc_groups));
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
    let result: QueryResult<User>;
    try {
      result = await this.db.query(query, values);
    } catch (err) {
      handlePgError(err);
    }
    if (result.rows.length === 0) throw new Error('Failed to update user');
    return this.mapUser(result.rows[0]);
  }

  /**
   * Persist a new KYC risk tier for an investor.
   * Does not emit audit events — callers (KycRiskTierService) own that.
   */
  async updateKycRiskTier(userId: string, tier: KycRiskTier): Promise<User> {
    return this.updateUser({ id: userId, kyc_risk_tier: tier });
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
      kyc_risk_tier: parseKycRiskTier(row.kyc_risk_tier),
      last_oidc_groups: row.last_oidc_groups ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
