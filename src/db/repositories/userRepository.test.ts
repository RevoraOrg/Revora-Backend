/**
 * @file src/db/repositories/userRepository.test.ts
 * @description
 * Comprehensive test suite for UserRepository.
 *
 * Test strategy:
 *  - All DB interactions use a mocked `pg.Pool`; no real database is required.
 *  - Each `describe` block corresponds to one public method.
 *  - Every branch in `handlePgError` and every early-return path is covered.
 *  - The `mapUser` private method is exercised indirectly through every read
 *    method, including the `name: null` → `undefined` coercion.
 *
 * Security invariants verified:
 *  - `UniqueConstraintError` is thrown (not a raw pg error) when `createUser`
 *    or `updateUser` encounters pg error code `23505`.
 *  - `password_hash` is present in returned `User` objects (internal use only);
 *    callers are responsible for stripping it from API responses.
 *  - Raw pg errors that are NOT `23505` are re-thrown unchanged.
 */

import { Pool, QueryResult, QueryResultRow } from 'pg';
import { UserRepository, User, CreateUserInput, UpdateUserInput } from './userRepository';
import { UniqueConstraintError } from '../../lib/errors';

// ─── Shared fixture ───────────────────────────────────────────────────────────

const BASE_USER: User = {
  id: 'user-123',
  email: 'alice@example.com',
  password_hash: 'salt:hash',
  name: 'Alice',
  role: 'investor',
  kyc_risk_tier: 'standard',
  created_at: new Date('2024-01-01'),
  updated_at: new Date('2024-01-01'),
};

function makeQueryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('UserRepository', () => {
  let repository: UserRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    repository = new UserRepository(mockPool as unknown as Pool);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── findById ─────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns the user when found', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      const result = await repository.findById('user-123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        ['user-123'],
      );
      expect(result).not.toBeNull();
      expect(result!.id).toBe('user-123');
      expect(result!.password_hash).toBe('salt:hash');
    });

    it('returns null when user is not found', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      expect(await repository.findById('ghost')).toBeNull();
    });

    it('maps name: null from DB to undefined in the result', async () => {
      const rowWithNullName = { ...BASE_USER, name: null };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([rowWithNullName]));

      const result = await repository.findById('user-123');
      expect(result!.name).toBeUndefined();
    });

    it('maps name: defined string from DB correctly', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      const result = await repository.findById('user-123');
      expect(result!.name).toBe('Alice');
    });
  });

  // ── findUserById (alias) ──────────────────────────────────────────────────

  describe('findUserById', () => {
    it('delegates to findById and returns the same result', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      const result = await repository.findUserById('user-123');
      expect(result!.id).toBe('user-123');
    });

    it('returns null when the user is not found', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));
      expect(await repository.findUserById('ghost')).toBeNull();
    });
  });

  // ── findByEmail ───────────────────────────────────────────────────────────

  describe('findByEmail', () => {
    it('returns the user when found by email', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      const result = await repository.findByEmail('alice@example.com');
      expect(result!.email).toBe('alice@example.com');
    });

    it('returns null when email is not found', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      expect(await repository.findByEmail('nobody@example.com')).toBeNull();
    });

    it('passes the email as a query parameter', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      await repository.findByEmail('alice@example.com');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE email'),
        ['alice@example.com'],
      );
    });
  });

  // ── findUserByEmail (alias) ───────────────────────────────────────────────

  describe('findUserByEmail', () => {
    it('delegates to findByEmail and returns the same result', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      const result = await repository.findUserByEmail('alice@example.com');
      expect(result!.email).toBe('alice@example.com');
    });

    it('returns null when not found', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));
      expect(await repository.findUserByEmail('x@y.com')).toBeNull();
    });
  });

  // ── createUser ────────────────────────────────────────────────────────────

  describe('createUser', () => {
    const INPUT: CreateUserInput = {
      email: 'bob@example.com',
      password_hash: 's:h',
      name: 'Bob',
      role: 'startup',
    };

    it('inserts and returns the new user', async () => {
      const created: User = { ...BASE_USER, email: 'bob@example.com' };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([created]));

      const result = await repository.createUser(INPUT);

      expect(result.email).toBe('bob@example.com');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO users'),
        expect.arrayContaining(['bob@example.com', 's:h', 'Bob', 'startup', 'standard']),
      );
    });

    it('defaults role to "startup" when not provided', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      await repository.createUser({ email: 'x@y.com', password_hash: 'h' });

      const params = mockPool.query.mock.calls[0][1] as any[];
      expect(params[3]).toBe('startup'); // 4th positional param is role
      expect(params[4]).toBe('standard'); // 5th is kyc_risk_tier default
    });

    it('passes null for name when not provided', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      await repository.createUser({ email: 'x@y.com', password_hash: 'h' });

      const params = mockPool.query.mock.calls[0][1] as any[];
      expect(params[2]).toBeNull(); // 3rd positional param is name
    });

    it('throws UniqueConstraintError when pg returns error code 23505', async () => {
      const pgUniqueError = Object.assign(new Error('unique constraint'), { code: '23505' });
      mockPool.query.mockRejectedValueOnce(pgUniqueError);

      await expect(repository.createUser(INPUT)).rejects.toBeInstanceOf(UniqueConstraintError);
    });

    it('throws UniqueConstraintError with field "email"', async () => {
      const pgUniqueError = Object.assign(new Error('unique constraint'), { code: '23505' });
      mockPool.query.mockRejectedValueOnce(pgUniqueError);

      await expect(repository.createUser(INPUT)).rejects.toMatchObject({ field: 'email' });
    });

    it('re-throws non-unique pg errors unchanged', async () => {
      const pgConnectionError = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      mockPool.query.mockRejectedValueOnce(pgConnectionError);

      await expect(repository.createUser(INPUT)).rejects.toThrow('connection refused');
    });

    it('throws "Failed to create user" when DB returns empty rows', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(repository.createUser(INPUT)).rejects.toThrow('Failed to create user');
    });
  });

  // ── updateUser ────────────────────────────────────────────────────────────

  describe('updateUser', () => {
    const UPDATED_USER: User = { ...BASE_USER, email: 'newemail@example.com' };

    it('updates email and returns the updated user', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([UPDATED_USER]));

      const result = await repository.updateUser({ id: 'user-123', email: 'newemail@example.com' });

      expect(result.email).toBe('newemail@example.com');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users'),
        expect.arrayContaining(['newemail@example.com', 'user-123']),
      );
    });

    it('updates password_hash only', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([{ ...BASE_USER, password_hash: 'new:hash' }]));

      const result = await repository.updateUser({ id: 'user-123', password_hash: 'new:hash' });

      expect(result.password_hash).toBe('new:hash');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('password_hash'),
        expect.arrayContaining(['new:hash', 'user-123']),
      );
    });

    it('updates role only', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([{ ...BASE_USER, role: 'startup' }]));

      const result = await repository.updateUser({ id: 'user-123', role: 'startup' });

      expect(result.role).toBe('startup');
    });

    it('updates all three fields at once', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([UPDATED_USER]));

      await repository.updateUser({
        id: 'user-123',
        email: 'a@b.com',
        password_hash: 'p:h',
        role: 'investor',
      });

      const query = mockPool.query.mock.calls[0][0] as string;
      expect(query).toContain('email');
      expect(query).toContain('password_hash');
      expect(query).toContain('role');
    });

    it('returns existing record without a DB write when no fields are provided', async () => {
      // First query: findById (the no-op path)
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_USER]));

      const result = await repository.updateUser({ id: 'user-123' });

      expect(result.id).toBe('user-123');
      // Only one DB call (the findById); no UPDATE issued
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT'),
        ['user-123'],
      );
    });

    it('throws "User not found" when no fields given and user does not exist', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([])); // findById returns null

      await expect(repository.updateUser({ id: 'ghost' })).rejects.toThrow('User not found');
    });

    it('throws UniqueConstraintError on email uniqueness violation (23505)', async () => {
      const pgUniqueError = Object.assign(new Error('unique'), { code: '23505' });
      mockPool.query.mockRejectedValueOnce(pgUniqueError);

      await expect(
        repository.updateUser({ id: 'user-123', email: 'taken@example.com' }),
      ).rejects.toBeInstanceOf(UniqueConstraintError);
    });

    it('re-throws non-unique pg errors from updateUser', async () => {
      const pgError = Object.assign(new Error('disk full'), { code: '53100' });
      mockPool.query.mockRejectedValueOnce(pgError);

      await expect(
        repository.updateUser({ id: 'user-123', email: 'x@y.com' }),
      ).rejects.toThrow('disk full');
    });

    it('throws "Failed to update user" when DB returns empty rows', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(
        repository.updateUser({ id: 'user-123', email: 'x@y.com' }),
      ).rejects.toThrow('Failed to update user');
    });
  });

  // ── updatePasswordHash ────────────────────────────────────────────────────

  describe('updatePasswordHash', () => {
    it('runs the UPDATE query with correct arguments', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] });

      await repository.updatePasswordHash('user-123', 'newsalt:newhash');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE users'),
        ['newsalt:newhash', 'user-123'],
      );
    });

    it('resolves without error even when rowCount is 0 (user not found is a no-op)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] });

      await expect(repository.updatePasswordHash('ghost', 'h')).resolves.toBeUndefined();
    });
  });
});
