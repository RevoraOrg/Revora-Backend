/**
 * @file src/services/startupAuthService.test.ts
 * @description
 * Comprehensive test suite for StartupAuthService.register().
 *
 * Test strategy:
 *  - All tests are unit tests; the UserRepository is fully mocked — no DB.
 *  - Each `it` block is independent (beforeEach resets all mocks).
 *  - Error-path tests assert that raw DB/internal error strings are NEVER
 *    returned to the caller (opaque 500 responses).
 *  - Concurrent registration (UniqueConstraintError) is treated as a 409,
 *    not a 500.
 *
 * Security invariants verified:
 *  - password_hash is stripped from every successful result.
 *  - Weak passwords are rejected before any DB call.
 *  - Invalid email formats are rejected before any DB call.
 *  - DB error messages do not propagate to the RegistrationResult.error field.
 */

import { StartupAuthService, RegistrationResult } from './startupAuthService';
import { UserRepository } from '../db/repositories/userRepository';
import { UniqueConstraintError } from '../lib/errors';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A password that satisfies all strength policies in lib/passwordStrength. */
const STRONG_PASSWORD = 'Revora!Secure#2025';

function makeUser(overrides: Partial<ReturnType<UserRepository['createUser'] extends Promise<infer T> ? () => T : never>> = {}) {
    return {
        id: 'user-abc',
        email: 'startup@example.com',
        password_hash: 'hashed_value',
        name: 'Acme Corp',
        role: 'startup' as const,
        created_at: new Date('2025-01-01'),
        updated_at: new Date('2025-01-01'),
        ...overrides,
    };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('StartupAuthService', () => {
    let service: StartupAuthService;
    let mockUserRepository: jest.Mocked<UserRepository>;

    beforeEach(() => {
        mockUserRepository = {
            findByEmail: jest.fn(),
            createUser: jest.fn(),
            findById: jest.fn(),
            findUserById: jest.fn(),
            findUserByEmail: jest.fn(),
            updateUser: jest.fn(),
            updatePasswordHash: jest.fn(),
        } as any;

        service = new StartupAuthService(mockUserRepository);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // ── Success paths ────────────────────────────────────────────────────────

    describe('register — success', () => {
        it('registers a new user and strips password_hash from result', async () => {
            mockUserRepository.findByEmail.mockResolvedValue(null);
            mockUserRepository.createUser.mockResolvedValue(makeUser());

            const result = await service.register({
                email: 'startup@example.com',
                password: STRONG_PASSWORD,
                name: 'Acme Corp',
            });

            expect(result.success).toBe(true);
            expect(result.statusCode).toBe(201);
            expect(result.user).toBeDefined();
            expect(result.user?.email).toBe('startup@example.com');
            // password_hash must never appear in the returned user object
            expect((result.user as any)?.password_hash).toBeUndefined();
            expect(mockUserRepository.createUser).toHaveBeenCalledTimes(1);
        });

        it('normalises the email to lowercase before persisting', async () => {
            mockUserRepository.findByEmail.mockResolvedValue(null);
            mockUserRepository.createUser.mockResolvedValue(makeUser({ email: 'startup@example.com' }));

            await service.register({ email: 'STARTUP@EXAMPLE.COM', password: STRONG_PASSWORD });

            const callArg = mockUserRepository.createUser.mock.calls[0][0];
            expect(callArg.email).toBe('startup@example.com');
        });

        it('registers without an optional name', async () => {
            mockUserRepository.findByEmail.mockResolvedValue(null);
            mockUserRepository.createUser.mockResolvedValue(makeUser({ name: undefined }));

            const result = await service.register({
                email: 'startup@example.com',
                password: STRONG_PASSWORD,
            });

            expect(result.success).toBe(true);
            expect(result.statusCode).toBe(201);
        });

        it('sets role to "startup" regardless of input', async () => {
            mockUserRepository.findByEmail.mockResolvedValue(null);
            mockUserRepository.createUser.mockResolvedValue(makeUser());

            await service.register({ email: 'startup@example.com', password: STRONG_PASSWORD });

            const callArg = mockUserRepository.createUser.mock.calls[0][0];
            expect(callArg.role).toBe('startup');
        });
    });

    // ── Input validation — email ─────────────────────────────────────────────

    describe('register — email validation', () => {
        const invalidEmails = [
            '',
            '   ',
            'not-an-email',
            '@nodomain',
            'noatsign.com',
            'a@',
            null,
            undefined,
            42,
            {},
            'a'.repeat(255) + '@example.com',
        ];

        it.each(invalidEmails)('rejects invalid email %p without calling DB', async (email) => {
            const result = await service.register({ email: email as any, password: STRONG_PASSWORD });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(400);
            expect(mockUserRepository.findByEmail).not.toHaveBeenCalled();
            expect(mockUserRepository.createUser).not.toHaveBeenCalled();
        });
    });

    // ── Input validation — password ──────────────────────────────────────────

    describe('register — password validation', () => {
        it('rejects a non-string password', async () => {
            const result = await service.register({ email: 'startup@example.com', password: 12345 as any });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(400);
            expect(mockUserRepository.findByEmail).not.toHaveBeenCalled();
        });

        it('rejects a password that is too short (< 12 chars)', async () => {
            const result = await service.register({ email: 'startup@example.com', password: 'Short1!' });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(400);
            expect(result.details).toBeDefined();
            expect(result.details!.length).toBeGreaterThan(0);
            expect(mockUserRepository.findByEmail).not.toHaveBeenCalled();
        });

        it('rejects a password missing uppercase characters', async () => {
            const result = await service.register({ email: 'startup@example.com', password: 'alllowercase!99' });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(400);
            expect(result.details!.some((e) => /uppercase/i.test(e))).toBe(true);
        });

        it('rejects a password missing special characters', async () => {
            const result = await service.register({ email: 'startup@example.com', password: 'NoSpecialChar123' });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(400);
            expect(result.details!.some((e) => /special/i.test(e))).toBe(true);
        });

        it('returns policy error details in the result but not raw internals', async () => {
            const result = await service.register({ email: 'startup@example.com', password: 'weak' });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(400);
            // details may contain policy messages but must never contain stack traces
            if (result.details) {
                result.details.forEach((d) => {
                    expect(d).not.toMatch(/Error:/);
                    expect(d).not.toMatch(/^\s*at\s+/); // no stack-trace lines
                });
            }
        });
    });

    // ── Duplicate detection ──────────────────────────────────────────────────

    describe('register — duplicate email', () => {
        it('returns 409 when findByEmail finds an existing user', async () => {
            mockUserRepository.findByEmail.mockResolvedValue(makeUser() as any);

            const result = await service.register({
                email: 'startup@example.com',
                password: STRONG_PASSWORD,
            });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(409);
            expect(mockUserRepository.createUser).not.toHaveBeenCalled();
        });

        it('returns 409 (not 500) when DB raises UniqueConstraintError during createUser (race)', async () => {
            mockUserRepository.findByEmail.mockResolvedValue(null);
            mockUserRepository.createUser.mockRejectedValue(new UniqueConstraintError('email'));

            const result = await service.register({
                email: 'startup@example.com',
                password: STRONG_PASSWORD,
            });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(409);
            // Must not leak the constraint field name or any DB internals
            expect(result.error).not.toMatch(/23505/);
            expect(result.error).not.toMatch(/Duplicate/i);
        });
    });

    // ── DB failure paths — opaque 500 ────────────────────────────────────────

    describe('register — database failures (opaque responses)', () => {
        it('returns 500 without leaking DB error when findByEmail throws', async () => {
            const internalMsg = 'CONNECTION_REFUSED: pg pool exhausted at line 42';
            mockUserRepository.findByEmail.mockRejectedValue(new Error(internalMsg));

            const result = await service.register({
                email: 'startup@example.com',
                password: STRONG_PASSWORD,
            });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(500);
            // The raw DB error must NOT appear in the client-facing response
            expect(result.error).not.toContain(internalMsg);
            expect(result.error).not.toMatch(/CONNECTION_REFUSED/);
        });

        it('returns 500 without leaking DB error when createUser throws a generic error', async () => {
            const internalMsg = 'ECONNRESET during INSERT on users table at pg.js:512';
            mockUserRepository.findByEmail.mockResolvedValue(null);
            mockUserRepository.createUser.mockRejectedValue(new Error(internalMsg));

            const result = await service.register({
                email: 'startup@example.com',
                password: STRONG_PASSWORD,
            });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(500);
            expect(result.error).not.toContain(internalMsg);
            expect(result.error).not.toMatch(/ECONNRESET/);
        });

        it('returns 500 for a non-Error thrown value (e.g., plain string)', async () => {
            mockUserRepository.findByEmail.mockResolvedValue(null);
            mockUserRepository.createUser.mockRejectedValue('something blew up');

            const result = await service.register({
                email: 'startup@example.com',
                password: STRONG_PASSWORD,
            });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(500);
            expect(result.error).not.toContain('something blew up');
        });
    });
});
