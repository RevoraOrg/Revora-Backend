/**
 * @file src/auth/refresh/refreshService.test.ts
 * @description Focused refresh-token rotation, replay detection, and family
 * revocation coverage.
 *
 * Security invariants:
 * - A refresh token is valid for exactly one completed rotation.
 * - Replay of any consumed ancestor revokes that ancestor and every descendant
 *   in the same repository transaction callback.
 * - A same-process concurrent duplicate is deduplicated and must not revoke
 *   the valid child created by the winning caller.
 * - Logs must never include the raw refresh token value.
 */

import { Pool, PoolClient } from 'pg';
import { RefreshService } from './refreshService';
import { RefreshTokenPayload, RefreshTokenRepository, TokenService } from './types';
import { withTransaction } from '../../db/transaction';
import { Logger } from '../../lib/logger';

jest.mock('../../db/transaction');

const USER_ID = 'user-123';
const ROLE = 'investor';
const NOW_FUTURE = new Date('2099-01-01T00:00:00.000Z');
const NOW_PAST = new Date('2000-01-01T00:00:00.000Z');

type StoredSession = {
    id: string;
    user_id: string;
    token_hash: string;
    expires_at: Date;
    parent_id: string | null;
    revoked_at: Date | null;
    token_consumed_at: Date | null;
};

class InMemoryRefreshRepository implements RefreshTokenRepository {
    readonly sessions = new Map<string, StoredSession>();
    readonly revocations: string[] = [];

    addSession(input: {
        id: string;
        token: string;
        parent_id?: string | null;
        expires_at?: Date;
        token_consumed_at?: Date | null;
    }): void {
        this.sessions.set(input.id, {
            id: input.id,
            user_id: USER_ID,
            token_hash: `hash:${input.token}`,
            expires_at: input.expires_at ?? NOW_FUTURE,
            parent_id: input.parent_id ?? null,
            revoked_at: null,
            token_consumed_at: input.token_consumed_at ?? null,
        });
    }

    async findSessionById(sessionId: string): Promise<StoredSession | null> {
        return this.sessions.get(sessionId) ?? null;
    }

    async findSessionByIdForUpdate(sessionId: string): Promise<StoredSession | null> {
        return this.sessions.get(sessionId) ?? null;
    }

    async createSession(input: {
        id?: string;
        user_id: string;
        token_hash: string;
        expires_at: Date;
        parent_id: string;
    }): Promise<StoredSession> {
        if (!input.id) {
            throw new Error('test requires explicit session ids');
        }

        const session: StoredSession = {
            id: input.id,
            user_id: input.user_id,
            token_hash: input.token_hash,
            expires_at: input.expires_at,
            parent_id: input.parent_id,
            revoked_at: null,
            token_consumed_at: null,
        };
        this.sessions.set(input.id, session);
        return session;
    }

    async revokeSessionAndDescendants(sessionId: string): Promise<void> {
        this.revocations.push(sessionId);
        const stack = [sessionId];
        const revokedAt = new Date('2026-01-01T00:00:00.000Z');

        while (stack.length > 0) {
            const currentId = stack.pop()!;
            const current = this.sessions.get(currentId);
            if (current) {
                current.revoked_at = revokedAt;
            }

            for (const session of this.sessions.values()) {
                if (session.parent_id === currentId) {
                    stack.push(session.id);
                }
            }
        }
    }

    async findSessionByParentId(parentId: string): Promise<StoredSession | null> {
        return [...this.sessions.values()].find((session) => session.parent_id === parentId) ?? null;
    }

    async setSessionConsumed(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.token_consumed_at = new Date('2026-01-01T00:00:00.000Z');
        }
    }
}

class DeterministicTokenService implements TokenService {
    verifyRefreshToken(token: string): RefreshTokenPayload {
        if (!token.startsWith('refresh-')) {
            throw new Error('invalid token');
        }

        return {
            userId: USER_ID,
            sessionId: token.replace('refresh-', ''),
            role: ROLE,
        };
    }

