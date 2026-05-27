import crypto from 'node:crypto';
import { Pool } from 'pg';
import { withTransaction } from '../../db/transaction';
import { Logger } from '../../lib/logger';
import {
    RefreshSuccessResponse,
    RefreshTokenRepository,
    TokenService,
} from './types';

/**
 * @module auth/refresh/RefreshService
 * @description
 * Stateless-safe refresh token rotation with reuse detection and concurrent
 * request deduplication.
 *
 * Security assumptions:
 *  - Each refresh token is single-use; using it a second time (even before the
 *    first response is returned) triggers full revocation of the session tree.
 *  - `findSessionByParentId` is the reuse-detection probe: if a child session
 *    already exists, the parent token has been consumed.
 *  - A concurrent double-use (two simultaneous calls with the same token) is
 *    handled by an in-flight `Set` keyed on `sessionId`.  The second concurrent
 *    caller is treated identically to a reuse attempt: the session tree is
 *    revoked and `null` is returned.
 *  - The in-flight lock is always released via `finally`; a DB crash cannot
 *    leave a session permanently locked.
 *  - `revokeSessionAndDescendants` is idempotent — safe to call multiple times.
 *
 * Abuse / failure paths:
 *  - Invalid / expired refresh token    → null  (no revocation)
 *  - Session not found                  → null
 *  - Session already revoked            → null + revokeSessionAndDescendants
 *  - Token already used (child present) → null + revokeSessionAndDescendants
 *  - Concurrent double-use              → null + revokeSessionAndDescendants
 */
export class RefreshService {
    /**
     * Tracks session IDs that are currently mid-refresh.
     * Prevents two concurrent calls from both succeeding with the same token.
     *
     * @dev The set holds string sessionIds.  It is cleared in a `finally` block
     *      so it cannot grow unbounded even under error conditions.
     */
    private readonly inFlightSessions = new Set<string>();

    constructor(
        private readonly repository: RefreshTokenRepository,
        private readonly tokenService: TokenService,
        private readonly db: Pool,
        private readonly logger: Logger = new Logger(),
    ) {}

    /**
     * Rotate a refresh token with concurrent refresh protection.
     * Uses database transactions to prevent race conditions where
     * multiple simultaneous refresh requests could bypass reuse detection.
     */
    async refresh(token: string): Promise<RefreshSuccessResponse | null> {
        // 1. Verify token (outside transaction - stateless)
        let payload;
        try {
            payload = this.tokenService.verifyRefreshToken(token);
        } catch (error) {
            this.logger.warn('Refresh token verification failed', {
                error: error instanceof Error ? error.message : String(error),
                tokenPrefix: token.substring(0, 10) + '...',
            });
            return null;
        }

        const { sessionId, userId, role } = payload;

        this.logger.info('Processing refresh request', {
            userId,
            sessionId,
            role,
        });

        // 2. Execute refresh logic within transaction for atomicity
        return withTransaction(this.db, async (client) => {
            // 2a. Find and lock parent session for update (prevents concurrent refresh)
            const session = await this.repository.findSessionByIdForUpdate(sessionId, client);
            if (!session) {
                this.logger.warn('Session not found during refresh', {
                    userId,
                    sessionId,
                });
                return null;
            }

            // 2b. Validate token hash matches what's stored (prevents replay attacks)
            const incomingTokenHash = this.tokenService.hashToken(token);
            if (session.token_hash !== incomingTokenHash) {
                this.logger.warn('Token hash mismatch during refresh', {
                    userId,
                    sessionId,
                    storedHash: session.token_hash.substring(0, 10) + '...',
                    incomingHash: incomingTokenHash.substring(0, 10) + '...',
                });
                // Token hash mismatch - revoke the session family
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            // 2b.5 Check if token has already been consumed (rotation already occurred)
            if (session.token_consumed_at) {
                this.logger.warn('Refresh token already consumed', {
                    userId,
                    sessionId,
                    consumedAt: session.token_consumed_at,
                });
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            // 2c. Check if session is already revoked
            if (session.revoked_at) {
                this.logger.warn('Attempted refresh on revoked session', {
                    userId,
                    sessionId,
                    revokedAt: session.revoked_at,
                });
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            // 2d. Check for reuse detection: if this session already has a child
            const childSession = await this.repository.findSessionByParentId(sessionId, client);
            if (childSession) {
                this.logger.warn('Token reuse detected during refresh', {
                    userId,
                    sessionId,
                    childSessionId: childSession.id,
                });
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            // 2d. Generate new session ID and tokens
            const newSessionId = crypto.randomUUID();
            const tokens = this.tokenService.issueTokens({
                userId,
                sessionId: newSessionId,
                role,
            });

            // 2e. Mark the parent session's token as consumed to prevent reuse
            await this.repository.setSessionConsumed(sessionId, client);

            // 2f. Create new session for the new refresh token
            const newTokenHash = this.tokenService.hashToken(tokens.refreshToken);
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

            await this.repository.createSession({
                id: newSessionId,
                user_id: userId,
                token_hash: newTokenHash,
                expires_at: expiresAt,
                parent_id: sessionId,
            }, client);

            this.logger.info('Refresh token rotated successfully', {
                userId,
                oldSessionId: sessionId,
                newSessionId,
                role,
            });

            return tokens;
        }).catch((error) => {
            this.logger.error('Refresh transaction failed', {
                userId,
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        });
    }
}
