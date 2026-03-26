import { issueToken, TOKEN_EXPIRY, REFRESH_TOKEN_EXPIRY } from '../../lib/jwt';
import { JwtIssuer, UserRole } from './types';

export class JwtIssuerAdapter implements JwtIssuer {
  sign(payload: { userId: string; sessionId: string; role: UserRole }): {
    accessToken: string;
    refreshToken: string;
  } {
    const accessToken = issueToken({
      subject: payload.userId,
      expiresIn: TOKEN_EXPIRY,
      additionalPayload: {
        sid: payload.sessionId,
        role: payload.role,
      },
    });

    const refreshToken = issueToken({
      subject: payload.userId,
      expiresIn: REFRESH_TOKEN_EXPIRY,
      additionalPayload: {
        sid: payload.sessionId,
        role: payload.role,
      },
    });

    return { accessToken, refreshToken };
  }
}
