/**
 * @file Focused regression suite for `UserRepository` failure handling (issue #1027).
 *
 * @notice Pins the three explicit failure / empty-result exits named in the issue
 *   so that a silent behaviour change fails CI instead of reaching callers:
 *
 *   | Evidence (pre-change)                          | Branch exercised                                    |
 *   | ---------------------------------------------- | --------------------------------------------------- |
 *   | `src/db/repositories/userRepository.ts:129`    | `createUser` → `throw new Error('Failed to create user')` |
 *   | `src/db/repositories/userRepository.ts:182`    | `updateUser` (no fields) → `throw new Error('User not found')` |
 *   | `src/db/repositories/userRepository.ts:201`    | `updateUser` (UPDATE) → `throw new Error('Failed to update user')` |
 *
 * @dev Contract rules exercised here (all pre-existing, unchanged by this suite):
 *   - The three failure exits are plain `Error`s with **exact** messages
 *     `'Failed to create user'`, `'User not found'` and `'Failed to update user'`.
 *     They are deliberately *not* `UniqueConstraintError` (that class is reserved
 *     for pg `23505`) and are never silently swallowed into a `null`/partial user.
 *   - The empty-result branches key on `result.rows.length`, **not** on
 *     `rowCount`. A driver/pool that reports a stale or inconsistent `rowCount`
 *     cannot turn an empty result into a successful write.
 *   - Every failure is raised *after* the query returns; a rejected query is
 *     routed through `handlePgError`, so `23505` still surfaces as
 *     `UniqueConstraintError` (identified by reference for unknown errors).
 *   - `updateUser({ id })` with no updatable field is a documented no-op: one
 *     `SELECT` is issued, **no** `UPDATE` reaches the database, and a missing row
 *     is the only way that path can fail.
 *   - Failure messages are deterministic and leak neither SQL text, the email nor
 *     the password hash.
 *
 * Security assumptions, abuse/failure paths and residual risk:
 * `docs/user-failure-handling-regression.md`.
 */

import { Pool, QueryResult, QueryResultRow } from 'pg';
import { UserRepository, User, CreateUserInput } from './userRepository';
import { UniqueConstraintError } from '../../lib/errors';

// ─── Fixtures and helpers ─────────────────────────────────────────────────────

const BASE_USER: User = {
  id: 'user-1027',
  email: 'alice@example.com',
  password_hash: 'salt:hash',
  name: 'Alice',
  role: 'investor',
  kyc_risk_tier: 'standard',
  // `mapUser` always materialises this key (`?? null`), so the fixture includes it
  // to keep `toEqual` comparisons exact.
  last_oidc_groups: null,
  created_at: new Date('2024-01-01T00:00:00.000Z'),
  updated_at: new Date('2024-01-01T00:00:00.000Z'),
};

const CREATE_INPUT: CreateUserInput = {
  email: 'bob@example.com',
  password_hash: 'salt:hash',
  name: 'Bob',
  role: 'startup',
};

function makeQueryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

/** Await a promise that must reject and return the thrown value for inspection. */
async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('Expected the promise to reject, but it resolved instead');
}

