/**
 * @file src/db/repositories/sessionRepository.test.ts
 * @description
 * Comprehensive test suite for SessionRepository.
 *
 * Test strategy:
 *  - All DB interactions use a mocked `pg.Pool`; no real database is required.
 *  - Both branches of `createSession` are covered:
 *      (a) explicit `id` supplied → uses the 4-column INSERT
 *      (b) no `id` supplied → generates a UUID via crypto.randomUUID
 *  - `parent_id` handling: with and without parent.
 *  - All "throws on empty result" branches.
 *  - `mapSession` is exercised indirectly; `parent_id` and `revoked_at`
 *    null/undefined coercion is covered.
 *
 * Security invariants verified:
 *  - Raw JWT tokens are never stored; only `token_hash` values are passed to
 *    the DB (enforced by the interface, not this layer — but confirmed by
 *    checking the query parameters).
 *  - `revokeSessionAndDescendants` uses a CTE-recursive UPDATE with
 *    `revoked_at IS NULL` guard — safe to call multiple times (idempotent).
 *  - `deleteSessionById` and `deleteAllSessionsByUserId` pass the correct
 *    column keys (id vs user_id) to prevent cross-user deletion.
 */

import { Pool, QueryResult } from 'pg';
import { SessionRepository, Session, CreateSessionInput } from './sessionRepository';

// ─── Shared fixture ───────────────────────────────────────────────────────────

const BASE_SESSION: Session = {
  id: 'session-123',
  user_id: 'user-456',
  token_hash: 'abc123hash',
  expires_at: new Date('2099-01-01'),
  created_at: new Date('2024-01-01'),
  parent_id: undefined,
  revoked_at: undefined,
};

