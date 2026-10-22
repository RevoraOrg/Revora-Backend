/**
 * Dedicated test suite for `src/auth/register/types.ts`.
 *
 * ── Nature of the module ─────────────────────────────────────────────
 * `types.ts` is a PURE compile-time type-declaration module. Every export is
 * type-only:
 *
 *   - `UserRole`               : a string-literal union ('startup' | 'investor')
 *   - `RegisteredUser`         : an interface (shape only)
 *   - `IUserRepository`        : an interface (shape only)
 *   - `RegisterRequestBody`    : an interface (shape only)
 *   - `RegisterSuccessResponse`: an interface (shape only)
 *
 * There is no runtime code in the file, so there is nothing to "execute"
 * against these exports directly. To give the public contract real regression
 * protection without changing it, coverage is split across two layers:
 *
 *   (A) Type-level assertions validated by `tsc --noEmit` (see "Type-level
 *       contract"). Because the repo has no dedicated type-test tooling
 *       (vitest `expectTypeOf`, `tsd`, etc.), these use the standard `satisfies`
 *       operator and `// @ts-expect-error` directives. Each directive suppresses
 *       a *real* compile error today; if the type ever loosens (e.g. a new role
 *       is added, a field is dropped/made optional), `tsc` fails with an
 *       "Unused '@ts-expect-error' directive" or a missing/ excess-property
 *       error, catching the regression.
 *
 *       NOTE: `jest` is configured with `ts-jest` `isolatedModules: true` and
 *       `diagnostics.warnOnly`, so jest does NOT type-check. The type-level
 *       assertions are intentionally runtime no-ops (their locals are referenced
 *       so the test is registered) and are only asserted by the type-check step.
 *
 *   (B) A runtime in-memory implementation of `IUserRepository` that exercises
 *       the contract semantics the registration service actually depends on —
 *       `findByEmail` hit/miss (the duplicate-detection signal) and the
 *       `createUser` return shape and input contract.
 *
 * ── State transitions ────────────────────────────────────────────────
 * `types.ts` declares no state of its own. The only state transition that
 * touches these types is in `registerService.ts`
 * (`unregistered → registered user, role = 'investor'`), already covered by
 * `registerService.test.ts` and `__tests__/roundtrip.test.ts`. This file pins
 * the contract *those* transitions rely on (notably that `createUser` accepts
 * only the literal `role: 'investor'`) rather than fabricating a transition.
 *
 * ── Determinism ─────────────────────────────────────────────────────
 * All fixtures use fixed strings, deterministic IDs (`user-N`), and a fixed
 * `created_at` `Date`. No real time, randomness, network, or database is used.
 */

import type {
  IUserRepository,
  RegisterRequestBody,
  RegisterSuccessResponse,
  RegisteredUser,
  UserRole,
} from './types';

// ─── Shared fixture ───────────────────────────────────────────────────────────

/** Fixed timestamp used everywhere a `Date` is required, for determinism. */
const FIXED_DATE = new Date('2024-01-01T00:00:00.000Z');

/**
 * Builds a `RegisteredUser` with sensible defaults. The `role` parameter
 * mirrors `RegisteredUser.role` exactly (typed `UserRole`) so the helper itself
 * stays in-sync with the type being tested.
 */
function makeRegisteredUser(role: UserRole = 'investor'): RegisteredUser {
  return {
    id: 'user-1',
    email: 'investor@example.com',
    role,
    created_at: FIXED_DATE,
  };
}

/** Input shape consumed by `IUserRepository.createUser`, derived from the interface. */
type CreateUserInput = Parameters<IUserRepository['createUser']>[0];

// ─── Type-level contract: UserRole ─────────────────────────────────────────────