/** Assert a call settles without resolving — used for "never returns a user" pins. */
async function resolvesWithoutThrowing(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('UserRepository failure handling (regression for #1027)', () => {
  let repository: UserRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    repository = new UserRepository(mockPool as unknown as Pool);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── createUser — empty-result failure contract (line 129) ──────────────────

  describe('createUser — empty-result failure contract (line 129)', () => {
    it('throws a plain Error with the exact message "Failed to create user"', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      const err = await captureError(() => repository.createUser(CREATE_INPUT));

      // The exact string is a public contract: callers map it to HTTP 500 and
      // operators grep for it in logs.
      expect(err.message).toBe('Failed to create user');
      expect(err.name).toBe('Error');
    });

    it('does not raise UniqueConstraintError for an empty insert result', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      const err = await captureError(() => repository.createUser(CREATE_INPUT));

      // 23505 is the only path that may produce UniqueConstraintError; an empty
      // RETURNING set means the INSERT did not persist, which is a different
      // failure class (no 409 mapping may be applied to it).
      expect(err).not.toBeInstanceOf(UniqueConstraintError);
      expect(err).toBeInstanceOf(Error);
    });

    it('never resolves with a partial or fabricated user', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(
        resolvesWithoutThrowing(() => repository.createUser(CREATE_INPUT)),
      ).resolves.toBe(false);
    });

    it('is keyed on rows.length, not rowCount (inconsistent driver rowCount still throws)', async () => {
      // A pool/driver (or a mocked statement) that reports rowCount: 1 while
      // returning no rows must not be able to turn a lost INSERT into a success.
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
        command: 'INSERT',
        oid: 0,
        fields: [],
      });

      await expect(repository.createUser(CREATE_INPUT)).rejects.toThrow('Failed to create user');
    });

    it('fails loudly instead of returning a user when the driver yields an unusable row', async () => {
      // Out-of-contract driver shape (a NULL first row). The important property is
      // that the call rejects: a future refactor must not "repair" this into a
      // truthy user object.
      mockPool.query.mockResolvedValueOnce(makeQueryResult([null as unknown as User]));

      await expect(
        resolvesWithoutThrowing(() => repository.createUser(CREATE_INPUT)),
      ).resolves.toBe(false);
    });

    it('is deterministic across repeated identical calls', async () => {
      mockPool.query
        .mockResolvedValueOnce(makeQueryResult([]))
        .mockResolvedValueOnce(makeQueryResult([]));

      const first = await captureError(() => repository.createUser(CREATE_INPUT));
      const second = await captureError(() => repository.createUser(CREATE_INPUT));

      expect(first.message).toBe(second.message);
      expect(first.name).toBe(second.name);
      expect(mockPool.query).toHaveBeenCalledTimes(2);
    });

    it('does not leak SQL text, the email or the password hash in the failure message', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      const err = await captureError(() => repository.createUser(CREATE_INPUT));

      expect(err.message).not.toContain('INSERT');
      expect(err.message).not.toContain(CREATE_INPUT.email);
      expect(err.message).not.toContain(CREATE_INPUT.password_hash);
    });
  });

  // ── createUser — neighbouring normal path and boundaries ───────────────────

  describe('createUser — neighbouring normal path and boundary inputs', () => {
    it('returns the fully mapped row on success', async () => {
      mockPool.query.mockResolvedValueOnce(
        makeQueryResult([{ ...BASE_USER, name: 'Bob', role: 'startup' }]),
      );

      const created = await repository.createUser(CREATE_INPUT);

      expect(created).toEqual({ ...BASE_USER, name: 'Bob', role: 'startup' });
      // password_hash stays present for internal auth flows; API layers strip it.
      expect(created.password_hash).toBe('salt:hash');
    });

    it('binds exactly five parameters in positional order (email, hash, name, role, tier)', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      await repository.createUser(CREATE_INPUT);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('RETURNING *'),
        ['bob@example.com', 'salt:hash', 'Bob', 'startup', 'standard'],
      );
    });

    it('applies role "startup" and tier "standard" defaults and binds name as NULL', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      await repository.createUser({ email: 'x@y.com', password_hash: 'h' });

      expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'), [
        'x@y.com',
        'h',
        null,
        'startup',
        'standard',
      ]);
    });

    it('passes an explicit role and KYC risk tier through unchanged', async () => {
      mockPool.query.mockResolvedValueOnce(
        makeQueryResult([{ ...BASE_USER, kyc_risk_tier: 'restricted' }]),
      );

      const created = await repository.createUser({
        email: 'x@y.com',
        password_hash: 'h',
        role: 'investor',
        kyc_risk_tier: 'restricted',
      });

      expect(mockPool.query.mock.calls[0][1]).toEqual([
        'x@y.com',
        'h',
        null,
        'investor',
        'restricted',
      ]);
      expect(created.kyc_risk_tier).toBe('restricted');
    });

    it('falls back to "standard" when the stored tier is unknown (mapping boundary)', async () => {
      mockPool.query.mockResolvedValueOnce(
        makeQueryResult([{ ...BASE_USER, kyc_risk_tier: 'legacy-unknown' }]),
      );

      const created = await repository.createUser(CREATE_INPUT);

      expect(created.kyc_risk_tier).toBe('standard');
    });

    it('maps a NULL stored name to undefined', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([{ ...BASE_USER, name: null }]));

      const created = await repository.createUser(CREATE_INPUT);

      expect(created.name).toBeUndefined();
    });

    it('binds hostile email content as a parameter instead of interpolating it', async () => {
      const hostile = "robert'); DROP TABLE users; --";
      mockPool.query.mockResolvedValueOnce(makeQueryResult([{ ...BASE_USER, email: hostile }]));

      await repository.createUser({ ...CREATE_INPUT, email: hostile });

      const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).not.toContain(hostile);
      expect(params[0]).toBe(hostile);
    });

    it('still maps pg 23505 to UniqueConstraintError (failure-class boundary)', async () => {
      const pgUniqueError = Object.assign(new Error('duplicate key value'), { code: '23505' });
      mockPool.query.mockRejectedValueOnce(pgUniqueError);

      const err = await captureError(() => repository.createUser(CREATE_INPUT));

      expect(err).toBeInstanceOf(UniqueConstraintError);
      expect((err as UniqueConstraintError).field).toBe('email');
      expect(err.message).not.toBe('Failed to create user');
    });

    it('re-throws a non-23505 pg error by identity', async () => {
      const pgError = Object.assign(new Error('connection terminated'), { code: 'ECONNRESET' });
      mockPool.query.mockRejectedValueOnce(pgError);

      await expect(repository.createUser(CREATE_INPUT)).rejects.toBe(pgError);
    });
  });

  // ── updateUser — no-field "User not found" contract (line 182) ─────────────

  describe('updateUser — no-field "User not found" contract (line 182)', () => {
    it('throws a plain Error with the exact message "User not found"', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      const err = await captureError(() => repository.updateUser({ id: 'ghost-1027' }));

      expect(err.message).toBe('User not found');
      expect(err.name).toBe('Error');
      expect(err).not.toBeInstanceOf(UniqueConstraintError);
    });

    it('issues exactly one SELECT and never an UPDATE', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(repository.updateUser({ id: 'ghost-1027' })).rejects.toThrow('User not found');

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/SELECT/);
      expect(sql).not.toMatch(/UPDATE/);
      expect(params).toEqual(['ghost-1027']);
    });

    it('treats explicitly-undefined optional fields as "no fields provided" (boundary)', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(
        repository.updateUser({
          id: 'ghost-1027',
          email: undefined,
          name: undefined,
          password_hash: undefined,
          role: undefined,
          kyc_risk_tier: undefined,
          last_oidc_groups: undefined,
        }),
      ).rejects.toThrow('User not found');

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query.mock.calls[0][0]).not.toMatch(/UPDATE/);
    });

    it('treats an empty-string id as a normal lookup miss (boundary)', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(repository.updateUser({ id: '' })).rejects.toThrow('User not found');
      expect(mockPool.query.mock.calls[0][1]).toEqual(['']);
    });

    it('is deterministic across repeated identical calls', async () => {
      mockPool.query
        .mockResolvedValueOnce(makeQueryResult([]))
        .mockResolvedValueOnce(makeQueryResult([]));

      const first = await captureError(() => repository.updateUser({ id: 'ghost-1027' }));
      const second = await captureError(() => repository.updateUser({ id: 'ghost-1027' }));

      expect(first.message).toBe(second.message);
      expect(first.name).toBe(second.name);
    });

    it('never resolves with a user when the lookup misses', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(
        resolvesWithoutThrowing(() => repository.updateUser({ id: 'ghost-1027' })),
      ).resolves.toBe(false);
    });
  });

  // ── updateUser — no-field neighbouring normal path ─────────────────────────

  describe('updateUser — no-field neighbouring normal path', () => {
    it('returns the existing mapped user without issuing an UPDATE', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      const updated = await repository.updateUser({ id: BASE_USER.id });

      expect(updated).toEqual(BASE_USER);
      // The no-op path must not write: it is a read-only "touch".
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query.mock.calls[0][0]).not.toMatch(/UPDATE/);
    });

    it('keeps password_hash available on the no-op return (internal contract)', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      const updated = await repository.updateUser({ id: BASE_USER.id });

      expect(updated.password_hash).toBe('salt:hash');
    });

    it('still maps a NULL stored name to undefined on the no-op path', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([{ ...BASE_USER, name: null }]));

      const updated = await repository.updateUser({ id: BASE_USER.id });

      expect(updated.name).toBeUndefined();
    });
  });

  // ── updateUser — empty-result failure contract (line 201) ──────────────────

  describe('updateUser — empty-result failure contract (line 201)', () => {
    it('throws a plain Error with the exact message "Failed to update user"', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      const err = await captureError(() =>
        repository.updateUser({ id: BASE_USER.id, email: 'new@example.com' }),
      );

      expect(err.message).toBe('Failed to update user');
      expect(err.name).toBe('Error');
      expect(err).not.toBeInstanceOf(UniqueConstraintError);
    });

    it('issues the UPDATE (with RETURNING *) exactly once and nothing else', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(
        repository.updateUser({ id: BASE_USER.id, email: 'new@example.com' }),
      ).rejects.toThrow('Failed to update user');

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/UPDATE users/);
      expect(sql).toMatch(/RETURNING \*/);
      // id is bound last, after every SET value.
      expect(params).toEqual(['new@example.com', BASE_USER.id]);
    });

    it('is keyed on rows.length, not rowCount (inconsistent driver rowCount still throws)', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

      await expect(
        repository.updateUser({ id: BASE_USER.id, role: 'startup' }),
      ).rejects.toThrow('Failed to update user');
    });

    it('never resolves with a partial or fabricated user', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(
        resolvesWithoutThrowing(() => repository.updateUser({ id: BASE_USER.id, role: 'startup' })),
      ).resolves.toBe(false);
    });

    it('keeps UniqueConstraintError as the class for pg 23505 (not "Failed to update user")', async () => {
      const pgUniqueError = Object.assign(new Error('duplicate key value'), { code: '23505' });
      mockPool.query.mockRejectedValueOnce(pgUniqueError);

      const err = await captureError(() =>
        repository.updateUser({ id: BASE_USER.id, email: 'taken@example.com' }),
      );

      expect(err).toBeInstanceOf(UniqueConstraintError);
      expect((err as UniqueConstraintError).field).toBe('email');
    });

    it('re-throws a non-23505 pg error by identity', async () => {
      const pgError = Object.assign(new Error('deadlock detected'), { code: '40P01' });
      mockPool.query.mockRejectedValueOnce(pgError);

      await expect(
        repository.updateUser({ id: BASE_USER.id, email: 'new@example.com' }),
      ).rejects.toBe(pgError);
    });

    it('is deterministic across repeated identical calls', async () => {
      mockPool.query
        .mockResolvedValueOnce(makeQueryResult([]))
        .mockResolvedValueOnce(makeQueryResult([]));

      const first = await captureError(() =>
        repository.updateUser({ id: BASE_USER.id, name: 'N' }),
      );
      const second = await captureError(() =>
        repository.updateUser({ id: BASE_USER.id, name: 'N' }),
      );

      expect(first.message).toBe(second.message);
      expect(second.message).toBe('Failed to update user');
    });

    it('does not leak SQL text, the new email or the password hash in the failure message', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      const err = await captureError(() =>
        repository.updateUser({
          id: BASE_USER.id,
          email: 'leak-check@example.com',
          password_hash: 'new-salt:new-hash',
        }),
      );

      expect(err.message).not.toContain('UPDATE');
      expect(err.message).not.toContain('leak-check@example.com');
      expect(err.message).not.toContain('new-salt:new-hash');
    });
  });

  // ── updateUser — neighbouring normal path, binding and boundaries ───────────

  describe('updateUser — neighbouring normal path, binding and boundaries', () => {
    it('returns the mapped updated row and stamps updated_at in SQL', async () => {
      const updatedRow = { ...BASE_USER, email: 'new@example.com', name: 'Alice B.' };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([updatedRow]));

      const updated = await repository.updateUser({
        id: BASE_USER.id,
        email: 'new@example.com',
        name: 'Alice B.',
      });

      expect(updated).toEqual(updatedRow);
      const sql = mockPool.query.mock.calls[0][0] as string;
      expect(sql).toMatch(/updated_at = NOW\(\)/);
    });

    it('binds every supported field in declaration order with the id last', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      await repository.updateUser({
        id: BASE_USER.id,
        email: 'new@example.com',
        name: 'Alice B.',
        password_hash: 'new:hash',
        role: 'startup',
        kyc_risk_tier: 'high',
        last_oidc_groups: ['investors', 'ops'],
      });

      const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([
        'new@example.com',
        'Alice B.',
        'new:hash',
        'startup',
        'high',
        JSON.stringify(['investors', 'ops']),
        BASE_USER.id,
      ]);
      for (const column of [
        'email = $1',
        'name = $2',
        'password_hash = $3',
        'role = $4',
        'kyc_risk_tier = $5',
        'last_oidc_groups = $6',
      ]) {
        expect(sql).toContain(column);
      }
    });

    it('treats last_oidc_groups: null as a provided value (clears groups via UPDATE)', async () => {
      // Boundary between "omitted" (no-op read path) and "explicitly cleared"
      // (a real UPDATE writing SQL NULL).
      mockPool.query.mockResolvedValueOnce(makeQueryResult([{ ...BASE_USER, last_oidc_groups: null }]));

      const updated = await repository.updateUser({ id: BASE_USER.id, last_oidc_groups: null });

      const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/UPDATE users/);
      expect(params).toEqual([null, BASE_USER.id]);
      expect(updated.last_oidc_groups).toBeNull();
    });

    it('serialises an empty last_oidc_groups array as JSON "[]"', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([{ ...BASE_USER, last_oidc_groups: [] }]));

      await repository.updateUser({ id: BASE_USER.id, last_oidc_groups: [] });

      expect(mockPool.query.mock.calls[0][1]).toEqual(['[]', BASE_USER.id]);
    });

    it('parses an unknown stored tier back to "standard" on the UPDATE return', async () => {
      mockPool.query.mockResolvedValueOnce(
        makeQueryResult([{ ...BASE_USER, kyc_risk_tier: 'not-a-tier' }]),
      );

      const updated = await repository.updateUser({ id: BASE_USER.id, role: 'startup' });

      expect(updated.kyc_risk_tier).toBe('standard');
    });

    it('binds an empty-string email instead of rejecting it at this layer (documented boundary)', async () => {
      // The repository performs no normalisation/validation; callers own it. The
      // test pins that empty input still reaches the database as a bound value
      // and that the empty-result branch keeps the failure observable.
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(repository.updateUser({ id: BASE_USER.id, email: '' })).rejects.toThrow(
        'Failed to update user',
      );

      expect(mockPool.query.mock.calls[0][1]).toEqual(['', BASE_USER.id]);
    });

    it('binds a quote-laden email as a parameter instead of interpolating it', async () => {
      const hostile = "x@y.com', role = 'admin";
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(repository.updateUser({ id: BASE_USER.id, email: hostile })).rejects.toThrow(
        'Failed to update user',
      );

      const [sql, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(sql).not.toContain(hostile);
      expect(params).toEqual([hostile, BASE_USER.id]);
    });
  });

  // ── updateKycRiskTier — delegation of the updateUser contract ──────────────

  describe('updateKycRiskTier — delegation of the updateUser contract', () => {
    it('returns the user with the new tier on success', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([{ ...BASE_USER, kyc_risk_tier: 'high' }]));

      const updated = await repository.updateKycRiskTier(BASE_USER.id, 'high');

      expect(updated.kyc_risk_tier).toBe('high');
      expect(mockPool.query.mock.calls[0][1]).toEqual(['high', BASE_USER.id]);
    });

    it('propagates the exact "Failed to update user" error when the UPDATE matches no row', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      const err = await captureError(() => repository.updateKycRiskTier('ghost-1027', 'high'));

      expect(err.message).toBe('Failed to update user');
      expect(err).not.toBeInstanceOf(UniqueConstraintError);
    });

    it('propagates the exact "User not found" error for a truly field-less call (id only)', async () => {
      // UpdateUserInput requires at least the id; calling updateUser with only an
      // id takes the no-op read path, so the 182 message is what a caller sees.
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      const err = await captureError(() => repository.updateUser({ id: 'ghost-1027' }));

      expect(err.message).toBe('User not found');
    });
  });
});

