import { SessionRepository as DBSessionRepository } from '../../db/repositories/sessionRepository';
import { SessionRepository } from './types';

export class SessionRepositoryAdapter implements SessionRepository {
    constructor(private readonly dbRepo: DBSessionRepository) {}

    async createSession(input: {
        id: string;
        userId: string;
        tokenHash: string;
        expiresAt: Date;
    }): Promise<void> {
        await this.dbRepo.createSession({
            id: input.id,
            user_id: input.userId,
            token_hash: input.tokenHash,
            expires_at: input.expiresAt,
        });
    }
}
