/**
 * @file src/db/repositories/userRepository.regression.test.ts
 * @description
 * Focused regression suite for the three explicit failure / empty-result exits
 * named in issue #1027 of `src/db/repositories/userRepository.ts`:
 *
 *  - line 129 — `createUser`: `if (result.rows.length === 0) throw new Error('Failed to create user')`
 *  - line 182 — `updateUser` (no updatable fields): `if (!existing) throw new Error('User not found')`
 *  - line 201 — `updateUser`: `if (result.rows.length === 0) throw new Error('Failed to update user')`
 *
 * Why a separate file?
 * --------------------
 * `userRepository.test.ts` documents the happy path and the obvious failure
 * cases. This file *pins the contract* so a future refactor cannot silently
 * soften an empty-result guard into a success, a partial object, or a different
 * error class. Every assertion is intentionally about observable behaviour:
 * the rejection class, the exact message, the number of SQL statements issued
 * and the parameters they received.
 *
 * Test strategy:
 *  - `pg.Pool` is mocked; no database, network or environment is required.
 *  - Each `describe` block maps to exactly one of the three failure exits.
 *  - Each block also covers its *neighbouring* success path and boundary
 *    inputs (empty strings, `undefined` vs `null`, unknown stored tiers,
 *    hostile SQL payloads).
 *  - The guards are keyed on `rows.length`, never on `rowCount`; tests assert
 *    that a contradictory driver `rowCount` cannot change the outcome.
 *
 * Security invariants verified:
 *  - Failure messages are fixed literals: they never contain SQL, the email or
 *    the password hash, so logs/alerts are not an information-disclosure or
 *    statement-probing surface.
 *  - Values supplied by callers are always bound as query parameters; hostile
 *    `email` payloads never appear in the generated SQL text.
 *  - Duplicate-email races (`23505`) stay distinguishable from empty-result
 *    failures (`UniqueConstraintError` vs plain `Error`).
 *  - Non-`23505` driver errors are re-thrown by identity (no wrapping, no
 *    message rewriting).
 *  - The public return contract is unchanged: this file contains tests only,
 *    so `userRepository.ts` still returns `User`/`User | null` exactly as before.
 */

import { Pool, QueryResult, QueryResultRow } from 'pg';
import { UserRepository, User } from './userRepository';
import { UniqueConstraintError } from '../../lib/errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const USER_ID = 'user-123';

/** A complete `users` row as the driver would return it. */
const STORED_ROW: User = {
  id: USER_ID,
  email: 'alice@example.com',
  password_hash: 'salt:hash',
  name: 'Alice',
  role: 'investor',
  kyc_risk_tier: 'standard',
  last_oidc_groups: ['investors'],
  created_at: new Date('2024-01-01T00:00:00.000Z'),
  updated_at: new Date('2024-01-02T00:00:00.000Z'),
};

const CREATE_INPUT = {
  email: 'bob@example.com',
  password_hash: 'bob:salt:hash',
  name: 'Bob',
  role: 'startup' as const,
  kyc_risk_tier: 'elevated' as const,
};

/**
 * Builds a `pg.QueryResult` with an explicit `rowCount`.
 *
 * `rowCount` is deliberately decoupled from `rows.length` so tests can model a
 * driver/proxy that reports a stale or optimistic count while returning no rows.
 */
function makeResult<T extends QueryResultRow>(
  rows: T[],
  rowCount: number = rows.length,
  command = 'SELECT',
): QueryResult<T> {
  return { rows, rowCount, command, oid: 0, fields: [] };
}

