import { SessionRepository } from '../../db/repositories/sessionRepository';
import {
    RefreshTokenRepository,
    RefreshUserLookup,
    RefreshUserRecord,
} from './types';
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
        family_expires_at?: Date | null;
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

    /** Missing user counts as inactive. */
    async isUserActive(userId: string, client: PoolClient): Promise<boolean> {
        const result = await client.query<{ is_active: boolean }>(
            'SELECT is_active FROM users WHERE id = $1 FOR SHARE',
            [userId],
        );
        return result.rows.length > 0 && result.rows[0].is_active !== false;
    }
}

/**
 * Minimal structural view of {@link import('../../db/repositories/userRepository')}
 * that this adapter depends on. Kept structural so tests can pass a plain
 * mock without importing the full repository.
 */
export interface RefreshUserSource {
    findById(id: string): Promise<{
        id: string;
        role: string;
        /** Optional account status; absent columns default to active. */
        active?: boolean | null;
        status?: string | null;
    } | null>;
}

/**
 * Adapts the full {@link import('../../db/repositories/userRepository').UserRepository}
 * to the narrow {@link RefreshUserLookup} boundary.
 *
 * The projection deliberately drops `password_hash` and every other credential
 * field, exposing only the identity, role, and account status needed to
 * authorise a rotation.
 *
 * @dev The underlying repository does not currently accept a `PoolClient`, so
 *      the lookup reads on the pool connection. It is still executed inside the
 *      caller's transaction callback; the session row itself remains locked by
 *      `findSessionByIdForUpdate`, which serialises concurrent rotations of the
 *      same session.
 */
export class RefreshUserLookupAdapter implements RefreshUserLookup {
    constructor(private readonly userSource: RefreshUserSource) {}

    async findById(userId: string): Promise<RefreshUserRecord | null> {
        const user = await this.userSource.findById(userId);
        if (!user) {
            return null;
        }
        return {
            id: user.id,
            // Preserve the raw role so the service can reject anything that is
            // not a known `UserRole` (fail closed) instead of silently coercing.
            role: user.role as RefreshUserRecord['role'],
            // Treat missing status information as active so the lookup does not
            // lock out deployments that have not yet added a status column.
            // An explicit `active === false` or `status === 'suspended'` /
            // `'disabled'` always disables the account.
            active: resolveActive(user),
        };
    }
}

/**
 * Resolve the account-active flag from the varied shapes a user row may take.
 *
 * Resolution order:
 *  1. explicit boolean `active` column (authoritative when present),
 *  2. textual `status` column (`active`/`enabled` are the only positive values),
 *  3. default to active.
 */
function resolveActive(user: { active?: boolean | null; status?: string | null }): boolean {
    if (typeof user.active === 'boolean') {
        return user.active;
    }
    if (typeof user.status === 'string') {
        return user.status === 'active' || user.status === 'enabled';
    }
    return true;
}
