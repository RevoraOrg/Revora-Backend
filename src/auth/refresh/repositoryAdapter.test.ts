/**
 * @file src/auth/refresh/repositoryAdapter.test.ts
 * @description Unit tests for RefreshTokenRepositoryAdapter delegating to SessionRepository.
 */

import { PoolClient } from 'pg';
import { SessionRepository } from '../../db/repositories/sessionRepository';
import {
    RefreshTokenRepositoryAdapter,
    RefreshUserLookupAdapter,
    RefreshUserSource,
} from './repositoryAdapter';

describe('RefreshTokenRepositoryAdapter', () => {
    let mockSessionRepo: jest.Mocked<SessionRepository>;
    let adapter: RefreshTokenRepositoryAdapter;
    let mockClient: PoolClient;

    beforeEach(() => {
        mockSessionRepo = {
            findById: jest.fn(),
            createSession: jest.fn(),
            revokeSessionAndDescendants: jest.fn(),
            findByParentId: jest.fn(),
            findByIdForUpdate: jest.fn(),
            setSessionConsumed: jest.fn(),
        } as unknown as jest.Mocked<SessionRepository>;

        adapter = new RefreshTokenRepositoryAdapter(mockSessionRepo);
        mockClient = {} as PoolClient;
    });

    it('delegates findSessionById to SessionRepository.findById', async () => {
        const expectedSession = { id: 's-1', user_id: 'u-1' };
        mockSessionRepo.findById.mockResolvedValue(expectedSession as any);

        const result = await adapter.findSessionById('s-1', mockClient);

        expect(result).toBe(expectedSession);
        expect(mockSessionRepo.findById).toHaveBeenCalledWith('s-1', mockClient);
    });

    it('delegates createSession to SessionRepository.createSession', async () => {
        const input = {
            id: 's-2',
            user_id: 'u-1',
            token_hash: 'hash-xyz',
            expires_at: new Date(),
            parent_id: 's-1',
            family_expires_at: new Date('2030-01-31T00:00:00.000Z'),
        };
        const expectedSession = { ...input };
        mockSessionRepo.createSession.mockResolvedValue(expectedSession as any);

        const result = await adapter.createSession(input, mockClient);

        expect(result).toBe(expectedSession);
        expect(mockSessionRepo.createSession).toHaveBeenCalledWith(input, mockClient);
    });

    it('delegates revokeSessionAndDescendants to SessionRepository.revokeSessionAndDescendants', async () => {
        mockSessionRepo.revokeSessionAndDescendants.mockResolvedValue(undefined);

        await adapter.revokeSessionAndDescendants('s-1', mockClient);

        expect(mockSessionRepo.revokeSessionAndDescendants).toHaveBeenCalledWith('s-1', mockClient);
    });

    it('delegates findSessionByParentId to SessionRepository.findByParentId', async () => {
        const childSession = { id: 's-child', parent_id: 's-parent' };
        mockSessionRepo.findByParentId.mockResolvedValue(childSession as any);

        const result = await adapter.findSessionByParentId('s-parent', mockClient);

        expect(result).toBe(childSession);
        expect(mockSessionRepo.findByParentId).toHaveBeenCalledWith('s-parent', mockClient);
    });

    it('delegates findSessionByIdForUpdate to SessionRepository.findByIdForUpdate', async () => {
        const session = { id: 's-lock' };
        mockSessionRepo.findByIdForUpdate.mockResolvedValue(session as any);

        const result = await adapter.findSessionByIdForUpdate('s-lock', mockClient);

        expect(result).toBe(session);
        expect(mockSessionRepo.findByIdForUpdate).toHaveBeenCalledWith('s-lock', mockClient);
    });

    it('delegates setSessionConsumed to SessionRepository.setSessionConsumed', async () => {
        mockSessionRepo.setSessionConsumed.mockResolvedValue(undefined);

        await adapter.setSessionConsumed('s-consumed', mockClient);

        expect(mockSessionRepo.setSessionConsumed).toHaveBeenCalledWith('s-consumed', mockClient);
    });

    describe('isUserActive (#1300)', () => {
        const withRows = (rows: Array<{ is_active: boolean | null }>) =>
            ({ query: jest.fn().mockResolvedValue({ rows }) }) as unknown as PoolClient;

        it('reads the user row FOR SHARE on the transaction client', async () => {
            const client = withRows([{ is_active: true }]);

            await expect(adapter.isUserActive('u-1', client)).resolves.toBe(true);
            expect(client.query).toHaveBeenCalledWith(
                'SELECT is_active FROM users WHERE id = $1 FOR SHARE',
                ['u-1'],
            );
        });

        it('returns false for a deactivated user', async () => {
            await expect(adapter.isUserActive('u-1', withRows([{ is_active: false }]))).resolves.toBe(false);
        });

        it('fails closed when the user row no longer exists', async () => {
            await expect(adapter.isUserActive('u-gone', withRows([]))).resolves.toBe(false);
        });
    });
});