    issueTokens(payload: RefreshTokenPayload): { accessToken: string; refreshToken: string } {
        return {
            accessToken: `access-${payload.sessionId}`,
            refreshToken: `refresh-${payload.sessionId}`,
        };
    }

    hashToken(token: string): string {
        return `hash:${token}`;
    }
}

const createMockRepo = (): jest.Mocked<RefreshTokenRepository> => ({
    findSessionById: jest.fn(),
    findSessionByIdForUpdate: jest.fn(),
    createSession: jest.fn(),
    revokeSessionAndDescendants: jest.fn().mockResolvedValue(undefined),
    setSessionConsumed: jest.fn().mockResolvedValue(undefined),
    findSessionByParentId: jest.fn(),
});

const createMockTokenService = (): jest.Mocked<TokenService> => ({
    verifyRefreshToken: jest.fn(),
    issueTokens: jest.fn(),
    hashToken: jest.fn(),
});

describe('RefreshService', () => {
    let mockWithTransaction: jest.MockedFunction<typeof withTransaction>;
    let mockDb: Pool;
    let mockClient: PoolClient;
    let logger: Logger;

    beforeEach(() => {
        mockDb = {} as Pool;
        mockClient = {} as PoolClient;
        logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;
        mockWithTransaction = withTransaction as jest.MockedFunction<typeof withTransaction>;
        mockWithTransaction.mockReset();
        mockWithTransaction.mockImplementation(async (_db, callback) => callback(mockClient));
    });

    it('rotates a valid token and marks the parent consumed before creating the child session', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-0', role: ROLE });
        tokenService.issueTokens.mockReturnValue({ accessToken: 'access-new', refreshToken: 'refresh-new' });
        tokenService.hashToken.mockReturnValueOnce('hash:refresh-session-0').mockReturnValueOnce('hash:refresh-new');
        repo.findSessionByIdForUpdate.mockResolvedValue({
            id: 'session-0',
            user_id: USER_ID,
            token_hash: 'hash:refresh-session-0',
            expires_at: NOW_FUTURE,
            revoked_at: null,
            token_consumed_at: null,
        });
        repo.findSessionByParentId.mockResolvedValue(null);
        repo.createSession.mockResolvedValue({ id: 'session-1' });

        const result = await service.refresh('refresh-session-0');

        expect(result).toEqual({ accessToken: 'access-new', refreshToken: 'refresh-new' });
        expect(repo.findSessionByIdForUpdate).toHaveBeenCalledWith('session-0', mockClient);
        expect(repo.setSessionConsumed).toHaveBeenCalledWith('session-0', mockClient);
        expect(repo.createSession).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: USER_ID,
                token_hash: 'hash:refresh-new',
                parent_id: 'session-0',
            }),
            mockClient,
        );
        expect(repo.revokeSessionAndDescendants).not.toHaveBeenCalled();
    });

    it('rotates N to N+1 to N+2, then replaying N revokes N+1 and N+2 descendants', async () => {
        const repo = new InMemoryRefreshRepository();
        repo.addSession({ id: 'session-0', token: 'refresh-session-0' });
        const service = new RefreshService(repo, new DeterministicTokenService(), mockDb, logger);

        const first = await service.refresh('refresh-session-0');
        expect(first?.refreshToken).toMatch(/^refresh-/);
        const session1Id = first!.refreshToken.replace('refresh-', '');

        const second = await service.refresh(first!.refreshToken);
        expect(second?.refreshToken).toMatch(/^refresh-/);
        const session2Id = second!.refreshToken.replace('refresh-', '');

        expect(repo.sessions.get('session-0')?.revoked_at).toBeNull();
        expect(repo.sessions.get(session1Id)?.revoked_at).toBeNull();
        expect(repo.sessions.get(session2Id)?.revoked_at).toBeNull();

        const replay = await service.refresh('refresh-session-0');

        expect(replay).toBeNull();
        expect(repo.revocations).toEqual(['session-0']);
        expect(repo.sessions.get('session-0')?.revoked_at).toBeInstanceOf(Date);
        expect(repo.sessions.get(session1Id)?.revoked_at).toBeInstanceOf(Date);
        expect(repo.sessions.get(session2Id)?.revoked_at).toBeInstanceOf(Date);
    });

    it('replay of a grandparent token revokes a lineage longer than 10 sessions', async () => {
        const repo = new InMemoryRefreshRepository();
        repo.addSession({ id: 'session-0', token: 'refresh-session-0' });
        const service = new RefreshService(repo, new DeterministicTokenService(), mockDb, logger);

        const sessionIds = ['session-0'];
        let refreshToken = 'refresh-session-0';
        for (let i = 0; i < 11; i += 1) {
            const result = await service.refresh(refreshToken);
            expect(result).not.toBeNull();
            refreshToken = result!.refreshToken;
            sessionIds.push(refreshToken.replace('refresh-', ''));
        }

        const replay = await service.refresh('refresh-session-0');

        expect(replay).toBeNull();
        expect(repo.revocations).toEqual(['session-0']);
        for (const sessionId of sessionIds) {
            expect(repo.sessions.get(sessionId)?.revoked_at).toBeInstanceOf(Date);
        }
    });

    it('deduplicates two same-process callers racing on the same token without revoking the winner child', async () => {
        let releaseFirstRead!: () => void;
        const firstRead = new Promise<void>((resolve) => {
            releaseFirstRead = resolve;
        });
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-0', role: ROLE });
        tokenService.issueTokens.mockReturnValue({ accessToken: 'access-new', refreshToken: 'refresh-new' });
        tokenService.hashToken.mockReturnValueOnce('hash:refresh-session-0').mockReturnValueOnce('hash:refresh-new');
        repo.findSessionByIdForUpdate.mockImplementationOnce(async () => {
            await firstRead;
            return {
                id: 'session-0',
                user_id: USER_ID,
                token_hash: 'hash:refresh-session-0',
                expires_at: NOW_FUTURE,
                revoked_at: null,
                token_consumed_at: null,
            };
        });
        repo.findSessionByParentId.mockResolvedValue(null);
        repo.createSession.mockResolvedValue({ id: 'session-1' });

        const first = service.refresh('refresh-session-0');
        const second = service.refresh('refresh-session-0');
        releaseFirstRead();

        const results = await Promise.all([first, second]);
        const successes = results.filter(Boolean);

        expect(successes).toEqual([{ accessToken: 'access-new', refreshToken: 'refresh-new' }]);
        expect(repo.createSession).toHaveBeenCalledTimes(1);
        expect(repo.revokeSessionAndDescendants).not.toHaveBeenCalled();
    });

    it('revokes the family when a previously consumed parent token is replayed after rotation', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-0', role: ROLE });
        tokenService.hashToken.mockReturnValue('hash:refresh-session-0');
        repo.findSessionByIdForUpdate.mockResolvedValue({
            id: 'session-0',
            user_id: USER_ID,
            token_hash: 'hash:refresh-session-0',
            expires_at: NOW_FUTURE,
            revoked_at: null,
            token_consumed_at: new Date('2026-01-01T00:00:00.000Z'),
        });

        const result = await service.refresh('refresh-session-0');

        expect(result).toBeNull();
        expect(repo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-0', mockClient);
        expect(repo.createSession).not.toHaveBeenCalled();
    });

    it('rejects an expired parent session without creating a child or revoking unrelated descendants', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-0', role: ROLE });
        tokenService.hashToken.mockReturnValue('hash:refresh-session-0');
        repo.findSessionByIdForUpdate.mockResolvedValue({
            id: 'session-0',
            user_id: USER_ID,
            token_hash: 'hash:refresh-session-0',
            expires_at: NOW_PAST,
            revoked_at: null,
            token_consumed_at: null,
        });

        const result = await service.refresh('refresh-session-0');

        expect(result).toBeNull();
        expect(repo.createSession).not.toHaveBeenCalled();
        expect(repo.revokeSessionAndDescendants).not.toHaveBeenCalled();
    });

    it('does not write raw refresh tokens into warning logs when verification fails', async () => {
        const rawToken = 'raw-refresh-token-value-that-must-not-leak';
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockImplementation(() => {
            throw new Error('invalid token');
        });

        const result = await service.refresh(rawToken);

        expect(result).toBeNull();
        const warnCalls = JSON.stringify((logger.warn as jest.Mock).mock.calls);
        expect(warnCalls).not.toContain(rawToken);
        expect(warnCalls).not.toContain(rawToken.substring(0, 10));
        expect(mockWithTransaction).not.toHaveBeenCalled();
    });

    it('revokes session family when stored token hash does not match incoming token', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-0', role: ROLE });
        tokenService.hashToken.mockReturnValue('hash:different-token');
        repo.findSessionByIdForUpdate.mockResolvedValue({
            id: 'session-0',
            user_id: USER_ID,
            token_hash: 'hash:stored-token',
            expires_at: NOW_FUTURE,
            revoked_at: null,
            token_consumed_at: null,
        });

        const result = await service.refresh('refresh-session-0');

        expect(result).toBeNull();
        expect(repo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-0', mockClient);
        expect(repo.createSession).not.toHaveBeenCalled();
    });

    it('returns null when session is not found during refresh transaction', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-ghost', role: ROLE });
        repo.findSessionByIdForUpdate.mockResolvedValue(null);

        const result = await service.refresh('refresh-session-ghost');

        expect(result).toBeNull();
        expect(repo.createSession).not.toHaveBeenCalled();
        expect(repo.revokeSessionAndDescendants).not.toHaveBeenCalled();
    });

    it('revokes session family when session is already revoked', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-0', role: ROLE });
        tokenService.hashToken.mockReturnValue('hash:refresh-session-0');
        repo.findSessionByIdForUpdate.mockResolvedValue({
            id: 'session-0',
            user_id: USER_ID,
            token_hash: 'hash:refresh-session-0',
            expires_at: NOW_FUTURE,
            revoked_at: new Date('2025-01-01'),
            token_consumed_at: null,
        });

        const result = await service.refresh('refresh-session-0');

        expect(result).toBeNull();
        expect(repo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-0', mockClient);
        expect(repo.createSession).not.toHaveBeenCalled();
    });

    it('revokes session family when child session already exists (reuse probe)', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-0', role: ROLE });
        tokenService.hashToken.mockReturnValue('hash:refresh-session-0');
        repo.findSessionByIdForUpdate.mockResolvedValue({
            id: 'session-0',
            user_id: USER_ID,
            token_hash: 'hash:refresh-session-0',
            expires_at: NOW_FUTURE,
            revoked_at: null,
            token_consumed_at: null,
        });
        repo.findSessionByParentId.mockResolvedValue({ id: 'session-child', parent_id: 'session-0' });

        const result = await service.refresh('refresh-session-0');

        expect(result).toBeNull();
        expect(repo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-0', mockClient);
        expect(repo.createSession).not.toHaveBeenCalled();
    });

    it('clears inFlightSessions set and rethrows when transaction fails', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-0', role: ROLE });
        repo.findSessionByIdForUpdate.mockRejectedValue(new Error('Connection lost'));

        await expect(service.refresh('refresh-session-0')).rejects.toThrow('Connection lost');

        // Verify session can be attempted again (in-flight set was cleared)
        repo.findSessionByIdForUpdate.mockResolvedValue(null);
        const retryResult = await service.refresh('refresh-session-0');
        expect(retryResult).toBeNull();
    });

    // ── Regression: missing branch coverage ─────────────────────────────────

    /**
     * Regression for the `.catch` error handler at line ~193.
     * When `withTransaction` rejects with a non-Error value (e.g. a plain
     * string or object), the handler must fall through to `String(error)` so
     * it never throws a TypeError from `.message` access.
     * The error must be re-thrown unchanged; the in-flight lock must be cleared.
     */
    it('rethrows non-Error rejection from transaction and clears in-flight lock', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-0', role: ROLE });
        // Reject with a plain string — not an Error instance — to exercise the
        // `String(error)` branch in the catch handler (line ~193).
        repo.findSessionByIdForUpdate.mockRejectedValue('plain-string-error');

        await expect(service.refresh('refresh-session-0')).rejects.toBe('plain-string-error');

        // The error message logged must be the string-coerced value, not a crash.
        expect(logger.error).toHaveBeenCalledWith(
            'Refresh transaction failed',
            expect.objectContaining({
                error: 'plain-string-error',
            }),
        );

        // In-flight lock must be released so the same session can be retried.
        repo.findSessionByIdForUpdate.mockResolvedValue(null);
        const retryResult = await service.refresh('refresh-session-0');
        expect(retryResult).toBeNull();
    });

    /**
     * Regression for the `String(error)` branch in the token-verification
     * catch block (line ~65).
     * When `verifyRefreshToken` throws a non-Error value (e.g. a plain string),
     * the logger must receive the string-coerced representation and the method
     * must return null without crashing.
     */
    it('returns null and logs string-coerced message when verifyRefreshToken throws a non-Error value', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        // Throw a plain string (not an Error instance) to exercise String(error).
        tokenService.verifyRefreshToken.mockImplementation(() => {
            throw 'non-error-string-rejection';
        });

        const result = await service.refresh('any-token');

        expect(result).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            'Refresh token verification failed',
            expect.objectContaining({
                error: 'non-error-string-rejection',
            }),
        );
        expect(mockWithTransaction).not.toHaveBeenCalled();
    });

    /**
     * Regression for the default-logger constructor branch (lines ~50-65).
     * When `RefreshService` is instantiated without an explicit logger, it
     * creates its own `new Logger()`. The service must still function correctly —
     * this exercises the default-parameter branch that all other tests skip by
     * always injecting a mock logger.
     */
    it('works correctly when instantiated without an explicit logger (default Logger branch)', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        // No fourth argument → default Logger() is constructed internally.
        const service = new RefreshService(repo, tokenService, mockDb);

        tokenService.verifyRefreshToken.mockImplementation(() => {
            throw new Error('invalid signature');
        });

        // Must return null and must not throw, even with the real Logger.
        const result = await service.refresh('any-token');
        expect(result).toBeNull();
    });

    // ── Regression #979: explicit null-return failure paths (lines 67 / 77 / 97) ──

    /**
     * Line 67 — `verifyRefreshToken` throws an `Error` instance.
     * Contract: return null, log the sanitized `error.message`, and never open
     * a transaction or touch the repository.
     */
    it('returns null and logs the rejection reason when verifyRefreshToken throws (line 67)', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockImplementation(() => {
            throw new Error('jwt malformed');
        });

        const result = await service.refresh('refresh-session-0');

        expect(result).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            'Refresh token verification failed',
            { error: 'jwt malformed' },
        );
        expect(mockWithTransaction).not.toHaveBeenCalled();
        expect(repo.findSessionByIdForUpdate).not.toHaveBeenCalled();
        expect(repo.revokeSessionAndDescendants).not.toHaveBeenCalled();
        expect(repo.createSession).not.toHaveBeenCalled();
    });

    /**
     * Line 67 boundary — empty and whitespace-only tokens are invalid inputs
     * and must hit the same null contract as any other verification failure.
     */
    it('returns null for empty and whitespace-only tokens without opening a transaction (line 67 boundary)', async () => {
        for (const boundaryToken of ['', '   ']) {
            const repo = createMockRepo();
            const tokenService = createMockTokenService();
            const service = new RefreshService(repo, tokenService, mockDb, logger);

            tokenService.verifyRefreshToken.mockImplementation((token: string) => {
                if (token.trim().length === 0) {
                    throw new Error('empty token');
                }
                return { userId: USER_ID, sessionId: 'session-0', role: ROLE };
            });

            const result = await service.refresh(boundaryToken);

            expect(result).toBeNull();
            expect(logger.warn).toHaveBeenCalledWith(
                'Refresh token verification failed',
                { error: 'empty token' },
            );
            expect(mockWithTransaction).not.toHaveBeenCalled();
        }
    });

    /**
     * Line 77 — same-process duplicate while a refresh is mid-flight.
     * Contract: the duplicate returns null with the in-flight warning and must
     * not revoke anything (the winning caller's child session stays intact).
     * Neighbouring normal path: the winner still completes rotation, and the
     * lock is released so a later attempt reaches the transaction again.
     */
    it('returns null for a duplicate refresh while one is in flight and releases the lock afterwards (line 77)', async () => {
        let releaseFirstRead!: () => void;
        const firstRead = new Promise<void>((resolve) => {
            releaseFirstRead = resolve;
        });
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-0', role: ROLE });
        tokenService.issueTokens.mockReturnValue({ accessToken: 'access-new', refreshToken: 'refresh-new' });
        tokenService.hashToken.mockReturnValueOnce('hash:refresh-session-0').mockReturnValueOnce('hash:refresh-new');
        repo.findSessionByIdForUpdate.mockImplementationOnce(async () => {
            await firstRead;
            return {
                id: 'session-0',
                user_id: USER_ID,
                token_hash: 'hash:refresh-session-0',
                expires_at: NOW_FUTURE,
                revoked_at: null,
                token_consumed_at: null,
            };
        });
        repo.findSessionByParentId.mockResolvedValue(null);
        repo.createSession.mockResolvedValue({ id: 'session-1' });

        const first = service.refresh('refresh-session-0');
        const duplicate = await service.refresh('refresh-session-0');

        // Failure contract: null + in-flight warning, no revocation, no writes.
        expect(duplicate).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            'Concurrent refresh already in flight',
            { userId: USER_ID, sessionId: 'session-0' },
        );
        expect(repo.revokeSessionAndDescendants).not.toHaveBeenCalled();
        expect(repo.createSession).not.toHaveBeenCalled();

        // Neighbouring normal path: the winner still completes rotation.
        releaseFirstRead();
        const winner = await first;
        expect(winner).toEqual({ accessToken: 'access-new', refreshToken: 'refresh-new' });

        // Lock release: a later attempt reaches the transaction again instead
        // of being short-circuited by the in-flight gate.
        repo.findSessionByIdForUpdate.mockResolvedValue(null);
        await service.refresh('refresh-session-0');
        expect(mockWithTransaction).toHaveBeenCalledTimes(2);
    });

    /**
     * Line 97 — session row not found inside the transaction.
     * Contract: return null with the not-found warning. Distinct from the
     * verification failure path: the transaction IS opened here. No revocation
     * and no writes may occur, and the in-flight lock must be released.
     */
    it('returns null with a not-found warning when the locked session row is missing (line 97)', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-ghost', role: ROLE });
        repo.findSessionByIdForUpdate.mockResolvedValue(null);

        const result = await service.refresh('refresh-session-ghost');

        expect(result).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            'Session not found during refresh',
            { userId: USER_ID, sessionId: 'session-ghost' },
        );
        expect(mockWithTransaction).toHaveBeenCalledTimes(1);
        expect(repo.revokeSessionAndDescendants).not.toHaveBeenCalled();
        expect(repo.createSession).not.toHaveBeenCalled();
        expect(repo.setSessionConsumed).not.toHaveBeenCalled();

        // In-flight lock must be released by the finally block.
        const retry = await service.refresh('refresh-session-ghost');
        expect(retry).toBeNull();
        expect(mockWithTransaction).toHaveBeenCalledTimes(2);
    });

    /**
     * Line 97 boundary — the guard is falsy-based, so `undefined` (a bare
     * repository miss) must take the same null path as an explicit `null`.
     */
    it('treats an undefined session row the same as a missing one (line 97 falsy boundary)', async () => {
        const repo = createMockRepo();
        const tokenService = createMockTokenService();
        const service = new RefreshService(repo, tokenService, mockDb, logger);

        tokenService.verifyRefreshToken.mockReturnValue({ userId: USER_ID, sessionId: 'session-void', role: ROLE });
        repo.findSessionByIdForUpdate.mockResolvedValue(undefined as unknown as null);

        const result = await service.refresh('refresh-session-void');

        expect(result).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            'Session not found during refresh',
            { userId: USER_ID, sessionId: 'session-void' },
        );
        expect(repo.revokeSessionAndDescendants).not.toHaveBeenCalled();
        expect(repo.createSession).not.toHaveBeenCalled();
    });
});
