/**
 * Login module type definitions.
 *
 * All external dependencies (user store, session store, JWT issuer) are
 * expressed as narrow interfaces so the login service stays testable
 * without any concrete implementations.
 */

// ── User ────────────────────────────────────────────────────────────────

export const USER_ROLES = ['startup', 'investor'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Return whether an unknown value is a supported login role. */
export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

export interface UserRecord {
  id: string;
  email: string;
  role: UserRole;
  passwordHash: string;
}

// ── Repositories ────────────────────────────────────────────────────────

export interface UserRepository {
  /** Return the user for a given email, or `null` if not found. */
  findByEmail(email: string): Promise<UserRecord | null>;
}

export interface SessionRepository {
  /** Persist a new session. */
  createSession(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void>;
}

// ── JWT helper ──────────────────────────────────────────────────────────

export interface JwtIssuer {
  /**
   * Create signed access and refresh tokens.
   */
  sign(payload: { userId: string; sessionId: string; role: UserRole }): {
    accessToken: string;
    refreshToken: string;
  };
}

// ── DTOs ────────────────────────────────────────────────────────────────

export interface LoginRequestBody {
  email: string;
  password: string;
}

export interface LoginSuccessResponse {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}