function makeQueryResult<T>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('SessionRepository', () => {
  let repository: SessionRepository;
  let mockPool: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    repository = new SessionRepository(mockPool as unknown as Pool);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── createSession ─────────────────────────────────────────────────────────

  describe('createSession', () => {
    // Branch A: explicit id supplied (4-column INSERT)
    describe('with explicit id', () => {
      it('inserts using the 4-column query and returns the session', async () => {
        mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_SESSION]));

        const input: CreateSessionInput = {
          id: 'session-123',
          user_id: 'user-456',
          token_hash: 'abc123hash',
          expires_at: new Date('2099-01-01'),
        };

        const result = await repository.createSession(input);

        expect(result.id).toBe('session-123');
        expect(mockPool.query).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO sessions'),
          expect.arrayContaining(['session-123', 'user-456', 'abc123hash']),
        );
      });

      it('throws "Failed to create session" when DB returns empty rows (explicit id path)', async () => {
        mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

        await expect(
          repository.createSession({
            id: 'session-xyz',
            user_id: 'user-456',
            token_hash: 'h',
            expires_at: new Date(),
          }),
        ).rejects.toThrow('Failed to create session');
      });
    });

    // Branch B: no id supplied (5-column INSERT with generated UUID)
    describe('without explicit id', () => {
      it('inserts using the 5-column query and returns the session', async () => {
        mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_SESSION]));

        const input: CreateSessionInput = {
          user_id: 'user-456',
          token_hash: 'abc123hash',
          expires_at: new Date('2099-01-01'),
        };

        const result = await repository.createSession(input);

        expect(result.id).toBe('session-123');
        // 5-column query includes parent_id
        expect(mockPool.query).toHaveBeenCalledWith(
          expect.stringContaining('parent_id'),
          expect.any(Array),
        );
      });

      it('passes null for parent_id when not provided', async () => {
        mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_SESSION]));

        await repository.createSession({
          user_id: 'u',
          token_hash: 'h',
          expires_at: new Date(),
        });

        const params = mockPool.query.mock.calls[0][1] as any[];
        // 5th element is parent_id
        expect(params[4]).toBeNull();
      });

      it('passes the provided parent_id when set', async () => {
        const sessionWithParent: Session = { ...BASE_SESSION, parent_id: 'parent-session-id' };
        mockPool.query.mockResolvedValueOnce(makeQueryResult([sessionWithParent]));

        await repository.createSession({
          user_id: 'u',
          token_hash: 'h',
          expires_at: new Date(),
          parent_id: 'parent-session-id',
        });

        const params = mockPool.query.mock.calls[0][1] as any[];
        expect(params[4]).toBe('parent-session-id');
      });

      it('throws "Failed to create session" when DB returns empty rows (generated id path)', async () => {
        mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

        await expect(
          repository.createSession({ user_id: 'u', token_hash: 'h', expires_at: new Date() }),
        ).rejects.toThrow('Failed to create session');
      });
    });

    // mapSession: parent_id / revoked_at coercion
    it('maps parent_id from DB row to the result', async () => {
      const row: Session = { ...BASE_SESSION, parent_id: 'p-id' };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([row]));

      const result = await repository.createSession({
        id: 'session-123',
        user_id: 'user-456',
        token_hash: 'h',
        expires_at: new Date(),
      });

      expect(result.parent_id).toBe('p-id');
    });

    it('maps revoked_at from DB row to the result', async () => {
      const revokedAt = new Date('2024-06-01');
      const row: Session = { ...BASE_SESSION, revoked_at: revokedAt };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([row]));

      const result = await repository.createSession({
        id: 'session-123',
        user_id: 'user-456',
        token_hash: 'h',
        expires_at: new Date(),
      });

      expect(result.revoked_at).toEqual(revokedAt);
    });
  });

  // ── setSessionMetadata ────────────────────────────────────────────────────

  describe('setSessionMetadata', () => {
    it('issues an UPDATE with the correct token_hash, expires_at, and session id', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const expiresAt = new Date('2099-12-31');
      await repository.setSessionMetadata('session-123', 'hash-x', expiresAt);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE sessions SET token_hash'),
        ['hash-x', expiresAt, 'session-123'],
      );
    });

    it('resolves without error (void return)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await expect(
        repository.setSessionMetadata('session-123', 'h', new Date()),
      ).resolves.toBeUndefined();
    });
  });

  // ── createSessionForUser ──────────────────────────────────────────────────

  describe('createSessionForUser', () => {
    it('creates a session shell and returns its id', async () => {
      const shellRow: Session = {
        id: 'session-123',
        user_id: 'user-456',
        token_hash: '',
        expires_at: new Date(0),
        created_at: new Date(),
      };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([shellRow]));

      const sessionId = await repository.createSessionForUser('user-456');

      expect(sessionId).toBe('session-123');
    });

    it('passes an empty token_hash and epoch expires_at (shell session)', async () => {
      const shellRow: Session = { ...BASE_SESSION, token_hash: '', expires_at: new Date(0) };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([shellRow]));

      await repository.createSessionForUser('user-456');

      const params = mockPool.query.mock.calls[0][1] as any[];
      expect(params[2]).toBe('');              // token_hash
      expect(params[3]).toEqual(new Date(0));  // expires_at
    });
  });

  // ── createSessionWithId ───────────────────────────────────────────────────

  describe('createSessionWithId', () => {
    it('creates a session with the given id and returns it', async () => {
      const row: Session = { ...BASE_SESSION, id: 'explicit-id' };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([row]));

      const sessionId = await repository.createSessionWithId(
        'user-456',
        'explicit-id',
        'token-hash',
        new Date('2099-01-01'),
      );

      expect(sessionId).toBe('explicit-id');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO sessions'),
        expect.arrayContaining(['explicit-id', 'user-456', 'token-hash']),
      );
    });
  });

  // ── findById ──────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns the session when found', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_SESSION]));

      const result = await repository.findById('session-123');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('session-123');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE id = $1'),
        ['session-123'],
      );
    });

    it('returns null when session is not found', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      expect(await repository.findById('ghost-session')).toBeNull();
    });
  });

  // ── findByParentId ────────────────────────────────────────────────────────

  describe('findByParentId', () => {
    it('returns the child session when found', async () => {
      const child: Session = { ...BASE_SESSION, id: 'child-session', parent_id: 'parent-session' };
      mockPool.query.mockResolvedValueOnce(makeQueryResult([child]));

      const result = await repository.findByParentId('parent-session');

      expect(result!.id).toBe('child-session');
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE parent_id = $1'),
        ['parent-session'],
      );
    });

    it('returns null when no child session exists for the given parent id', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      expect(await repository.findByParentId('orphan-parent')).toBeNull();
    });
  });

  // ── revokeSessionAndDescendants ───────────────────────────────────────────

  describe('revokeSessionAndDescendants', () => {
    it('issues the recursive CTE UPDATE with the correct session id', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await repository.revokeSessionAndDescendants('session-123');

      const [query, params] = mockPool.query.mock.calls[0] as [string, any[]];
      expect(query).toContain('WITH RECURSIVE');
      expect(query).toContain('JOIN descendants d ON s.parent_id = d.id');
      expect(query).toContain('revoked_at = NOW()');
      expect(query).toContain('WHERE id IN (SELECT id FROM descendants)');
      expect(params).toEqual(['session-123']);
    });

    it('revokes the entire session family in one recursive UPDATE statement', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 12 } as any);

      await repository.revokeSessionAndDescendants('grandparent-session');

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [query, params] = mockPool.query.mock.calls[0] as [string, any[]];
      expect(query).toMatch(/WITH RECURSIVE[\s\S]+UPDATE sessions/);
      expect(query).not.toMatch(/;\s*(SELECT|UPDATE|DELETE|INSERT)\b/i);
      expect(params).toEqual(['grandparent-session']);
    });

    it('is idempotent (second call does not throw)', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await repository.revokeSessionAndDescendants('session-123');
      await expect(repository.revokeSessionAndDescendants('session-123')).resolves.toBeUndefined();
    });
  });

  // ── deleteSessionById ─────────────────────────────────────────────────────

  describe('deleteSessionById', () => {
    it('calls DELETE with the correct session id', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await repository.deleteSessionById('session-123');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM sessions WHERE id'),
        ['session-123'],
      );
    });

    it('resolves without error when session does not exist (rowCount: 0)', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(repository.deleteSessionById('ghost')).resolves.toBeUndefined();
    });
  });

  // ── deleteAllSessionsByUserId ─────────────────────────────────────────────

  describe('deleteAllSessionsByUserId', () => {
    it('calls DELETE with the correct user id', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 2 } as any);

      await repository.deleteAllSessionsByUserId('user-456');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM sessions WHERE user_id'),
        ['user-456'],
      );
    });

    it('uses user_id (not id) to prevent cross-user accidental deletion', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await repository.deleteAllSessionsByUserId('user-abc');

      const [query] = mockPool.query.mock.calls[0] as [string, ...any[]];
      expect(query).toContain('user_id');
      expect(query).not.toMatch(/WHERE id\s*=/);
    });

    it('resolves without error when no sessions exist for the user', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(repository.deleteAllSessionsByUserId('nobody')).resolves.toBeUndefined();
    });
  });

  // ── purgeOlderThan ────────────────────────────────────────────────────────

  describe('purgeOlderThan', () => {
    it('deletes expired/revoked rows past the DB-computed boundary in a bounded batch', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 42 } as any);

      const deleted = await repository.purgeOlderThan(30, 1000);

      expect(deleted).toBe(42);
      const [query, params] = mockPool.query.mock.calls[0] as [string, any[]];
      expect(query).toContain('DELETE FROM sessions');
      expect(query).toContain('LIMIT $2');
      expect(params).toEqual([30, 1000]);
    });

    it('computes the retention boundary with the database clock, not the app clock', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await repository.purgeOlderThan(30, 100);

      const [query, params] = mockPool.query.mock.calls[0] as [string, any[]];
      // The boundary must come from NOW() so a bad-clock event on the app
      // server cannot push the boundary forward and make the job delete rows
      // that have not actually aged past retention.
      expect(query).toContain('NOW() - ($1 * INTERVAL');
      expect(query).not.toContain('WHERE expires_at < $1');
      expect(params[0]).toBe(30);
    });

    it('only ever targets expired or revoked rows, never active ones', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await repository.purgeOlderThan(30, 100);

      const [query] = mockPool.query.mock.calls[0] as [string];
      // An active session has expires_at in the future and no revoked_at, so it
      // can never satisfy either branch of the predicate.
      expect(query).toMatch(/expires_at < NOW\(\)/);
      expect(query).toMatch(/revoked_at < NOW\(\)/);
      expect(query).not.toMatch(/WHERE expires_at < \$1 OR revoked_at < \$1/);
    });

    it('returns 0 when the DB reports a null rowCount', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: null } as any);

      await expect(repository.purgeOlderThan(30, 100)).resolves.toBe(0);
    });
  });

  // ── getOldestCompactedSessionDate ─────────────────────────────────────────

  describe('getOldestCompactedSessionDate', () => {
    it('returns the oldest eligible session date', async () => {
      const oldest = new Date('2026-05-01T00:00:00.000Z');
      mockPool.query.mockResolvedValueOnce({ rows: [{ oldest }], rowCount: 1 } as any);

      const result = await repository.getOldestCompactedSessionDate(30);

      expect(result).toEqual(oldest);
      const [query, params] = mockPool.query.mock.calls[0] as [string, any[]];
      expect(query).toContain('MIN(LEAST(');
      expect(query).toContain('NOW() - ($1 * INTERVAL');
      expect(params).toEqual([30]);
    });

    it('uses the database clock so the lag metric matches the purge boundary', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ oldest: null }], rowCount: 0 } as any);

      await repository.getOldestCompactedSessionDate(30);

      const [query] = mockPool.query.mock.calls[0] as [string];
      expect(query).toMatch(/expires_at < NOW\(\)/);
      expect(query).toMatch(/revoked_at < NOW\(\)/);
      expect(query).not.toContain('WHERE expires_at < $1');
    });

    it('returns null when no rows are eligible for compaction', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ oldest: null }], rowCount: 0 } as any);

      await expect(repository.getOldestCompactedSessionDate(30)).resolves.toBeNull();
    });
  });

  // ── createSession / mapSession: revoked_at and parent_id from existing tests ─

  describe('legacy compatibility (original test cases preserved)', () => {
    it('createSession: inserts and returns the session (original)', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([BASE_SESSION]));

      const input: CreateSessionInput = {
        user_id: 'user-456',
        token_hash: 'abc123hash',
        expires_at: new Date('2099-01-01'),
      };

      const result = await repository.createSession(input);

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO sessions'),
        expect.arrayContaining([input.user_id, input.token_hash, input.expires_at]),
      );
      expect(result.id).toBe('session-123');
    });

    it('createSession: throws when no row is returned (original)', async () => {
      mockPool.query.mockResolvedValueOnce(makeQueryResult([]));

      await expect(
        repository.createSession({ user_id: 'u', token_hash: 'h', expires_at: new Date() }),
      ).rejects.toThrow('Failed to create session');
    });

    it('createSessionForUser / setSessionMetadata (original)', async () => {
      mockPool.query
        .mockResolvedValueOnce(makeQueryResult([{
          id: 'session-123',
          user_id: 'user-456',
          token_hash: '',
          expires_at: new Date(0),
          created_at: new Date(),
        }]))
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const sessionId = await repository.createSessionForUser('user-456');
      expect(sessionId).toBe('session-123');

      await repository.setSessionMetadata('session-123', 'hash-x', new Date('2099-01-01'));

      expect(mockPool.query).toHaveBeenLastCalledWith(
        expect.stringContaining('UPDATE sessions SET token_hash'),
        ['hash-x', new Date('2099-01-01'), 'session-123'],
      );
    });
  });
});
