import { ChangePasswordBody, AuthContext, AuthenticatedRequest, ChangePasswordResponse } from './types';
import { Request } from 'express';

describe('changePassword types contract', () => {
  it('shapes ChangePasswordBody correctly with current and new passwords', () => {
    const body: ChangePasswordBody = {
      currentPassword: 'old-secure-password',
      newPassword: 'new-secure-password',
    };

    expect(body.currentPassword).toBe('old-secure-password');
    expect(body.newPassword).toBe('new-secure-password');
  });

  it('shapes AuthContext with userId, sessionId, and optional tokenId', () => {
    const authWithToken: AuthContext = {
      userId: 'user-123',
      sessionId: 'session-456',
      tokenId: 'token-789',
    };

    const authWithoutToken: AuthContext = {
      userId: 'user-123',
      sessionId: 'session-456',
    };

    expect(authWithToken.userId).toBe('user-123');
    expect(authWithToken.sessionId).toBe('session-456');
    expect(authWithToken.tokenId).toBe('token-789');

    expect(authWithoutToken.userId).toBe('user-123');
    expect(authWithoutToken.sessionId).toBe('session-456');
    expect(authWithoutToken.tokenId).toBeUndefined();
  });

  it('extends Express Request for AuthenticatedRequest with optional auth context', () => {
    const plainRequest = {} as Request;
    const authenticatedRequest: AuthenticatedRequest = Object.assign(plainRequest, {
      auth: {
        userId: 'user-123',
        sessionId: 'session-456',
      },
    });

    expect(authenticatedRequest.auth).toBeDefined();
    expect(authenticatedRequest.auth?.userId).toBe('user-123');

    const unauthenticatedRequest: AuthenticatedRequest = {} as Request;
    expect(unauthenticatedRequest.auth).toBeUndefined();
  });

  it('shapes ChangePasswordResponse successfully', () => {
    const response: ChangePasswordResponse = {
      message: 'Password changed successfully',
    };

    expect(response.message).toBe('Password changed successfully');
  });

  it('enforces type constraints on ChangePasswordBody and AuthContext', () => {
    // Compile-time checks / static shape validation verification via runtime structure tests
    const validBody: ChangePasswordBody = {
      currentPassword: 'curr',
      newPassword: 'new',
    };
    expect(typeof validBody.currentPassword).toBe('string');
    expect(typeof validBody.newPassword).toBe('string');

    const validContext: AuthContext = {
      userId: 'u-1',
      sessionId: 's-1',
    };
    expect(typeof validContext.userId).toBe('string');
    expect(typeof validContext.sessionId).toBe('string');
  });
});