describe('UserRole (type-level contract, asserted by tsc --noEmit)', () => {
  // Both literals are valid members of the union and the union is exactly the
  // stable set { 'startup', 'investor' }. The `Record<UserRole, true>` literal
  // is checked at compile time: if a role is added the object is missing a key
  // (error); if a role is removed it has an excess key (error). This guards the
  // exact set against accidental drift.
  const EXACT_ROLES: Record<UserRole, true> = {
    startup: true,
    investor: true,
  };

  it('exposes exactly the stable role set { startup, investor }', () => {
    expect(Object.keys(EXACT_ROLES).sort()).toEqual(['investor', 'startup']);
  });

  it('accepts every valid UserRole literal (success paths)', () => {
    const startup: UserRole = 'startup';
    const investor: UserRole = 'investor';
    expect(startup).toBe('startup');
    expect(investor).toBe('investor');
  });

  it('rejects invalid role literals at the type level (failure paths)', () => {
    // @ts-expect-error - 'admin' is not a member of the UserRole union
    const admin: UserRole = 'admin';
    // @ts-expect-error - casing matters: 'Startup' is a distinct literal
    const startupCapitalized: UserRole = 'Startup';
    // @ts-expect-error - trailing whitespace makes a distinct string literal
    const trailingSpace: UserRole = 'startup ';
    // @ts-expect-error - empty string is not a UserRole
    const empty: UserRole = '';
    // @ts-expect-error - a widened generic string is not the literal union
    const widened: UserRole = 'investor' as string;
    // @ts-expect-error - undefined is not a UserRole
    const asUndefined: UserRole = undefined;
    // @ts-expect-error - null is not a UserRole
    const asNull: UserRole = null;
    // @ts-expect-error - a number is not a UserRole
    const asNumber: UserRole = 1;

    // The `expect` calls below only register the test under jest; the real
    // assertion is compile-time — tsc must reject each assignment above.
    expect(Array.of(admin, startupCapitalized, trailingSpace, empty)).toEqual([
      'admin',
      'Startup',
      'startup ',
      '',
    ]);
    expect(widened).toBe('investor');
    expect(asUndefined).toBeUndefined();
    expect(asNull).toBeNull();
    expect(asNumber).toBe(1);
  });
});

// ─── Type-level contract: RegisteredUser ────────────────────────────────────────

describe('RegisteredUser (type-level contract, asserted by tsc --noEmit)', () => {
  it('accepts both UserRole values on the role field', () => {
    expect(makeRegisteredUser('startup').role).toBe('startup');
    expect(makeRegisteredUser('investor').role).toBe('investor');
  });

  it('requires id, email, role, and created_at with correct types', () => {
    const valid: RegisteredUser = makeRegisteredUser();
    expect(valid.id).toBe('user-1');
    expect(valid.email).toBe('investor@example.com');
    expect(valid.role).toBe('investor');
    expect(valid.created_at).toBeInstanceOf(Date);

    // NOTE: each `@ts-expect-error` is on the line immediately above a SINGLE-LINE
    // assignment. TypeScript reports property errors at the offending expression
    // on that line; the directive only suppresses the immediately-following line,
    // so multi-line literals would leave the real error unsuppressed.
    // @ts-expect-error - RegisteredUser requires `id`
    const missingId: RegisteredUser = { email: 'a@b.com', role: 'investor', created_at: FIXED_DATE };
    // @ts-expect-error - RegisteredUser requires `email`
    const missingEmail: RegisteredUser = { id: 'u', role: 'investor', created_at: FIXED_DATE };
    // @ts-expect-error - RegisteredUser requires `role`
    const missingRole: RegisteredUser = { id: 'u', email: 'a@b.com', created_at: FIXED_DATE };
    // @ts-expect-error - RegisteredUser requires `created_at`
    const missingCreatedAt: RegisteredUser = { id: 'u', email: 'a@b.com', role: 'investor' };
    // @ts-expect-error - role must be the UserRole union, not a number
    const badRoleType: RegisteredUser = { id: 'u', email: 'a@b.com', role: 7, created_at: FIXED_DATE };
    // @ts-expect-error - 'admin' is not a valid UserRole
    const badRoleLiteral: RegisteredUser = { id: 'u', email: 'a@b.com', role: 'admin', created_at: FIXED_DATE };
    // @ts-expect-error - created_at must be a Date, not a string
    const badCreatedAt: RegisteredUser = { id: 'u', email: 'a@b.com', role: 'investor', created_at: '2024-01-01' };
    // @ts-expect-error - id must be a string, not a number
    const badId: RegisteredUser = { id: 1, email: 'a@b.com', role: 'investor', created_at: FIXED_DATE };

    // Each rejected local is referenced so the test registers under jest.
    expect(missingId).toBeDefined();
    expect(missingEmail).toBeDefined();
    expect(missingRole).toBeDefined();
    expect(missingCreatedAt).toBeDefined();
    expect(badRoleType).toBeDefined();
    expect(badRoleLiteral).toBeDefined();
    expect(badCreatedAt).toBeDefined();
    expect(badId).toBeDefined();
  });
});