/**
 * The user lookup is the boundary that keeps refresh rotation honest about the
 * caller's *current* role/status. These tests pin down that it (a) drops
 * credentials from the projection and (b) maps status/active flags safely.
 */
describe('RefreshUserLookupAdapter', () => {
    let source: jest.Mocked<RefreshUserSource>;
    let adapter: RefreshUserLookupAdapter;

    beforeEach(() => {
        source = { findById: jest.fn() } as unknown as jest.Mocked<RefreshUserSource>;
        adapter = new RefreshUserLookupAdapter(source);
    });

    it('returns null when the user does not exist', async () => {
        source.findById.mockResolvedValue(null);

        await expect(adapter.findById('missing')).resolves.toBeNull();
    });

    it('projects only id, role, and active — never a password hash', async () => {
        source.findById.mockResolvedValue({
            id: 'u-1',
            role: 'investor',
            // Extra credential-ish fields a full row would carry.
            password_hash: 'super-secret',
            email: 'a@b.c',
        } as never);

        const result = await adapter.findById('u-1');

        expect(result).toEqual({ id: 'u-1', role: 'investor', active: true });
        expect(Object.keys(result as object).sort()).toEqual(['active', 'id', 'role']);
    });

    it('reflects a demoted role exactly as stored', async () => {
        source.findById.mockResolvedValue({ id: 'u-1', role: 'startup', active: true });

        await expect(adapter.findById('u-1')).resolves.toEqual({
            id: 'u-1',
            role: 'startup',
            active: true,
        });
    });

    it('marks the account inactive when active is explicitly false', async () => {
        source.findById.mockResolvedValue({ id: 'u-1', role: 'investor', active: false });

        await expect(adapter.findById('u-1')).resolves.toEqual({
            id: 'u-1',
            role: 'investor',
            active: false,
        });
    });

    it('marks the account inactive when status is suspended or disabled', async () => {
        for (const status of ['suspended', 'disabled', 'deactivated']) {
            source.findById.mockResolvedValue({ id: 'u-1', role: 'investor', status });

            const result = await adapter.findById('u-1');

            expect(result?.active).toBe(false);
        }
    });

    it('marks the account active when status is active or enabled', async () => {
        for (const status of ['active', 'enabled']) {
            source.findById.mockResolvedValue({ id: 'u-1', role: 'investor', status });

            const result = await adapter.findById('u-1');

            expect(result?.active).toBe(true);
        }
    });

    it('defaults to active when neither active nor status is present (pre-migration rows)', async () => {
        source.findById.mockResolvedValue({ id: 'u-1', role: 'investor' });

        const result = await adapter.findById('u-1');

        expect(result?.active).toBe(true);
    });

    it('prefers the boolean active column over a textual status', async () => {
        source.findById.mockResolvedValue({
            id: 'u-1',
            role: 'investor',
            active: false,
            status: 'active',
        });

        const result = await adapter.findById('u-1');

        expect(result?.active).toBe(false);
    });
});
