import crypto from 'node:crypto';
import {
    RefreshSuccessResponse,
    RefreshTokenRepository,
    TokenService,
} from './types';

export class RefreshService {
    constructor(
        private readonly repository: RefreshTokenRepository,
        private readonly tokenService: TokenService,
    ) {}

    /**
     * Rotate a refresh token.
     */
    async refresh(token: string): Promise<RefreshSuccessResponse | null> {
        // 1. Verify token
        let payload;
        try {
            payload = this.tokenService.verifyRefreshToken(token);
        } catch (error) {
            return null;
        }

        const { sessionId, userId, role } = payload;

        // 2. Find session
        const session = await this.repository.findSessionById(sessionId);
        if (!session) {
            return null;
        }

        // 3. Reuse Detection: If session is already revoked
        if (session.revoked_at) {
            await this.repository.revokeSessionAndDescendants(sessionId);
            return null;
        }

        // 4. Reuse Detection: If this session already has a child session, this token was already used.
        const childSession = await this.repository.findSessionByParentId(sessionId);
        if (childSession) {
            await this.repository.revokeSessionAndDescendants(sessionId);
            return null;
        }

        // 5. Generate NEW session ID and tokens
        const newSessionId = crypto.randomUUID();
        const tokens = this.tokenService.issueTokens({
            userId,
            sessionId: newSessionId,
            role,
        });

        // 6. Create NEW session for the NEW refresh token
        const newTokenHash = this.tokenService.hashToken(tokens.refreshToken);
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

        await this.repository.createSession({
            id: newSessionId, // We need the repo to support passing ID
            user_id: userId,
            token_hash: newTokenHash,
            expires_at: expiresAt,
            parent_id: sessionId,
        });

        return tokens;
    }
}