// ─── Type-level contract: RegisterRequestBody ────────────────────────────────

describe('RegisterRequestBody (type-level contract, asserted by tsc --noEmit)', () => {
  it('treats every field as optional and accepts arbitrary runtime types', () => {
    // All fields are optional, so the empty object is valid.
    const empty: RegisterRequestBody = {};
    // Only some fields supplied.
    const partial: RegisterRequestBody = { email: 'a@b.com', password: 'p' };
    // All fields supplied, including the optional `name`.
    const full: RegisterRequestBody = {
      email: 'a@b.com',
      password: 'p',
      name: 'Alice',
    };
    // Each field is typed `unknown`, so any runtime value is accepted.
    const unknownTypes: RegisterRequestBody = {
      email: 123,
      password: true,
      name: null,
    };

    expect(empty).toEqual({});
    expect(partial.email).toBe('a@b.com');
    expect(full.name).toBe('Alice');
    expect(unknownTypes.email).toBe(123);
    expect(unknownTypes.password).toBe(true);
    expect(unknownTypes.name).toBeNull();
  });
});

// ─── Type-level contract: RegisterSuccessResponse ────────────────────────────

describe('RegisterSuccessResponse (type-level contract, asserted by tsc --noEmit)', () => {
  it('requires a nested user with id, email, and role', () => {
    const valid: RegisterSuccessResponse = {
      user: { id: 'u-1', email: 'a@b.com', role: 'investor' },
    };
    expect(valid.user.role).toBe('investor');

    // @ts-expect-error - RegisterSuccessResponse requires `user`
    const missingUser: RegisterSuccessResponse = {};
    // @ts-expect-error - nested user requires `role`
    const missingRole: RegisterSuccessResponse = { user: { id: 'u', email: 'a@b.com' } };
    // @ts-expect-error - nested user `role` must be a UserRole, not a number
    const badRole: RegisterSuccessResponse = { user: { id: 'u', email: 'a@b.com', role: 7 } };

    expect(missingUser).toBeDefined();
    expect(missingRole).toBeDefined();
    expect(badRole).toBeDefined();
  });
});

// ─── Type-level + runtime contract: IUserRepository ──────────────────────────

/**
 * Minimal in-memory implementation of the `IUserRepository` contract.
 *
 * It returns the narrow `{ id }` projection from `findByEmail` (matching the
 * interface signature rather than leaking the full stored record) and returns a
 * full `RegisteredUser` from `createUser`. Determinism: IDs are `user-N` and
 * `created_at` is the fixed `FIXED_DATE`.
 */
class InMemoryUserRepository implements IUserRepository {
  private readonly users: Map<string, RegisteredUser> = new Map();
  private readonly hashes: Map<string, string> = new Map();

  async findByEmail(email: string): Promise<{ id: string } | null> {
    const stored = this.users.get(email);
    return stored ? { id: stored.id } : null;
  }

  async createUser(input: CreateUserInput): Promise<RegisteredUser> {
    const user: RegisteredUser = {
      id: `user-${this.users.size + 1}`,
      email: input.email,
      role: input.role,
      created_at: FIXED_DATE,
    };
    this.users.set(input.email, user);
    this.hashes.set(input.email, input.password_hash);
    return user;
  }

  getHash(email: string): string | undefined {
    return this.hashes.get(email);
  }
}

