import { createChangePasswordHandler } from './changePasswordHandler';
import { ChangePasswordService } from './changePasswordService';
import { AppError, ErrorCode } from '../../lib/errors';

// ── Helpers ───────────────────────────────────────────────────────────────────
function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

function mockReq(overrides: object = {}): any {
  return {
    user: { id: 'user-abc' },
    body: { currentPassword: 'old-pw-12345', newPassword: 'new-pw-67890' },
    ...overrides,
  };
}

function mockService(result: any): ChangePasswordService {
  const execute = jest.fn();
  if (result.ok) {
    execute.mockResolvedValue(result);
  } else {
    let err: AppError;
    switch (result.reason) {
      case 'VALIDATION_ERROR':
        err = new AppError(ErrorCode.VALIDATION_ERROR, result.message, 400);
        break;
      case 'WRONG_PASSWORD':
        err = new AppError(ErrorCode.UNAUTHORIZED, result.message, 401);
        break;
      case 'USER_NOT_FOUND':
        err = new AppError(ErrorCode.NOT_FOUND, result.message, 404);
        break;
      default:
        err = new AppError(ErrorCode.INTERNAL_ERROR, 'Unknown', 500);
    }
    execute.mockRejectedValue(err);
  }
  return { execute } as unknown as ChangePasswordService;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('createChangePasswordHandler', () => {
  it('returns 200 when service resolves ok:true', async () => {
    const handler = createChangePasswordHandler(mockService({ ok: true }));
    const res = mockRes();

    await handler(mockReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, message: 'Password updated successfully' });
  });

  it('calls next(AppError) with 401 when req.user is absent', async () => {
    const svc = mockService({ ok: true });
    const handler = createChangePasswordHandler(svc);
    const res = mockRes();
    const next = jest.fn();

    await handler(mockReq({ user: undefined }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(401);
    expect((svc.execute as jest.Mock)).not.toHaveBeenCalled();
  });

  it('calls next(AppError) with 400 when body fields are missing', async () => {
    const svc = mockService({ ok: true });
    const handler = createChangePasswordHandler(svc);
    const res = mockRes();
    const next = jest.fn();

    await handler(mockReq({ body: {} }), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect((svc.execute as jest.Mock)).not.toHaveBeenCalled();
  });

  it('calls next(AppError) on VALIDATION_ERROR from service', async () => {
    const handler = createChangePasswordHandler(
      mockService({ ok: false, reason: 'VALIDATION_ERROR', message: 'too short' }),
    );
    const res = mockRes();
    const next = jest.fn();
    await handler(mockReq(), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  it('calls next(AppError) on WRONG_PASSWORD from service', async () => {
    const handler = createChangePasswordHandler(
      mockService({ ok: false, reason: 'WRONG_PASSWORD', message: 'wrong' }),
    );
    const res = mockRes();
    const next = jest.fn();
    await handler(mockReq(), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(401);
  });

  it('calls next(AppError) on USER_NOT_FOUND from service', async () => {
    const handler = createChangePasswordHandler(
      mockService({ ok: false, reason: 'USER_NOT_FOUND', message: 'not found' }),
    );
    const res = mockRes();
    const next = jest.fn();
    await handler(mockReq(), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(next.mock.calls[0][0].statusCode).toBe(404);
  });

  it('calls next(err) on unexpected exception from service', async () => {
    const boom = new Error('db exploded');
    const svc = { execute: jest.fn().mockRejectedValue(boom) } as unknown as ChangePasswordService;
    const handler = createChangePasswordHandler(svc);
    const next = jest.fn();
    const res = mockRes();

    await handler(mockReq(), res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});