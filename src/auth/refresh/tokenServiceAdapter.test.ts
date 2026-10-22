/**
 * @file src/auth/refresh/tokenServiceAdapter.test.ts
 * @description Unit tests for JwtTokenServiceAdapter.
 */

import { JwtTokenServiceAdapter } from './tokenServiceAdapter';
import * as jwtLib from '../../lib/jwt';

describe('JwtTokenServiceAdapter', () => {
    let adapter: JwtTokenServiceAdapter;

    beforeEach(() => {
        adapter = new JwtTokenServiceAdapter();
    });

    it('verifies refresh token and returns mapped payload', () => {
        jest.spyOn(jwtLib, 'verifyToken').mockReturnValue({
            sub: 'user-42',
            sid: 'session-99',
            role: 'investor',
        } as any);

        const result = adapter.verifyRefreshToken('sample-jwt-token');

        expect(result).toEqual({
            userId: 'user-42',
            sessionId: 'session-99',
            role: 'investor',
        });
        expect(jwtLib.verifyToken).toHaveBeenCalledWith('sample-jwt-token');
    });

    it('issues access and refresh tokens with correct payload and TTLs', () => {
        const issueTokenSpy = jest.spyOn(jwtLib, 'issueToken');
        issueTokenSpy
            .mockReturnValueOnce('mock-access-token')
            .mockReturnValueOnce('mock-refresh-token');

        const result = adapter.issueTokens({
            userId: 'user-42',
            sessionId: 'session-99',
            role: 'investor',
        });

        expect(result).toEqual({
            accessToken: 'mock-access-token',
            refreshToken: 'mock-refresh-token',
        });
        expect(issueTokenSpy).toHaveBeenCalledWith({
            subject: 'user-42',
            expiresIn: jwtLib.TOKEN_EXPIRY,
            additionalPayload: {
                sid: 'session-99',
                role: 'investor',
            },
        });
        expect(issueTokenSpy).toHaveBeenCalledWith({
            subject: 'user-42',
            expiresIn: jwtLib.REFRESH_TOKEN_EXPIRY,
            additionalPayload: {
                sid: 'session-99',
                role: 'investor',
            },
        });
    });

    it('hashes token with sha256', () => {
        const hash1 = adapter.hashToken('my-token');
        const hash2 = adapter.hashToken('my-token');
        const hash3 = adapter.hashToken('different-token');

        expect(hash1).toMatch(/^[0-9a-f]{64}$/);
        expect(hash1).toBe(hash2);
        expect(hash1).not.toBe(hash3);
    });
});
