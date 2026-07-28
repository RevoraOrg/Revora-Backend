/**
 * @module services/startupAuthService
 * @description
 * Registration service for startup actors in the Revora platform.
 *
 * Security assumptions:
 *  - Email is validated with a bounded regex before any DB call; malformed inputs
 *    are rejected immediately and never reach the repository.
 *  - Passwords are validated for strength (min-length, character classes) before
 *    hashing; raw password strings are never logged.
 *  - Password hashing is performed by lib/hash (scrypt); the plain-text password
 *    is not retained in memory after hashing.
 *  - Duplicate email detection uses two layers: application-level `findByEmail`
 *    check AND DB-level UniqueConstraintError mapping, so concurrent race
 *    registrations are handled correctly.
 *  - Raw database error strings are never propagated to client-facing responses;
 *    all error branches produce opaque messages.
 *  - Structured logging via lib/logger; password/token fields are never logged
 *    (the logger's SENSITIVE_FIELDS list covers them).
 *
 * Abuse / failure paths:
 *  - Invalid email format          → 400 BAD_REQUEST
 *  - Weak/non-compliant password   → 400 BAD_REQUEST (policy errors returned)
 *  - Duplicate email (app check)   → 409 CONFLICT
 *  - Duplicate email (DB race)     → 409 CONFLICT (UniqueConstraintError mapping)
 *  - findByEmail DB crash          → 500 INTERNAL_ERROR (opaque)
 *  - createUser DB crash           → 500 INTERNAL_ERROR (opaque)
 */

import { UserRepository, CreateUserInput, User } from '../db/repositories/userRepository';
import { hashPassword } from '../lib/hash';
import { UniqueConstraintError } from '../lib/errors';
import { validatePasswordStrength } from '../lib/passwordStrength';
import { globalLogger } from '../lib/logger';

// ─── Email validation ─────────────────────────────────────────────────────────

/**
 * Maximum accepted email length (RFC 5321 §4.5.3.1.3 gives 254 chars; we cap
 * at 254 to match but reject anything beyond to guard against DoS padding).
 */
const EMAIL_MAX_LENGTH = 254;

/**
 * Bounded email format validator.
 *
 * @dev Deliberately conservative: rejects most pathological inputs
 *      (empty local part, missing @, multiple @, no TLD) without relying on
 *      a third-party library.  Full RFC 5321 compliance is handled by the
 *      email delivery provider at send time.
 */
function isValidEmail(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > EMAIL_MAX_LENGTH) return false;
    // local@domain.tld — at least one char before @, at least one dot after @
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed);
}

// ─── Result types ─────────────────────────────────────────────────────────────

export interface RegistrationResult {
    success: boolean;
    user?: Omit<User, 'password_hash'>;
    error?: string;
    /** Client-safe field-level validation errors (only on 400 responses). */
    details?: string[];
    statusCode: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class StartupAuthService {
    constructor(private userRepository: UserRepository) {}

    /**
     * Register a new startup user.
     *
     * @param input - Registration payload (email, password, optional name).
     * @returns     A structured result; never throws.
     *
     * @dev All error branches return an opaque `error` string safe for clients.
     *      Raw DB or internal error messages are logged at ERROR level but
     *      never forwarded to the caller.
     */
    async register(input: {
        email: unknown;
        password: unknown;
        name?: unknown;
    }): Promise<RegistrationResult> {
        // ── 1. Validate email ─────────────────────────────────────────────────
        if (!isValidEmail(input.email)) {
            globalLogger.warn('startup_auth.register: invalid email format', {
                context: { emailProvided: typeof input.email === 'string' },
            });
            return {
                success: false,
                error: 'Invalid email address',
                statusCode: 400,
            };
        }

        const email = (input.email as string).trim().toLowerCase();

        // ── 2. Validate password strength ────────────────────────────────────
        if (typeof input.password !== 'string') {
            return {
                success: false,
                error: 'Password must be a string',
                statusCode: 400,
            };
        }

        const strengthCheck = validatePasswordStrength(input.password);
        if (!strengthCheck.isValid) {
            globalLogger.warn('startup_auth.register: password policy violation', {
                context: { violations: strengthCheck.errors.length },
            });
            return {
                success: false,
                error: 'Password does not meet strength requirements',
                details: strengthCheck.errors,
                statusCode: 400,
            };
        }

        // ── 3. Validate optional name ────────────────────────────────────────
        const name =
            typeof input.name === 'string' && input.name.trim().length > 0
                ? input.name.trim().slice(0, 256)
                : undefined;

        try {
            // ── 4. Duplicate check (application layer) ───────────────────────
            const existingUser = await this.userRepository.findByEmail(email);
            if (existingUser) {
                globalLogger.info('startup_auth.register: duplicate email rejected', {
                    context: { email },
                });
                return {
                    success: false,
                    error: 'An account with this email already exists',
                    statusCode: 409,
                };
            }

            // ── 5. Hash password ─────────────────────────────────────────────
            const passwordHash = hashPassword(input.password);

            // ── 6. Persist user ──────────────────────────────────────────────
            const createInput: CreateUserInput = {
                email,
                password_hash: passwordHash,
                name,
                role: 'startup',
            };

            const newUser = await this.userRepository.createUser(createInput);

            // ── 7. Strip password hash from response ─────────────────────────
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { password_hash, ...userResult } = newUser;

            globalLogger.info('startup_auth.register: user registered', {
                userId: newUser.id,
                context: { role: 'startup' },
            });

            return {
                success: true,
                user: userResult,
                statusCode: 201,
            };
        } catch (error) {
            // ── 8. Map DB-layer unique constraint violation ───────────────────
            if (error instanceof UniqueConstraintError) {
                globalLogger.warn('startup_auth.register: unique constraint race', {
                    context: { field: error.field },
                });
                return {
                    success: false,
                    error: 'An account with this email already exists',
                    statusCode: 409,
                };
            }

            // ── 9. Opaque 500 for all other failures ─────────────────────────
            globalLogger.error('startup_auth.register: unexpected error', {
                error,
            });
            return {
                success: false,
                error: 'Registration could not be completed',
                statusCode: 500,
            };
        }
    }
}