describe('IUserRepository (type-level + runtime contract)', () => {
  it('is satisfied by a correctly-shaped plain object', () => {
    const repo: IUserRepository = {
      async findByEmail() {
        return null;
      },
      async createUser() {
        return makeRegisteredUser();
      },
    };
    expect(typeof repo.findByEmail).toBe('function');
    expect(typeof repo.createUser).toBe('function');
  });

  it('rejects an object missing createUser at the type level', () => {
    // @ts-expect-error - IUserRepository requires both findByEmail and createUser
    const missingCreate: IUserRepository = {
      async findByEmail() {
        return null;
      },
    };
    expect(missingCreate).toBeDefined();
  });

  it('preserves the exact method surface { findByEmail, createUser }', () => {
    const surface: Record<keyof IUserRepository, true> = {
      findByEmail: true,
      createUser: true,
    };
    // Compile-time: `Record<keyof IUserRepository, true>` errors if a method is
    // added (missing key) or removed (excess key). Runtime: keys match.
    expect(Object.keys(surface).sort()).toEqual(['createUser', 'findByEmail']);
  });

  it('createUser input requires the literal role "investor", not "startup"', () => {
    // The UserRole union contains 'startup', but the repository contract for
    // account creation only accepts the literal 'investor'.
    // @ts-expect-error - CreateUserInput.role is the literal 'investor'
    const invalid: CreateUserInput = { email: 'x@b.com', password_hash: 'h', role: 'startup' };
    expect(invalid.role).toBe('startup');
  });

  // ── Runtime contract exercised through the in-memory implementation ───────

  it('returns null for an unknown email (not-found path)', async () => {
    const repo = new InMemoryUserRepository();
    await expect(repo.findByEmail('nobody@example.com')).resolves.toBeNull();
  });

  it('createUser returns a RegisteredUser matching the interface shape', async () => {
    const repo = new InMemoryUserRepository();
    const user = await repo.createUser({
      email: 'investor@example.com',
      password_hash: '0123456789abcdef',
      role: 'investor',
    });
    expect(user).toEqual({
      id: 'user-1',
      email: 'investor@example.com',
      role: 'investor',
      created_at: FIXED_DATE,
    });
  });

  it('createUser stores the hash internally (does not leak via findByEmail)', async () => {
    const repo = new InMemoryUserRepository();
    await repo.createUser({
      email: 'a@b.com',
      password_hash: 'hash-9f2a',
      role: 'investor',
    });
    // The projection returned by findByEmail intentionally carries only `id`.
    const found = await repo.findByEmail('a@b.com');
    expect(found).toEqual({ id: 'user-1' });
    // The hash is retrievable for test introspection but not via the contract.
    expect(repo.getHash('a@b.com')).toBe('hash-9f2a');
  });

  it('after createUser, findByEmail returns a hit with the matching id', async () => {
    const repo = new InMemoryUserRepository();
    const created = await repo.createUser({
      email: 'hit@example.com',
      password_hash: 'h',
      role: 'investor',
    });
    const found = await repo.findByEmail('hit@example.com');
    expect(found).not.toBeNull();
    expect(found).toEqual({ id: created.id });
    expect(found?.id).toBe('user-1');
  });

  it('is not found before createUser and found after (duplicate-detection signal)', async () => {
    const repo = new InMemoryUserRepository();
    expect(await repo.findByEmail('dup@example.com')).toBeNull();
    await repo.createUser({
      email: 'dup@example.com',
      password_hash: 'h',
      role: 'investor',
    });
    // This is precisely the signal RegisterService relies on: it calls
    // findByEmail before createUser and throws DuplicateEmailError when the
    // lookup returns a non-null value.
    expect(await repo.findByEmail('dup@example.com')).not.toBeNull();
  });

  it('each email maps to a distinct user (no cross-talk)', async () => {
    const repo = new InMemoryUserRepository();
    const u1 = await repo.createUser({
      email: 'one@example.com',
      password_hash: 'h1',
      role: 'investor',
    });
    const u2 = await repo.createUser({
      email: 'two@example.com',
      password_hash: 'h2',
      role: 'investor',
    });
    expect(u1.id).toBe('user-1');
    expect(u2.id).toBe('user-2');
    expect(await repo.findByEmail('one@example.com')).toEqual({ id: 'user-1' });
    expect(await repo.findByEmail('two@example.com')).toEqual({ id: 'user-2' });
  });
});
