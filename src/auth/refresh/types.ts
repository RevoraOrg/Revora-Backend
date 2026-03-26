import { UserRole } from '../login/types';

export interface RefreshTokenPayload {
    userId: string;
    sessionId: string;
    role: UserRole;
}

export interface RefreshSuccessResponse {
    accessToken: string;
    refreshToken: string;
}

export interface RefreshTokenRepository {
    /** Find a session by its ID. */
    findSessionById(sessionId: string): Promise<any>;
    /** Create a new session linked to a parent. */
    createSession(input: {
        id?: string;
        user_id: string;
        token_hash: string;
        expires_at: Date;
        parent_id: string;
    }): Promise<any>;
    /** Revoke a session and all its descendants (for reuse detection). */
    revokeSessionAndDescendants(sessionId: string): Promise<void>;
    /** Check if a session has been used as a parent (i.e., already rotated). */
    findSessionByParentId(parentId: string): Promise<any>;
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
