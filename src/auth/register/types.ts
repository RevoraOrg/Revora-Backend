/**
 * Investor registration module – type definitions.
 *
 * All external dependencies are expressed as narrow interfaces so the
 * service can be unit-tested with in-memory fakes, consistent with the
 * login / logout modules.
 */

// ── User ─────────────────────────────────────────────────────────────────────

export type UserRole = 'startup' | 'investor';

export interface RegisteredUser {
  id: string;
  email: string;
  role: UserRole;
  created_at: Date;
}

// ── Repository ────────────────────────────────────────────────────────────────

/**
 * Narrow user-repository interface required by the register service.
 *
 * NOTE: The concrete `UserRepository` class exposes `findUserByEmail`, not
 * `findByEmail`.  The composition root supplies an adapter that satisfies
 * this interface, keeping this module consistent with the login module's
 * naming conventions.
 */
export interface IUserRepository {
  findByEmail(email: string): Promise<{ id: string } | null>;
  createUser(input: {
    email: string;
    password_hash: string;
    role: 'investor';
  }): Promise<RegisteredUser>;
}

// ── DTOs ──────────────────────────────────────────────────────────────────────

export interface RegisterRequestBody {
  email?: unknown;
  password?: unknown;
  /** Optional display name – accepted but not currently persisted (schema v1). */
  name?: unknown;
}

export interface RegisterSuccessResponse {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}
