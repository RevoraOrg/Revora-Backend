/**
 * @file src/auth/login/userRepositoryAdapter.test.ts
 * @description Regression suite for `UserRepositoryAdapter.findByEmail`.
 *
 * Issue #970 — the adapter contains an explicit empty-result branch
 * (`if (!user) return null;`) that is the contract boundary between
 * "no such account" and "the login flow may proceed". These tests pin
 * that branch down so it cannot be changed silently.
 *
 * Security invariants verified here:
 *  - **Empty result is a hard `null`, never a partially-populated record.**
 *    A regression that returned `{}`, `undefined`, or swallowed the miss
 *    would let `LoginService` proceed to `verifyPassword` with
 *    `passwordHash === undefined` and potentially authenticate a
 *    non-existent user.
 *  - **Upstream errors are never converted into `null`.** A `catch` that
 *    returned `null` would turn a database outage (HTTP 500) into a
 *    credential failure (HTTP 401), hiding an incident and disabling
 *    alerting on the auth path.
 *  - **The adapter narrows, it does not forward.** Only `id`, `email`,
 *    `role` and `passwordHash` are surfaced; every other column of the
 *    `users` row (`name`, `kyc_risk_tier`, `last_oidc_groups`, timestamps)
 *    is dropped so it cannot leak into a login response body.
 *  - **No client-side input filtering.** Every value — including empty
 *    strings, whitespace and non-string input — is delegated verbatim to
 *    the repository as a *bound parameter*. Validation and normalisation
 *    live in one place; a guard clause here would create a second,
 *    divergent normalisation path.
 */

import { UserRepository as DBUserRepository, User } from '../../db/repositories/userRepository';
import { UserRepositoryAdapter } from './userRepositoryAdapter';
import { LoginService } from './loginService';
import { UserRecord, UserRole } from './types';

// ── Fixtures ────────────────────────────────────────────────────────────

/**
 * Build a complete `users` row as `UserRepository.mapUser` would return it,
 * with overrides for the fields under test. Building the *full* row matters:
 * the narrowing assertions below must prove that populated sibling columns
 * are dropped, which is only meaningful if those columns are actually set.
 */
