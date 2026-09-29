/**
 * @file src/auth/login/sessionRepositoryAdapter.test.ts
 * @description Focused behavior coverage for `SessionRepositoryAdapter`.
 *
 * Contract under test (see `src/auth/login/sessionRepositoryAdapter.ts`):
 *  1. The adapter is a pure pass-through: it maps the login module's
 *     camelCase `SessionRepository.createSession` input onto the DB
 *     repository's snake_case `CreateSessionInput`.
 *  2. It resolves to `void` — the persisted `Session` row returned by the DB
 *     layer is intentionally discarded so callers cannot couple to row shape.
 *  3. Errors from the DB layer propagate unchanged (no swallowing, no
 *     re-wrapping), which keeps failure modes observable and deterministic.
 *  4. The adapter performs no validation/normalization of its own: that
 *     responsibility stays with the DB repository (and ultimately the
 *     database constraints), so a fuzz/abuse payload is forwarded verbatim.
 *
 * All DB access is mocked — these tests never touch Postgres.
 */

import { SessionRepository as DBSessionRepository } from '../../db/repositories/sessionRepository';
import { SessionRepository } from './types';
import { SessionRepositoryAdapter } from './sessionRepositoryAdapter';

type MockDbRepo = jest.Mocked<Pick<DBSessionRepository, 'createSession'>>;

const VALID_INPUT = {
  id: 'session-1',
  userId: 'user-1',
  tokenHash: 'sha256-token-hash',
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
};

describe('SessionRepositoryAdapter', () => {
  let dbRepo: MockDbRepo;
  let adapter: SessionRepositoryAdapter;

  beforeEach(() => {
    dbRepo = {
      createSession: jest.fn().mockResolvedValue({
        id: VALID_INPUT.id,
        user_id: VALID_INPUT.userId,
        token_hash: VALID_INPUT.tokenHash,
        expires_at: VALID_INPUT.expiresAt,
        created_at: new Date(),
      }),
    };
    adapter = new SessionRepositoryAdapter(dbRepo as unknown as DBSessionRepository);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Interface conformance ───────────────────────────────────────────────

  it('satisfies the login module SessionRepository interface', () => {
    // Compile-time assertion: the adapter must remain substitutable wherever
    // the login module expects a `SessionRepository`.
    const asInterface: SessionRepository = new SessionRepositoryAdapter(
      dbRepo as unknown as DBSessionRepository,
    );
    expect(typeof asInterface.createSession).toBe('function');
  });

  // ── Happy path / mapping ────────────────────────────────────────────────

  it('maps camelCase input onto the DB repository snake_case contract', async () => {
    await adapter.createSession(VALID_INPUT);

    expect(dbRepo.createSession).toHaveBeenCalledTimes(1);
    expect(dbRepo.createSession).toHaveBeenCalledWith({
      id: 'session-1',
      user_id: 'user-1',
      token_hash: 'sha256-token-hash',
      expires_at: VALID_INPUT.expiresAt,
    });
  });

  it('passes exactly the four documented fields (no extra keys leak through)', async () => {
    await adapter.createSession({
      ...VALID_INPUT,
      // An unknown property must not be forwarded to the DB layer.
      extra: 'should-not-be-forwarded',
    } as never);

    const forwarded = dbRepo.createSession.mock.calls[0][0];
    expect(Object.keys(forwarded).sort()).toEqual([
      'expires_at',
      'id',
      'token_hash',
      'user_id',
    ]);
  });

  it('preserves the exact Date instance supplied by the caller', async () => {
    const expiresAt = new Date('2031-06-15T12:34:56.789Z');

    await adapter.createSession({ ...VALID_INPUT, expiresAt });

    expect(dbRepo.createSession.mock.calls[0][0].expires_at).toBe(expiresAt);
  });

  it('resolves to undefined and discards the persisted row', async () => {
    const result = await adapter.createSession(VALID_INPUT);

    expect(result).toBeUndefined();
  });

  it('awaits the DB write before resolving', async () => {
    let settled = false;
    dbRepo.createSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            settled = true;
            resolve({} as never);
          }, 5);
        }),
    );

    await adapter.createSession(VALID_INPUT);

    expect(settled).toBe(true);
  });

  // ── Failure paths ───────────────────────────────────────────────────────

  it('propagates DB failures unchanged', async () => {
    const dbError = new Error('duplicate key value violates unique constraint');
    dbRepo.createSession.mockRejectedValue(dbError);

    await expect(adapter.createSession(VALID_INPUT)).rejects.toBe(dbError);
  });

  it('rejects (rather than resolving) when the DB write fails', async () => {
    dbRepo.createSession.mockRejectedValue(new Error('connection terminated'));

    await expect(adapter.createSession(VALID_INPUT)).rejects.toThrow(
      'connection terminated',
    );
  });

  it('isolates each call — a failure does not poison the next write', async () => {
    dbRepo.createSession
      .mockRejectedValueOnce(new Error('transient outage'))
      .mockResolvedValueOnce({} as never);

    await expect(adapter.createSession(VALID_INPUT)).rejects.toThrow('transient outage');
    await expect(adapter.createSession(VALID_INPUT)).resolves.toBeUndefined();

    expect(dbRepo.createSession).toHaveBeenCalledTimes(2);
  });

  // ── Boundary / abuse inputs (forwarded verbatim by design) ──────────────

  it('forwards empty-string identifiers without local validation', async () => {
    await adapter.createSession({
      id: '',
      userId: '',
      tokenHash: '',
      expiresAt: new Date(0),
    });

    expect(dbRepo.createSession).toHaveBeenCalledWith({
      id: '',
      user_id: '',
      token_hash: '',
      expires_at: new Date(0),
    });
  });

  it('forwards a non-Date expiry unchanged so the DB layer rejects it', async () => {
    const bogus = 'not-a-date' as unknown as Date;

    await adapter.createSession({ ...VALID_INPUT, expiresAt: bogus });

    expect(dbRepo.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ expires_at: bogus }),
    );
  });

  it('handles concurrent calls independently', async () => {
    await Promise.all([
      adapter.createSession({ ...VALID_INPUT, id: 'session-a' }),
      adapter.createSession({ ...VALID_INPUT, id: 'session-b' }),
    ]);

    expect(dbRepo.createSession).toHaveBeenCalledTimes(2);
    const ids = dbRepo.createSession.mock.calls.map(([arg]) => arg.id).sort();
    expect(ids).toEqual(['session-a', 'session-b']);
  });
});
