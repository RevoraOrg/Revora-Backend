/**
 * @file src/auth/refresh/repositoryAdapter.test.ts
 * @description Unit tests for RefreshTokenRepositoryAdapter delegating to SessionRepository.
 */

import { Pool, PoolClient } from 'pg';
import { SessionRepository } from '../../db/repositories/sessionRepository';
import { RefreshTokenRepositoryAdapter } from './repositoryAdapter';

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
});
