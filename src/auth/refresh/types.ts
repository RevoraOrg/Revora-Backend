import { UserRole } from '../login/types';
import { PoolClient } from 'pg';

export interface RefreshTokenPayload {
    userId: string;
    sessionId: string;
    role: UserRole;
}

export interface RefreshSuccessResponse {
    accessToken: string;
    refreshToken: string;
}

/**
 * Minimal projection of a user required to authorise a refresh rotation.
 *
 * Only the fields needed to re-derive the *current* authorisation state are
 * exposed — never the password hash or other credentials.
 */
export interface RefreshUserRecord {
    id: string;
    role: UserRole;
    /**
     * Whether the account is still permitted to authenticate. A `false` value
     * (or `null` from the lookup) causes the whole refresh-token family to be
     * revoked and the rotation to fail.
     */
    active: boolean;
}

/**
 * Narrow read-only boundary used by {@link RefreshTokenRepository}-backed
 * services to reload authoritative user state inside the rotation transaction.
 *
 * Implementations MUST run the lookup on the caller-supplied `client` so that
 * the read participates in the same transaction/lock scope as the rotation.
 */
export interface RefreshUserLookup {
    /**
     * Load the current user record for `userId`.
     *
     * @returns the record, or `null` when the user no longer exists (deleted /
     *          hard-deprovisioned).
     */
    findById(userId: string, client?: PoolClient): Promise<RefreshUserRecord | null>;
}

export interface RefreshTokenRepository {
    /** Find a session by its ID. */
    findSessionById(sessionId: string, client?: PoolClient): Promise<any>;
    /** Create a new session linked to a parent. */
    createSession(input: {
        id?: string;
        user_id: string;
        token_hash: string;
        expires_at: Date;
        parent_id: string;
        /**
         * Absolute family deadline inherited from the parent session. When
         * omitted the database default applies to new family roots.
         */
        family_expires_at?: Date | null;
    }, client?: PoolClient): Promise<any>;
    /** Revoke a session and all its descendants (for reuse detection). */
    revokeSessionAndDescendants(sessionId: string, client?: PoolClient): Promise<void>;
    /** Check if a session has been used as a parent (i.e., already rotated). */
    findSessionByParentId(parentId: string, client?: PoolClient): Promise<any>;
    /** Find session by ID with exclusive lock for update (for concurrent refresh protection). */
    findSessionByIdForUpdate(sessionId: string, client: PoolClient): Promise<any>;
    /** Mark a session's refresh token as consumed (rotation has occurred). */
    setSessionConsumed(sessionId: string, client?: PoolClient): Promise<void>;
    /**
     * False for a deactivated or missing user (#1300). Must lock the user row
     * FOR SHARE so a concurrent deactivation waits for this refresh.
     */
    isUserActive(userId: string, client: PoolClient): Promise<boolean>;
}

export interface TokenService {
    /** Verify a refresh token and return its payload. */
    verifyRefreshToken(token: string): RefreshTokenPayload;
    /** Issue a new set of tokens. */
    issueTokens(payload: RefreshTokenPayload): {
        accessToken: string;
        refreshToken: string;
    };
    /** Hash a token for storage. */
    hashToken(token: string): string;
}
