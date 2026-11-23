import { createHash } from 'node:crypto';
import { issueToken, verifyToken, TOKEN_EXPIRY, REFRESH_TOKEN_EXPIRY } from '../../lib/jvt';
import { RefreshTokenPayload, TokenService } from './types';
import { UserRole } from '../login/types';

export class JwtTokenServiceAdapter implements TokenService {
    verifyRefreshToken(token: string): RefreshTokenPayload {
        const payload = verifyToken(token, { expectedType: 'refresh' });
        return {
            userId: payload.sub,
            sessionId: payload.sid as string,
            role: payload.role as UserRole,
        };
    }

    issueTokens(payload: RefreshTokenPayload): {
        accessToken: string;
        refreshToken: string;
    } {
        const accessToken = issueToken( {
            subject: payload.userId,
            expiresIn: TOKEN_EXPIRY,
            additionalPayload: {
                sid: payload.sessionId,
                role: payload.role,
                typ: 'access',
            },
        });

        const refreshToken = issueToken( {
            subject: payload.userId,
            expiresIn: REFRESH_TOKEN_EXPIRY,
            additionalPayload: {
                sid: payload.sessionId,
                role: payload.role,
                typ: 'refresh',
            },
        });

        return { accessToken, refreshToken };
    }

    hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }
}
