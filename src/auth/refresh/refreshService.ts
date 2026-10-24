import crypto from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction';
import { Logger } from '../../lib/logger';
import { isUserRole } from '../login/types';
import {
    RefreshSuccessResponse,
    RefreshTokenRepository,
    RefreshUserLookup,
    TokenService,
} from './types';

/**
 * @module auth/refresh/RefreshService
 * @description
 * Stateless-safe refresh token rotation with reuse detection, in-process
 * concurrent request deduplication, and authoritative re-authorisation on
 * every rotation.
 *
 * Security assumptions:
 *  - Each refresh token is single-use; using it a second time (even before the
 *    first response is returned) triggers full revocation of the session tree.
 *  - `findSessionByParentId` is the reuse-detection probe: if a child session
 *    already exists, the parent token has been consumed.
 *  - A concurrent duplicate refresh in this process is deduplicated with an
 *    in-flight `Set` keyed on `sessionId`; the second caller receives `null`
 *    without revoking the child created by the winning caller.
 *  - The in-flight lock is always released via `finally`; a DB crash cannot
 *    leave a session permanently locked.
 *  - `revokeSessionAndDescendants` is idempotent and safe to call multiple times.
 *  - **The role carried by the refresh token payload is advisory only.** The
 *    authoritative role and account status are reloaded from the database on
 *    every rotation (see {@link RefreshUserLookup}), so a demotion, suspension,
 *    or deletion takes effect no later than the next refresh.
 *  - **A token family has an absolute lifetime** (`family_expires_at`) fixed at
 *    login and inherited by every rotated child. Rotating a refresh token never
 *    extends this deadline, so a session cannot be kept alive indefinitely by
 *    refreshing every 7 days.
 *
 * Abuse / failure paths:
 *  - Invalid / expired refresh token          -> null (no revocation)
 *  - Session not found                        -> null
 *  - Session already revoked                  -> null + revokeSessionAndDescendants
 *  - Token already used after rotation        -> null + revokeSessionAndDescendants
 *  - Concurrent duplicate in-process          -> null (no revocation)
 *  - User deleted / disabled (inactive)       -> null + revokeSessionAndDescendants
 *  - User role no longer recognised           -> null + revokeSessionAndDescendants
 *  - Rotation past absolute family deadline   -> null + revokeSessionAndDescendants
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
        private readonly userLookup?: RefreshUserLookup,
    ) {}

    /**
     * Rotate a refresh token with concurrent refresh protection.
     * Uses database transactions to prevent race conditions where
     * multiple simultaneous refresh requests could bypass reuse detection.
     *
     * The returned access/refresh tokens always carry the user's **current**
     * role loaded from the database, never the role embedded in the incoming
     * refresh token.
     */
    async refresh(token: string): Promise<RefreshSuccessResponse | null> {
        // 1. Verify token (outside transaction - stateless)
        let payload;
        try {
            payload = this.tokenService.verifyRefreshToken(token);
        } catch (error) {
            this.logger.warn('Refresh token verification failed', {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }

        const { sessionId, userId, role } = payload;

        if (this.inFlightSessions.has(sessionId)) {
            this.logger.warn('Concurrent refresh already in flight', {
                userId,
                sessionId,
            });
            return null;
        }

        this.inFlightSessions.add(sessionId);

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

            // Bound the session's user to the identity claimed in the token. A
            // mismatch means the token was forged or the session was re-purposed;
            // fail closed and revoke the family.
            if (session.user_id && session.user_id !== userId) {
                this.logger.warn('Session user mismatch during refresh', {
                    tokenUserId: userId,
                    sessionUserId: session.user_id,
                    sessionId,
                });
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            if (session.expires_at && session.expires_at <= new Date()) {
                this.logger.warn('Attempted refresh on expired session', {
                    userId,
                    sessionId,
                    expiresAt: session.expires_at,
                });
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

            // 2c.5 Reject deactivated users (#1300)
            if (!(await this.repository.isUserActive(session.user_id, client))) {
                this.logger.warn('Attempted refresh for inactive user', {
                    userId,
                    sessionId,
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

            // 2e. Enforce the absolute family lifetime. The deadline is fixed at
            //     family creation and inherited unchanged by every child, so a
            //     refresh never extends it. Once passed, the family is dead.
            const familyExpiresAt = session.family_expires_at
                ? new Date(session.family_expires_at)
                : null;
            if (familyExpiresAt && familyExpiresAt <= new Date()) {
                this.logger.warn('Refresh refused: absolute family lifetime exceeded', {
                    userId,
                    sessionId,
                    familyExpiresAt,
                });
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            // 2f. Reload authoritative user state. The role in the refresh token
            //     payload is untrusted for authorisation purposes: an admin who is
            //     demoted to investor, or a user suspended via SCIM, must not keep
            //     receiving elevated access by rotating an old token.
            const user = await this.loadUser(userId, client);
            if (!user) {
                this.logger.warn('Refresh refused: user no longer exists', {
                    userId,
                    sessionId,
                });
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            if (!user.active) {
                this.logger.warn('Refresh refused: user is disabled', {
                    userId,
                    sessionId,
                });
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            if (!isUserRole(user.role)) {
                this.logger.warn('Refresh refused: user role is not recognised', {
                    userId,
                    sessionId,
                    role: user.role,
                });
                await this.repository.revokeSessionAndDescendants(sessionId, client);
                return null;
            }

            const currentRole = user.role;

            // 2g. Generate new session ID and tokens with the *current* DB role.
            const newSessionId = crypto.randomUUID();
            const tokens = this.tokenService.issueTokens({
                userId,
                sessionId: newSessionId,
                role: currentRole,
            });

            // 2h. Mark the parent session's token as consumed to prevent reuse
            await this.repository.setSessionConsumed(sessionId, client);

            // 2i. Create new session for the new refresh token. The child inherits
            //     the parent's absolute family deadline verbatim (when present) so
            //     that rotation cannot extend the family lifetime.
            const newTokenHash = this.tokenService.hashToken(tokens.refreshToken);
            const expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + 7); // 7 days sliding window

            await this.repository.createSession({
                id: newSessionId,
                user_id: userId,
                token_hash: newTokenHash,
                expires_at: expiresAt,
                parent_id: sessionId,
                family_expires_at: familyExpiresAt,
            }, client);

            this.logger.info('Refresh token rotated successfully', {
                userId,
                oldSessionId: sessionId,
                newSessionId,
                role: currentRole,
            });

            return tokens;
        }).catch((error) => {
            this.logger.error('Refresh transaction failed', {
                userId,
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }).finally(() => {
            this.inFlightSessions.delete(sessionId);
        });
    }

    /**
     * Load the authoritative user record, preferring the injected
     * {@link RefreshUserLookup}.
     *
     * @dev When no lookup is configured the service fails closed: it cannot
     *      prove the user is still active, so it treats the user as absent.
     *      Production wiring always supplies a lookup (see `src/app.ts`).
     */
    private async loadUser(userId: string, client: PoolClient) {
        if (!this.userLookup) {
            return null;
        }
        return this.userLookup.findById(userId, client);
    }
}
