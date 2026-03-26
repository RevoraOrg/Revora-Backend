import { RefreshService } from './refreshService';
import { RefreshTokenRepository, TokenService, RefreshTokenPayload } from './types';

describe('RefreshService', () => {
    let refreshService: RefreshService;
    let mockRepo: jest.Mocked<RefreshTokenRepository>;
    let mockTokenService: jest.Mocked<TokenService>;

    beforeEach(() => {
        mockRepo = {
            findSessionById: jest.fn(),
            createSession: jest.fn(),
            revokeSessionAndDescendants: jest.fn(),
            findSessionByParentId: jest.fn(),
        };
        mockTokenService = {
            verifyRefreshToken: jest.fn(),
            issueTokens: jest.fn(),
            hashToken: jest.fn(),
        };
        refreshService = new RefreshService(mockRepo, mockTokenService);
    });

    const mockPayload: RefreshTokenPayload = {
        userId: 'user-123',
        sessionId: 'session-123',
        role: 'investor',
    };

    const mockTokens = {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
    };

    it('should rotate tokens successfully', async () => {
        mockTokenService.verifyRefreshToken.mockReturnValue(mockPayload);
        mockRepo.findSessionById.mockResolvedValue({ id: 'session-123', revoked_at: null });
        mockRepo.findSessionByParentId.mockResolvedValue(null);
        mockTokenService.issueTokens.mockReturnValue(mockTokens);
        mockTokenService.hashToken.mockReturnValue('new-hash');
        mockRepo.createSession.mockResolvedValue({ id: 'new-session-id' });

        const result = await refreshService.refresh('old-token');

        expect(result).toEqual(mockTokens);
        expect(mockRepo.createSession).toHaveBeenCalled();
        expect(mockRepo.revokeSessionAndDescendants).not.toHaveBeenCalled();
    });

    it('should revoke session and descendants if token is reused (already has child)', async () => {
        mockTokenService.verifyRefreshToken.mockReturnValue(mockPayload);
        mockRepo.findSessionById.mockResolvedValue({ id: 'session-123', revoked_at: null });
        mockRepo.findSessionByParentId.mockResolvedValue({ id: 'child-session-id' });

        const result = await refreshService.refresh('reused-token');

        expect(result).toBeNull();
        expect(mockRepo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-123');
    });

    it('should revoke session and descendants if session is already revoked', async () => {
        mockTokenService.verifyRefreshToken.mockReturnValue(mockPayload);
        mockRepo.findSessionById.mockResolvedValue({ id: 'session-123', revoked_at: new Date() });

        const result = await refreshService.refresh('revoked-token');

        expect(result).toBeNull();
        expect(mockRepo.revokeSessionAndDescendants).toHaveBeenCalledWith('session-123');
    });

    it('should return null if token verification fails', async () => {
        mockTokenService.verifyRefreshToken.mockImplementation(() => {
            throw new Error('Invalid token');
        });

        const result = await refreshService.refresh('invalid-token');

        expect(result).toBeNull();
    });

    it('should return null if session is not found', async () => {
        mockTokenService.verifyRefreshToken.mockReturnValue(mockPayload);
        mockRepo.findSessionById.mockResolvedValue(null);

        const result = await refreshService.refresh('unknown-token');

        expect(result).toBeNull();
    });
});
