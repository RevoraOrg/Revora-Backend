import { Pool, QueryResult } from 'pg';
import { UniqueConstraintError } from '../../lib/errors';
import {
  DEFAULT_KYC_RISK_TIER,
  KycRiskTier,
  parseKycRiskTier,
} from '../../lib/kycRiskTierCaps';
import { KycStatus } from '../../services/kyc/KycProvider';

/** Default KYC verification status for a freshly registered investor. */
export const DEFAULT_KYC_STATUS: KycStatus = 'pending';

/**
 * Parses a stored `kyc_status` column value, falling back to `pending` on
 * missing/unknown values (backward compatible with rows written before the
 * column existed).
 */
export function parseKycStatus(value: unknown, fallback: KycStatus = DEFAULT_KYC_STATUS): KycStatus {
  const statuses: readonly KycStatus[] = ['pending', 'in_review', 'approved', 'rejected'];
  return typeof value === 'string' && (statuses as readonly string[]).includes(value)
    ? (value as KycStatus)
    : fallback;
}

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
  /** Authoritative KYC/AML verification status reported by the provider. */
  kyc_status: KycStatus;
  /** Provider name that last updated the verification status (nullable pre-gate). */
  kyc_provider?: string | null;
  /** Provider transaction/reference id that produced the current status. */
  kyc_reference_id?: string | null;
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
  kyc_status?: KycStatus;
}

export interface UpdateUserInput {
  id: string;
  email?: string;
  name?: string;
  password_hash?: string;
  role?: 'startup' | 'investor';
  kyc_risk_tier?: KycRiskTier;
  kyc_status?: KycStatus;
  kyc_provider?: string | null;
  kyc_reference_id?: string | null;
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
      SELECT id, email, password_hash, name, role, kyc_risk_tier, kyc_status, kyc_provider, kyc_reference_id, last_oidc_groups, created_at, updated_at
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
      SELECT id, email, password_hash, name, role, kyc_risk_tier, kyc_status, kyc_provider, kyc_reference_id, last_oidc_groups, created_at, updated_at
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
      INSERT INTO users (email, password_hash, name, role, kyc_risk_tier, kyc_status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING *
    `;
    const values = [
      input.email,
      input.password_hash,
      input.name ?? null,
      input.role ?? 'startup',
      input.kyc_risk_tier ?? DEFAULT_KYC_RISK_TIER,
      input.kyc_status ?? DEFAULT_KYC_STATUS,
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
    if (input.kyc_status !== undefined) {
      sets.push(`kyc_status = $${idx++}`);
      values.push(input.kyc_status);
    }
    if (input.kyc_provider !== undefined) {
      sets.push(`kyc_provider = $${idx++}`);
      values.push(input.kyc_provider);
    }
    if (input.kyc_reference_id !== undefined) {
      sets.push(`kyc_reference_id = $${idx++}`);
      values.push(input.kyc_reference_id);
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
   * Persist the authoritative KYC/AML verification status reported by a
   * provider callback, along with the provider name and transaction id so the
   * user's record remains linked to the external check.
   *
   * Being the destination of a verified, replay-protected provider callback,
   * this method is deliberately narrow — it only touches KYC fields and never
   * mutates credentials or roles.
   */
  async updateKycVerification(
    userId: string,
    input: { status: KycStatus; provider: string; referenceId: string },
  ): Promise<User> {
    return this.updateUser({
      id: userId,
      kyc_status: input.status,
      kyc_provider: input.provider,
      kyc_reference_id: input.referenceId,
    });
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
      kyc_status: parseKycStatus(row.kyc_status),
      kyc_provider: row.kyc_provider ?? null,
      kyc_reference_id: row.kyc_reference_id ?? null,
      last_oidc_groups: row.last_oidc_groups ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
