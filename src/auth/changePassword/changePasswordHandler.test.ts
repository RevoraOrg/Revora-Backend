import { Request, Response, NextFunction } from 'express';
import { createChangePasswordHandler } from './changePasswordHandler';
import { ChangePasswordService, ChangePasswordError } from './changePasswordService';
import { AuthenticatedRequest } from './types';

// ── helpers ──────────────────────────────────────────────────────────────────

const mockRes = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return res;
};

const mockNext: NextFunction = jest.fn();

const makeReq = (
  body: unknown,
  userId?: string
): AuthenticatedRequest => {
  return {
    auth: userId ? { userId, sessionId: 'session-1' } : undefined,
    body,
  } as AuthenticatedRequest;
};

// ── mocks ─────────────────────────────────────────────────────────────────────

jest.mock('./changePasswordService');

const MockedService = ChangePasswordService as jest.MockedClass<typeof ChangePasswordService>;

// ── tests ─────────────────────────────────────────────────────────────────────

describe('createChangePasswordHandler', () => {
  let service: jest.Mocked<ChangePasswordService>;
  let handler: ReturnType<typeof createChangePasswordHandler>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MockedService({} as any) as jest.Mocked<ChangePasswordService>;
    handler = createChangePasswordHandler(service);
  });

  it('returns 401 when req.auth is missing', async () => {
    const req = makeReq({ currentPassword: 'old', newPassword: 'newPassword1' });
    const res = mockRes();

    await handler(req as Request, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(service.changePassword).not.toHaveBeenCalled();
  });

  it('returns 400 when body is missing currentPassword', async () => {
    const req = makeReq({ newPassword: 'newPassword1' }, 'user-123');
    const res = mockRes();

    await handler(req as Request, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Invalid') })
    );
  });

  it('returns 400 when newPassword is shorter than 8 chars', async () => {
    const req = makeReq({ currentPassword: 'old', newPassword: 'short' }, 'user-123');
    const res = mockRes();

    await handler(req as Request, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when body is empty', async () => {
    const req = makeReq({}, 'user-123');
    const res = mockRes();

    await handler(req as Request, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 200 on success', async () => {
    service.changePassword.mockResolvedValueOnce(undefined);

    const req = makeReq(
      { currentPassword: 'currentPass1', newPassword: 'newPassword1' },
      'user-123'
    );
    const res = mockRes();

    await handler(req as Request, res, mockNext);

    expect(service.changePassword).toHaveBeenCalledWith(
      'user-123',
      'session-1',
      'currentPass1',
      'newPassword1'
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: 'Password changed successfully' });
  });

  it('returns 401 when service throws ChangePasswordError with status 401', async () => {
    service.changePassword.mockRejectedValueOnce(
      new ChangePasswordError('Current password is incorrect', 401)
    );

    const req = makeReq(
      { currentPassword: 'wrong', newPassword: 'newPassword1' },
      'user-123'
    );
    const res = mockRes();

    await handler(req as Request, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Current password is incorrect' });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('returns 404 when service throws ChangePasswordError with status 404', async () => {
    service.changePassword.mockRejectedValueOnce(
      new ChangePasswordError('User not found', 404)
    );

    const req = makeReq(
      { currentPassword: 'pass', newPassword: 'newPassword1' },
      'user-123'
    );
    const res = mockRes();

    await handler(req as Request, res, mockNext);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
  });

  it('calls next() for unexpected errors', async () => {
    const unexpectedError = new Error('DB connection lost');
    service.changePassword.mockRejectedValueOnce(unexpectedError);

    const req = makeReq(
      { currentPassword: 'pass', newPassword: 'newPassword1' },
      'user-123'
    );
    const res = mockRes();

    await handler(req as Request, res, mockNext);

    expect(mockNext).toHaveBeenCalledWith(unexpectedError);
  });
});