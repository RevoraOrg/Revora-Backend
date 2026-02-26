/**
 * Login module type definitions.
 *
 * All external dependencies (user store, session store, JWT issuer) are
 * expressed as narrow interfaces so the login service stays testable
 * without any concrete implementations.
 */

// ── User ────────────────────────────────────────────────────────────────

export type UserRole = 'startup' | 'investor';

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
  /** Persist a new session and return its unique ID. */
  createSession(userId: string): Promise<string>;
}

// ── JWT helper ──────────────────────────────────────────────────────────

export interface JwtIssuer {
  /**
   * Create a signed JWT.
   *
   * The token payload should at minimum include the user ID, session ID,
   * and role so downstream middleware can authorise requests.
   */
  sign(payload: { userId: string; sessionId: string; role: UserRole }): string;
}

// ── DTOs ────────────────────────────────────────────────────────────────

export interface LoginRequestBody {
  email: string;
  password: string;
}

export interface LoginSuccessResponse {
  token: string;
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}
