import { SessionRepository } from '../../db/repositories/sessionRepository';
import { RefreshTokenRepository } from './types';

export class RefreshTokenRepositoryAdapter implements RefreshTokenRepository {
    constructor(private readonly sessionRepository: SessionRepository) {}

    async findSessionById(sessionId: string): Promise<any> {
        return this.sessionRepository.findById(sessionId);
    }

    async createSession(input: {
        id?: string;
        user_id: string;
        token_hash: string;
        expires_at: Date;
        parent_id: string;
    }): Promise<any> {
        return this.sessionRepository.createSession(input);
    }

    async revokeSessionAndDescendants(sessionId: string): Promise<void> {
        return this.sessionRepository.revokeSessionAndDescendants(sessionId);
    }

    async findSessionByParentId(parentId: string): Promise<any> {
        return this.sessionRepository.findByParentId(parentId);
    }
}
