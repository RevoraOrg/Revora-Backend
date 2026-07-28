import { SessionRepository } from '../../db/repositories/sessionRepository';
import { RefreshTokenRepository } from './types';
import { PoolClient } from 'pg';

export class RefreshTokenRepositoryAdapter implements RefreshTokenRepository {
    constructor(private readonly sessionRepository: SessionRepository) {}

    async findSessionById(sessionId: string, client?: PoolClient): Promise<any> {
        return this.sessionRepository.findById(sessionId, client);
    }

    async createSession(input: {
        id?: string;
        user_id: string;
        token_hash: string;
        expires_at: Date;
        parent_id: string;
    }, client?: PoolClient): Promise<any> {
        return this.sessionRepository.createSession(input, client);
    }

    async revokeSessionAndDescendants(sessionId: string, client?: PoolClient): Promise<void> {
        return this.sessionRepository.revokeSessionAndDescendants(sessionId, client);
    }

    async findSessionByParentId(parentId: string, client?: PoolClient): Promise<any> {
        return this.sessionRepository.findByParentId(parentId, client);
    }

    async findSessionByIdForUpdate(sessionId: string, client: PoolClient): Promise<any> {
        return this.sessionRepository.findByIdForUpdate(sessionId, client);
    }

    async setSessionConsumed(sessionId: string, client?: PoolClient): Promise<void> {
        return this.sessionRepository.setSessionConsumed(sessionId, client);
    }
}
