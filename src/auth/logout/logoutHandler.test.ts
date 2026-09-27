import { Request, Response, NextFunction } from 'express';
import { createLogoutHandler } from './logoutHandler';
import { LogoutService } from './logoutService';
import { AuthenticatedRequest } from './types';

describe('createLogoutHandler', () => {
  let mockLogoutService: jest.Mocked<LogoutService>;
  let req: Partial<AuthenticatedRequest>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    mockLogoutService = {
      logout: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<LogoutService>;

    req = {};
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };
    next = jest.fn();
  });

  it('should return 401 Unauthorized if sessionId is missing', async () => {
    const handler = createLogoutHandler(mockLogoutService);

    await handler(req as AuthenticatedRequest, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(mockLogoutService.logout).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 401 Unauthorized if auth object is present but sessionId is missing', async () => {
    req.auth = {} as any;
    const handler = createLogoutHandler(mockLogoutService);

    await handler(req as AuthenticatedRequest, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(mockLogoutService.logout).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should call logoutService.logout and return 204 if sessionId is provided', async () => {
    req.auth = { sessionId: 'test-session-id' } as any;
    const handler = createLogoutHandler(mockLogoutService);

    await handler(req as AuthenticatedRequest, res as Response, next);

    expect(mockLogoutService.logout).toHaveBeenCalledWith('test-session-id');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('should call next with error if logoutService.logout throws', async () => {
    req.auth = { sessionId: 'test-session-id' } as any;
    const error = new Error('Logout failed');
    mockLogoutService.logout.mockRejectedValueOnce(error);

    const handler = createLogoutHandler(mockLogoutService);

    await handler(req as AuthenticatedRequest, res as Response, next);

    expect(mockLogoutService.logout).toHaveBeenCalledWith('test-session-id');
    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });
});
