import { createHash } from 'node:crypto';
import { validatePasswordStrength } from '../../lib/passwordStrength';
import { Errors } from '../../lib/errors';
import { globalLogger } from '../../lib/logger';
import { IUserRepository, RegisteredUser } from './types';

/**
 * Thrown when a registration attempt is made with an email address that is
 * already associated with an existing account.
 */
export class DuplicateEmailError extends Error {
  constructor() {
    super('Email already registered');
    this.name = 'DuplicateEmailError';
    // Restore prototype chain after TypeScript's `extends Error` transpilation.
    Object.setPrototypeOf(this, DuplicateEmailError.prototype);
  }
}

/**
 * Domain service that orchestrates the investor registration flow:
 *
 *  1. Normalise the email address (lowercase + trim).
 *  2. Reject duplicate emails.
 *  3. Hash the password with SHA-256 (consistent with LoginService).
 *  4. Persist the new user with role = 'investor'.
 *
 * Note: SHA-256 is used here because `package.json` must not be modified
 * (no bcrypt / argon2 available).  In production swap this for a proper
 * adaptive password-hashing algorithm behind the same interface boundary.
 */
export class RegisterService {
  constructor(private readonly userRepository: IUserRepository) {}

  /**
   * Registers a new user with the given email and password.
   *
   * @param rawEmail - The raw email address (will be lowercased and trimmed).
   * @param password - The plain-text password (will be hashed before storage).
   * @returns The newly created user record.
   *
   * @throws {DuplicateEmailError} When `findByEmail` returns a non-null user,
   *   indicating the email is already registered (application-layer check,
   *   performed before any DB write).
   * @throws {UniqueConstraintError} When a concurrent registration races past
   *   the application-layer check and the database returns a 23505
   *   unique_violation error (database-layer enforcement).
   */
  async register(rawEmail: string, password: string): Promise<RegisteredUser> {
    const email = rawEmail.toLowerCase().trim();

    // Validate password strength
    const strength = validatePasswordStrength(password);
    if (!strength.isValid) {
      globalLogger.warn('Registration failed: weak password', {
        email,
        errorCodes: strength.errors.map((e) => e.code),
      });
      throw Errors.validationError('Password does not meet strength requirements', {
        errors: strength.errors,
      });
    }

    const existing = await this.userRepository.findByEmail(email);
    if (existing) {
      throw new DuplicateEmailError();
    }

    const password_hash = createHash('sha256').update(password).digest('hex');

    return this.userRepository.createUser({ email, password_hash, role: 'investor' });
  }
}