function makeDbUser(overrides: Partial<User> = {}): User {
    return {
        id: 'user-1',
        email: 'founder@startup.io',
        password_hash: 'a'.repeat(64),
        name: 'Ada Founder',
        role: 'startup',
        kyc_risk_tier: 'standard',
        last_oidc_groups: ['engineering'],
        created_at: new Date('2024-01-01T00:00:00.000Z'),
        updated_at: new Date('2024-06-01T00:00:00.000Z'),
        ...overrides,
    };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('UserRepositoryAdapter', () => {
    let mockUserRepo: jest.Mocked<DBUserRepository>;
    let adapter: UserRepositoryAdapter;

    beforeEach(() => {
        mockUserRepo = {
            findByEmail: jest.fn(),
            findUserByEmail: jest.fn(),
            findById: jest.fn(),
            findUserById: jest.fn(),
            createUser: jest.fn(),
            updateUser: jest.fn(),
            updateKycRiskTier: jest.fn(),
            updatePasswordHash: jest.fn(),
        } as unknown as jest.Mocked<DBUserRepository>;

        adapter = new UserRepositoryAdapter(mockUserRepo);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // ── Found: the normal path ──────────────────────────────────────────

    describe('findByEmail - user found', () => {
        it('maps the database row onto the UserRecord contract', async () => {
            const dbUser = makeDbUser({
                id: 'user-42',
                email: 'investor@funds.co',
                password_hash: 'b'.repeat(64),
                role: 'investor',
            });
            mockUserRepo.findByEmail.mockResolvedValue(dbUser);

            const result = await adapter.findByEmail('investor@funds.co');

            expect(result).toEqual({
                id: 'user-42',
                email: 'investor@funds.co',
                role: 'investor',
                passwordHash: 'b'.repeat(64),
            });
        });

        it('renames password_hash to passwordHash and drops every other column', async () => {
            const dbUser = makeDbUser();
            mockUserRepo.findByEmail.mockResolvedValue(dbUser);

            const result = await adapter.findByEmail(dbUser.email);

            // The snake_case column must never surface on the domain record.
            expect(result).not.toHaveProperty('password_hash');
            expect(result).toHaveProperty('passwordHash', dbUser.password_hash);

            // A complete row was supplied, so every dropped column is a
            // real assertion rather than a vacuous one.
            expect(result).not.toHaveProperty('name');
            expect(result).not.toHaveProperty('kyc_risk_tier');
            expect(result).not.toHaveProperty('last_oidc_groups');
            expect(result).not.toHaveProperty('created_at');
            expect(result).not.toHaveProperty('updated_at');

            // Exactly the four declared fields, nothing more.
            expect(Object.keys(result as UserRecord).sort()).toEqual([
                'email',
                'id',
                'passwordHash',
                'role',
            ]);
        });

        it('returns a new object rather than the repository row itself', async () => {
            const dbUser = makeDbUser();
            mockUserRepo.findByEmail.mockResolvedValue(dbUser);

            const result = await adapter.findByEmail(dbUser.email);

            // Identity sharing would let a caller mutate the cached row.
            expect(result).not.toBe(dbUser);
            // ...and the source row must be left untouched.
            expect(dbUser).toEqual(makeDbUser());
        });

        it.each<UserRole>(['startup', 'investor'])(
            'passes the %s role through verbatim',
            async (role) => {
                const dbUser = makeDbUser({ role });
                mockUserRepo.findByEmail.mockResolvedValue(dbUser);

                const result = await adapter.findByEmail(dbUser.email);

                expect(result!.role).toBe(role);
            },
        );

        it('does not validate or rewrite the role value', async () => {
            // Contract lock: the adapter casts through `as any` and performs no
            // membership check. `UserRecord.role` is a compile-time claim only.
            // A future refactor that starts rejecting unknown roles here would
            // break `LoginService`, which forwards `user.role` straight into
            // the JWT claim — so this test exists to make that change deliberate.
            const dbUser = makeDbUser({ role: 'admin' as User['role'] });
            mockUserRepo.findByEmail.mockResolvedValue(dbUser);

            const result = await adapter.findByEmail(dbUser.email);

            expect(result!.role).toBe('admin');
        });

        it('delegates to UserRepository.findByEmail exactly once', async () => {
            const dbUser = makeDbUser();
            mockUserRepo.findByEmail.mockResolvedValue(dbUser);

            await adapter.findByEmail('founder@startup.io');

            expect(mockUserRepo.findByEmail).toHaveBeenCalledTimes(1);
            expect(mockUserRepo.findByEmail).toHaveBeenCalledWith('founder@startup.io');
        });
    });

    // ── The branch named in issue #970 ──────────────────────────────────

    describe('findByEmail - empty result path (if (!user) return null)', () => {
        it('returns null when the repository finds no row', async () => {
            mockUserRepo.findByEmail.mockResolvedValue(null);

            const result = await adapter.findByEmail('nobody@example.com');

            expect(result).toBeNull();
        });

        it('returns null when the repository resolves undefined', async () => {
            // A boundary the `User | null` type does not describe but a real
            // driver/mapping layer can produce. The falsy guard must absorb
            // it rather than falling through to a field read on `undefined`.
            mockUserRepo.findByEmail.mockResolvedValue(undefined as unknown as null);

            const result = await adapter.findByEmail('nobody@example.com');

            expect(result).toBeNull();
        });

        it.each([
            ['null', null],
            ['undefined', undefined],
            ['empty string', ''],
            ['0', 0],
            ['false', false],
        ])(
            'collapses the falsy row %s to exactly null',
            async (_label, falsyRow) => {
                mockUserRepo.findByEmail.mockResolvedValue(falsyRow as unknown as null);

                const result = await adapter.findByEmail('nobody@example.com');

                // `toBeNull` is stricter than `toBeFalsy`: it rejects a
                // regression that returns `undefined`, `{}` or `''`.
                expect(result).toBeNull();
            },
        );

        it('does not attempt to read fields off the empty result', async () => {
            mockUserRepo.findByEmail.mockResolvedValue(null);

            // Would throw a TypeError if the guard were removed or reordered.
            await expect(adapter.findByEmail('nobody@example.com')).resolves.toBeNull();
        });

        it('still delegates to the repository with the requested email', async () => {
            mockUserRepo.findByEmail.mockResolvedValue(null);

            await adapter.findByEmail('nobody@example.com');

            expect(mockUserRepo.findByEmail).toHaveBeenCalledTimes(1);
            expect(mockUserRepo.findByEmail).toHaveBeenCalledWith('nobody@example.com');
        });

        it('returns null deterministically across repeated lookups', async () => {
            mockUserRepo.findByEmail.mockResolvedValue(null);

            const results = await Promise.all([
                adapter.findByEmail('nobody@example.com'),
                adapter.findByEmail('nobody@example.com'),
                adapter.findByEmail('nobody@example.com'),
            ]);

            expect(results).toEqual([null, null, null]);
        });

        it('does not memoise or cache the miss', async () => {
            mockUserRepo.findByEmail.mockResolvedValue(null);

            await adapter.findByEmail('late@startup.io');
            expect(mockUserRepo.findByEmail).toHaveBeenCalledTimes(1);

            // Account created after the first miss — the adapter holds no
            // state, so the next lookup must go back to the repository.
            mockUserRepo.findByEmail.mockResolvedValue(
                makeDbUser({ id: 'user-new', email: 'late@startup.io' }),
            );
            const result = await adapter.findByEmail('late@startup.io');

            expect(mockUserRepo.findByEmail).toHaveBeenCalledTimes(2);
            expect(result!.id).toBe('user-new');
        });
    });

    // ── Upstream failure: must not degrade to a miss ────────────────────

    describe('findByEmail - upstream failure propagation', () => {
        it('rejects with the original database error instead of resolving null', async () => {
            const dbError = Object.assign(new Error('connection terminated unexpectedly'), {
                code: 'ECONNRESET',
            });
            mockUserRepo.findByEmail.mockRejectedValue(dbError);

            // The identity check is the point: the adapter must not wrap,
            // re-message or replace the error, so the route's error handler
            // and the structured logger keep the original pg metadata.
            await expect(adapter.findByEmail('founder@startup.io')).rejects.toBe(dbError);
        });

        it('does not swallow a rejected lookup into a null result', async () => {
            mockUserRepo.findByEmail.mockRejectedValue(new Error('deadline exceeded'));

            const result = await adapter
                .findByEmail('founder@startup.io')
                .then((value) => ({ resolved: true, value }))
                .catch(() => ({ resolved: false }));

            // A DB outage surfacing as `null` would be reported to the caller
            // as "invalid credentials" (HTTP 401) instead of HTTP 500.
            expect(result).toEqual({ resolved: false });
        });

        it('propagates a rejected promise even when the email is empty', async () => {
            const dbError = new Error('relation "users" does not exist');
            mockUserRepo.findByEmail.mockRejectedValue(dbError);

            await expect(adapter.findByEmail('')).rejects.toBe(dbError);
        });
    });

    // ── Boundary inputs ─────────────────────────────────────────────────

    describe('findByEmail - boundary inputs', () => {
        it.each([
            ['empty string', ''],
            ['a single space', ' '],
            ['whitespace-padded email', '  founder@startup.io  '],
            ['mixed-case email', 'Founder@Startup.IO'],
            ['RFC 5321 maximum-length local part (64 octets)', `${'a'.repeat(64)}@startup.io`],
            ['maximum-length address (320 octets)', `${'a'.repeat(64)}@${'b'.repeat(64)}.${'c'.repeat(185)}.io`],
            ['single-character local part', 'a@b.io'],
            ['plus-addressed email', 'founder+login@startup.io'],
            ['unicode / IDN email', 'födér@stärtup.io'],
            ['SQL metacharacters in the email', "'; DROP TABLE users; --@x.io"],
            ['a newline in the address', 'founder@startup.io\nBcc: victim@x.io'],
        ])('delegates %s verbatim to the repository', async (_label, email) => {
            mockUserRepo.findByEmail.mockResolvedValue(null);

            const result = await adapter.findByEmail(email);

            // No trimming, casing or filtering in the adapter: the exact
            // string is passed through as a bound `$1` parameter.
            expect(mockUserRepo.findByEmail).toHaveBeenCalledWith(email);
            expect(result).toBeNull();
        });

        it('forwards a non-string argument without coercion', async () => {
            mockUserRepo.findByEmail.mockResolvedValue(null);

            // The handler layer owns type validation; the adapter must not
            // stringify a bad value and turn it into a plausible lookup.
            await adapter.findByEmail(undefined as unknown as string);
            expect(mockUserRepo.findByEmail).toHaveBeenCalledWith(undefined);

            await adapter.findByEmail(42 as unknown as string);
            expect(mockUserRepo.findByEmail).toHaveBeenLastCalledWith(42);
        });

        it('preserves case rather than normalising it', async () => {
            mockUserRepo.findByEmail.mockResolvedValue(null);

            await adapter.findByEmail('Founder@Startup.IO');

            // Lower-casing here would silently diverge from the canonical
            // form stored by RegisterService and break lookups for users
            // who registered with an upper-case address.
            expect(mockUserRepo.findByEmail).toHaveBeenCalledWith('Founder@Startup.IO');
        });

        it('issues one query per call regardless of input shape', async () => {
            mockUserRepo.findByEmail.mockResolvedValue(null);

            await adapter.findByEmail('');
            await adapter.findByEmail('nobody@example.com');
            await adapter.findByEmail('nobody@example.com');

            expect(mockUserRepo.findByEmail).toHaveBeenCalledTimes(3);
        });
    });

    // ── Downstream contract ─────────────────────────────────────────────

    describe('findByEmail - consumed by LoginService', () => {
        const buildLoginService = () => {
            const sessionRepo = { createSession: jest.fn().mockResolvedValue(undefined) };
            const jwtIssuer = {
                sign: jest.fn().mockReturnValue({
                    accessToken: 'access-token',
                    refreshToken: 'refresh-token',
                }),
            };
            return { service: new LoginService(adapter, sessionRepo, jwtIssuer), sessionRepo, jwtIssuer };
        };

        it('turns the empty-result path into a null login (no token issued)', async () => {
            mockUserRepo.findByEmail.mockResolvedValue(null);
            const { service, jwtIssuer, sessionRepo } = buildLoginService();

            const result = await service.login('nobody@example.com', 's3cret!');

            expect(result).toBeNull();
            // Guards against a regression that lets an empty lookup reach
            // the token-issuing half of the flow.
            expect(jwtIssuer.sign).not.toHaveBeenCalled();
            expect(sessionRepo.createSession).not.toHaveBeenCalled();
        });

        it('surfaces a repository outage as a rejection, not an invalid-credential result', async () => {
            mockUserRepo.findByEmail.mockRejectedValue(new Error('pool exhausted'));
            const { service } = buildLoginService();

            await expect(service.login('founder@startup.io', 's3cret!')).rejects.toThrow(
                'pool exhausted',
            );
        });

        it('authenticates a mapped row end to end', async () => {
            // SHA-256 hex digest of 's3cret!' — the algorithm LoginService.verifyPassword uses.
            const passwordHash =
                '5cb7b35eb7ae9bbd505baa5cde3fb64c1e9a5e8862072013989c0a557ab9eaa2';
            mockUserRepo.findByEmail.mockResolvedValue(makeDbUser({ password_hash: passwordHash }));
            const { service, jwtIssuer, sessionRepo } = buildLoginService();

            const result = await service.login('founder@startup.io', 's3cret!');

            expect(result).not.toBeNull();
            expect(result!.user).toEqual({
                id: 'user-1',
                email: 'founder@startup.io',
                role: 'startup',
            });
            expect(jwtIssuer.sign).toHaveBeenCalledTimes(1);
            expect(jwtIssuer.sign).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 'user-1', role: 'startup' }),
            );
            expect(sessionRepo.createSession).toHaveBeenCalledTimes(1);
        });

        it('fails closed when the adapter returns a row whose hash does not match', async () => {
            mockUserRepo.findByEmail.mockResolvedValue(
                makeDbUser({ password_hash: 'x'.repeat(64) }),
            );
            const { service, jwtIssuer } = buildLoginService();

            const result = await service.login('founder@startup.io', 's3cret!');

            // A non-null adapter result must still be rejected by the password
            // check — a mapped record is not an authenticated user.
            expect(result).toBeNull();
            expect(jwtIssuer.sign).not.toHaveBeenCalled();
        });
    });
});
