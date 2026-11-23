import { NextFunction, Response } from 'express';
import { createLogoutHandler } from './logoutHandler';
import { LogoutService } from './logoutService';
import { AuthenticatedRequest } from './types';

class MockResponse {
  status = jest.fn().mockReturnThis();
  json = jest.fn().mockReturnThis();
  send = jest.fn().mockReturnThis();
}

function createService(): LogoutService & { logout: jest.Mock<Promise<void>, [string]> } {
  return {
    logout: jest.fn<Promise<void>, [string]>(),
  } as unknown as LogoutService & { logout: jest.Mock<Promise<void>, [string]> };
}

function createRequest(sessionId?: string): AuthenticatedRequest {
  return {
    auth: sessionId === undefined ? undefined : { userId: 'user-1', sessionId },
  } as unknown as AuthenticatedRequest;
}

function createNext(): jest.MockedFunction<NextFunction> {
  return jest.fn();
}

describe('createLogoutHandler', () => {
  it('returns 401 without a session and does not call the service', async () => {
    const logoutService = createService();
    const handler = createLogoutHandler(logoutService);
    const response = new MockResponse();

    await handler(
      createRequest(),
      response as unknown as Response,
      createNext(),
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(logoutService.logout).not.toHaveBeenCalled();
  });

  it('logs out the session once and responds with 204', async () => {
    const logoutService = createService();
    logoutService.logout.mockResolvedValue(undefined);
    const handler = createLogoutHandler(logoutService);
    const response = new MockResponse();

    await handler(
      createRequest('session-123'),
      response as unknown as Response,
      createNext(),
    );

    expect(logoutService.logout).toHaveBeenCalledTimes(1);
    expect(logoutService.logout).toHaveBeenCalledWith('session-123');
    expect(response.status).toHaveBeenCalledWith(204);
    expect(response.send).toHaveBeenCalledTimes(1);
  });

  it('forwards service errors to next', async () => {
    const failure = new Error('logout failed');
    const logoutService = createService();
    logoutService.logout.mockRejectedValue(failure);
    const handler = createLogoutHandler(logoutService);
    const response = new MockResponse();
    const next = createNext();

    await handler(
      createRequest('session-123'),
      response as unknown as Response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(failure);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.send).not.toHaveBeenCalled();
  });
});