/** Captures a rejection without letting an unexpected resolution pass silently. */
async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the repository call to reject, but it resolved');
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('UserRepository failure-handling regressions (#1027)', () => {
  let repository: UserRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    repository = new UserRepository(mockPool as unknown as Pool);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ══ line 129: createUser — empty RETURNING set ═══════════════════════════

  describe('createUser — `Failed to create user` guard (line 129)', () => {
    it('rejects with a plain Error carrying the exact pinned message', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([]));

      const error = await captureError(repository.createUser(CREATE_INPUT));

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('Error');
      expect(error.message).toBe('Failed to create user');
    });

    it('does not surface a UniqueConstraintError for an empty result', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([]));

      await expect(repository.createUser(CREATE_INPUT)).rejects.not.toBeInstanceOf(
        UniqueConstraintError,
      );
    });

    it('keys the guard on rows.length even when the driver reports rowCount: 1', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([], 1, 'INSERT'));

      await expect(repository.createUser(CREATE_INPUT)).rejects.toThrow(
        'Failed to create user',
      );
    });

    it('never resolves with a fabricated or partial user', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([]));

      let resolved: User | undefined;
      try {
        resolved = await repository.createUser(CREATE_INPUT);
      } catch {
        // Expected: the empty RETURNING set must fail loudly.
      }

      expect(resolved).toBeUndefined();
    });

    it('fails with a TypeError rather than fabricating a user when the driver returns rows: [null]', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([null] as unknown as User[]));

      await expect(repository.createUser(CREATE_INPUT)).rejects.toBeInstanceOf(TypeError);
    });

    it('is deterministic across repeated calls', async () => {
      const outcomes: string[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        mockPool.query.mockResolvedValueOnce(makeResult([]));
        outcomes.push(
          await repository
            .createUser(CREATE_INPUT)
            .then(() => 'resolved', (error: Error) => error.message),
        );
      }

      expect(outcomes).toEqual([
        'Failed to create user',
        'Failed to create user',
        'Failed to create user',
      ]);
    });

    it('leaks no SQL text, email address or password hash in the error message', async () => {
      const email = 'secret@example.com';
      const passwordHash = 'super:secret:hash';
      mockPool.query.mockResolvedValueOnce(makeResult([]));

      const error = await captureError(
        repository.createUser({ email, password_hash: passwordHash }),
      );

      expect(error.message).toBe('Failed to create user');
      expect(error.message).not.toContain('INSERT');
      expect(error.message).not.toContain('users');
      expect(error.message).not.toContain(email);
      expect(error.message).not.toContain(passwordHash);
    });
  });

  // ── Neighbouring success path and boundaries (createUser) ────────────────

  describe('createUser — success path and boundaries', () => {
    it('returns the fully mapped user when the INSERT returns a row', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([STORED_ROW], 1, 'INSERT'));

      const result = await repository.createUser(CREATE_INPUT);

      expect(result).toEqual(STORED_ROW);
      expect(result.password_hash).toBe('salt:hash');
    });

    it('binds exactly five parameters in positional order', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([STORED_ROW], 1, 'INSERT'));

      await repository.createUser(CREATE_INPUT);

      const [query, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('INSERT INTO users');
      expect(params).toEqual([
        'bob@example.com',
        'bob:salt:hash',
        'Bob',
        'startup',
        'elevated',
      ]);
    });

    it('defaults role to startup, tier to standard and name to NULL', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([STORED_ROW], 1, 'INSERT'));

      await repository.createUser({ email: 'x@y.com', password_hash: 'h' });

      const params = mockPool.query.mock.calls[0][1] as unknown[];
      expect(params).toEqual(['x@y.com', 'h', null, 'startup', 'standard']);
    });

    it('forwards boundary empty-string credentials as bound parameters', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([STORED_ROW], 1, 'INSERT'));

      await repository.createUser({ email: '', password_hash: '' });

      const params = mockPool.query.mock.calls[0][1] as unknown[];
      // No validation happens at the repository layer; callers own normalisation.
      expect(params[0]).toBe('');
      expect(params[1]).toBe('');
    });

    it('binds a hostile email payload instead of interpolating it into SQL', async () => {
      const payload = "x@y.com'); DROP TABLE users; --";
      mockPool.query.mockResolvedValueOnce(makeResult([STORED_ROW], 1, 'INSERT'));

      await repository.createUser({ email: payload, password_hash: 'h' });

      const [query, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[0]).toBe(payload);
      expect(query).not.toContain(payload);
      expect(query).not.toContain('DROP TABLE');
    });

    it('coerces an unknown stored KYC tier to standard', async () => {
      const row = { ...STORED_ROW, kyc_risk_tier: 'ultra' };
      mockPool.query.mockResolvedValueOnce(makeResult([row], 1, 'INSERT'));

      const result = await repository.createUser(CREATE_INPUT);

      expect(result.kyc_risk_tier).toBe('standard');
    });

    it('maps a stored NULL name to undefined and absent groups to null', async () => {
      const row = { ...STORED_ROW, name: null, last_oidc_groups: undefined };
      mockPool.query.mockResolvedValueOnce(
        makeResult([row as unknown as User], 1, 'INSERT'),
      );

      const result = await repository.createUser(CREATE_INPUT);

      expect(result.name).toBeUndefined();
      expect(result.last_oidc_groups).toBeNull();
    });
  });

  // ══ line 182: updateUser — no fields + missing user ══════════════════════

  describe('updateUser — `User not found` guard (line 182)', () => {
    it('rejects with a plain Error carrying the exact pinned message', async () => {
      // No updatable field is supplied, so the method takes the read-only path
      // and findById returns null.
      mockPool.query.mockResolvedValueOnce(makeResult([]));

      const error = await captureError(repository.updateUser({ id: 'ghost' }));

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('Error');
      expect(error.message).toBe('User not found');
    });

    it('does not surface a UniqueConstraintError for an absent user', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([]));

      await expect(repository.updateUser({ id: 'ghost' })).rejects.not.toBeInstanceOf(
        UniqueConstraintError,
      );
    });

    it('issues exactly one SELECT and never an UPDATE', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([]));

      await expect(repository.updateUser({ id: USER_ID })).rejects.toThrow(
        'User not found',
      );

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [query, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('SELECT');
      expect(query).not.toContain('UPDATE');
      expect(params).toEqual([USER_ID]);
    });

    it('treats explicitly-undefined optional fields as "not provided"', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([]));

      await expect(
        repository.updateUser({
          id: USER_ID,
          email: undefined,
          name: undefined,
          password_hash: undefined,
          role: undefined,
          kyc_risk_tier: undefined,
          last_oidc_groups: undefined,
        }),
      ).rejects.toThrow('User not found');

      // Only the no-op read ran; an explicitly undefined field must not trigger
      // an UPDATE with a useless or NULL assignment.
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query.mock.calls[0][0]).toContain('SELECT');
    });

    it('treats an empty-string id as an ordinary lookup miss', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([]));

      await expect(repository.updateUser({ id: '' })).rejects.toThrow('User not found');

      expect(mockPool.query.mock.calls[0][1]).toEqual(['']);
    });

    it('is deterministic across repeated calls', async () => {
      const outcomes: string[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        mockPool.query.mockResolvedValueOnce(makeResult([]));
        outcomes.push(
          await repository
            .updateUser({ id: 'ghost' })
            .then(() => 'resolved', (error: Error) => error.message),
        );
      }

      expect(outcomes).toEqual(['User not found', 'User not found', 'User not found']);
    });

    it('never resolves with a user when the lookup misses', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([]));

      let resolved: User | undefined;
      try {
        resolved = await repository.updateUser({ id: 'ghost' });
      } catch {
        // Expected.
      }

      expect(resolved).toBeUndefined();
    });

    it('returns the existing user without a DB write when no fields are provided', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([STORED_ROW]));

      const result = await repository.updateUser({ id: USER_ID });

      expect(result).toEqual(STORED_ROW);
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query.mock.calls[0][0]).toContain('SELECT');
    });

    it('returns the mapped existing user on the no-op path', async () => {
      const row = { ...STORED_ROW, name: null, kyc_risk_tier: 'unsupported' };
      mockPool.query.mockResolvedValueOnce(makeResult([row as unknown as User]));

      const result = await repository.updateUser({ id: USER_ID });

      expect(result.name).toBeUndefined();
      expect(result.kyc_risk_tier).toBe('standard');
      // Missing last_oidc_groups is normalised to null, never undefined.
      const rowWithoutGroups = { ...row } as Partial<User>;
      delete rowWithoutGroups.last_oidc_groups;
      mockPool.query.mockResolvedValueOnce(
        makeResult([rowWithoutGroups as unknown as User]),
      );
      const second = await repository.updateUser({ id: USER_ID });
      expect(second.last_oidc_groups).toBeNull();
    });
  });

  // ══ line 201: updateUser — empty RETURNING set ═══════════════════════════

  describe('updateUser — `Failed to update user` guard (line 201)', () => {
    it('rejects with a plain Error carrying the exact pinned message', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([], 0, 'UPDATE'));

      const error = await captureError(
        repository.updateUser({ id: USER_ID, email: 'new@example.com' }),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('Error');
      expect(error.message).toBe('Failed to update user');
    });

    it('does not surface a UniqueConstraintError for an empty result', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([], 0, 'UPDATE'));

      await expect(
        repository.updateUser({ id: USER_ID, email: 'new@example.com' }),
      ).rejects.not.toBeInstanceOf(UniqueConstraintError);
    });

    it('keys the guard on rows.length even when the driver reports rowCount: 1', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([], 1, 'UPDATE'));

      await expect(
        repository.updateUser({ id: USER_ID, email: 'new@example.com' }),
      ).rejects.toThrow('Failed to update user');
    });

    it('never resolves with a fabricated or partial user', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([], 0, 'UPDATE'));

      let resolved: User | undefined;
      try {
        resolved = await repository.updateUser({ id: USER_ID, name: 'Renamed' });
      } catch {
        // Expected.
      }

      expect(resolved).toBeUndefined();
    });

    it('issues exactly one UPDATE statement with the id bound last', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([], 0, 'UPDATE'));

      await expect(
        repository.updateUser({ id: USER_ID, email: 'new@example.com' }),
      ).rejects.toThrow('Failed to update user');

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [query, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('UPDATE users');
      expect(query).toContain('RETURNING *');
      expect(params).toEqual(['new@example.com', USER_ID]);
    });

    it('keeps a 23505 driver error mapped to UniqueConstraintError(field: email)', async () => {
      const uniqueViolation = Object.assign(new Error('duplicate key value'), {
        code: '23505',
      });
      mockPool.query.mockRejectedValueOnce(uniqueViolation);

      const error = await captureError(
        repository.updateUser({ id: USER_ID, email: 'taken@example.com' }),
      );

      expect(error).toBeInstanceOf(UniqueConstraintError);
      expect(error).toMatchObject({ field: 'email' });
      expect(error.message).toBe('Unique constraint violation on email');
    });

    it('re-throws non-23505 driver errors by identity', async () => {
      const driverError = Object.assign(new Error('connection reset'), {
        code: 'ECONNRESET',
      });
      mockPool.query.mockRejectedValueOnce(driverError);

      await expect(
        repository.updateUser({ id: USER_ID, email: 'new@example.com' }),
      ).rejects.toBe(driverError);
    });

    it('leaks no SQL text, email address or password hash in the error message', async () => {
      const email = 'secret@example.com';
      const passwordHash = 'super:secret:hash';
      mockPool.query.mockResolvedValueOnce(makeResult([], 0, 'UPDATE'));

      const error = await captureError(
        repository.updateUser({ id: USER_ID, email, password_hash: passwordHash }),
      );

      expect(error.message).toBe('Failed to update user');
      expect(error.message).not.toContain('UPDATE');
      expect(error.message).not.toContain(email);
      expect(error.message).not.toContain(passwordHash);
    });

    it('is deterministic across repeated calls', async () => {
      const outcomes: string[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        mockPool.query.mockResolvedValueOnce(makeResult([], 0, 'UPDATE'));
        outcomes.push(
          await repository
            .updateUser({ id: USER_ID, email: 'new@example.com' })
            .then(() => 'resolved', (error: Error) => error.message),
        );
      }

      expect(outcomes).toEqual([
        'Failed to update user',
        'Failed to update user',
        'Failed to update user',
      ]);
    });
  });

  // ── Neighbouring success path and boundaries (updateUser) ────────────────

  describe('updateUser — success path and boundaries', () => {
    it('binds every supported field in declaration order with the id last', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([STORED_ROW], 1, 'UPDATE'));

      await repository.updateUser({
        id: USER_ID,
        email: 'new@example.com',
        name: 'Alice Updated',
        password_hash: 'new:salt:hash',
        role: 'startup',
        kyc_risk_tier: 'high',
        last_oidc_groups: ['ops', 'investors'],
      });

      const [query, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([
        'new@example.com',
        'Alice Updated',
        'new:salt:hash',
        'startup',
        'high',
        '["ops","investors"]',
        USER_ID,
      ]);
      expect(query).toContain('email = $1');
      expect(query).toContain('name = $2');
      expect(query).toContain('password_hash = $3');
      expect(query).toContain('role = $4');
      expect(query).toContain('kyc_risk_tier = $5');
      expect(query).toContain('last_oidc_groups = $6');
      expect(query).toContain('updated_at = NOW()');
      expect(query).toContain('WHERE id = $7');
    });

    it('treats last_oidc_groups: null as a provided value that clears the column', async () => {
      mockPool.query.mockResolvedValueOnce(
        makeResult([{ ...STORED_ROW, last_oidc_groups: null }], 1, 'UPDATE'),
      );

      const result = await repository.updateUser({
        id: USER_ID,
        last_oidc_groups: null,
      });

      const [query, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('last_oidc_groups = $1');
      expect(query).toContain('UPDATE users');
      expect(params).toEqual([null, USER_ID]);
      expect(result.last_oidc_groups).toBeNull();
    });

    it('serialises an empty group list to "[]" instead of treating it as absent', async () => {
      mockPool.query.mockResolvedValueOnce(
        makeResult([{ ...STORED_ROW, last_oidc_groups: [] }], 1, 'UPDATE'),
      );

      await repository.updateUser({ id: USER_ID, last_oidc_groups: [] });

      const params = mockPool.query.mock.calls[0][1] as unknown[];
      expect(params).toEqual(['[]', USER_ID]);
    });

    it('treats an empty-string email as provided (validation belongs to callers)', async () => {
      mockPool.query.mockResolvedValueOnce(
        makeResult([{ ...STORED_ROW, email: '' }], 1, 'UPDATE'),
      );

      await repository.updateUser({ id: USER_ID, email: '' });

      const params = mockPool.query.mock.calls[0][1] as unknown[];
      expect(params).toEqual(['', USER_ID]);
    });

    it('binds a hostile email payload instead of interpolating it into SQL', async () => {
      const payload = "new@example.com'); DROP TABLE users; --";
      mockPool.query.mockResolvedValueOnce(makeResult([STORED_ROW], 1, 'UPDATE'));

      await repository.updateUser({ id: USER_ID, email: payload });

      const [query, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(params[0]).toBe(payload);
      expect(query).not.toContain(payload);
      expect(query).not.toContain('DROP TABLE');
    });

    it('returns the fully mapped updated user', async () => {
      const row = {
        ...STORED_ROW,
        name: null,
        kyc_risk_tier: 'unsupported',
        last_oidc_groups: null,
      };
      mockPool.query.mockResolvedValueOnce(
        makeResult([row as unknown as User], 1, 'UPDATE'),
      );

      const result = await repository.updateUser({ id: USER_ID, name: 'ignored' });

      expect(result.name).toBeUndefined();
      expect(result.kyc_risk_tier).toBe('standard');
      expect(result.last_oidc_groups).toBeNull();
    });
  });

  // ── Caller-facing delegation (updateKycRiskTier) ─────────────────────────

  describe('updateKycRiskTier — delegation to the pinned update contract', () => {
    it('delegates to updateUser and binds the requested tier', async () => {
      mockPool.query.mockResolvedValueOnce(
        makeResult([{ ...STORED_ROW, kyc_risk_tier: 'high' }], 1, 'UPDATE'),
      );

      const result = await repository.updateKycRiskTier(USER_ID, 'high');

      const [query, params] = mockPool.query.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('kyc_risk_tier = $1');
      expect(query).toContain('WHERE id = $2');
      expect(params).toEqual(['high', USER_ID]);
      expect(result.kyc_risk_tier).toBe('high');
    });

    it('propagates `Failed to update user` when the UPDATE matches no row', async () => {
      mockPool.query.mockResolvedValueOnce(makeResult([], 0, 'UPDATE'));

      await expect(repository.updateKycRiskTier('ghost', 'high')).rejects.toThrow(
        'Failed to update user',
      );
    });

    it('propagates UniqueConstraintError for a 23505 driver failure', async () => {
      mockPool.query.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value'), { code: '23505' }),
      );

      await expect(
        repository.updateKycRiskTier(USER_ID, 'elevated'),
      ).rejects.toBeInstanceOf(UniqueConstraintError);
    });
  });
});






