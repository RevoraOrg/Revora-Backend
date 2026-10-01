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
    // Mirror the production service: domain failures are RETURNED as
    // { ok: false, reason }, not thrown. The handler must translate them.
    execute.mockResolvedValue(result);
  }
  return { execute } as unknown as ChangePasswordService;
}

/** Rejection-style mock kept for tests that assert unexpected exceptions. */
function mockRejectingService(err: unknown): ChangePasswordService {
  const execute = jest.fn().mockRejectedValue(err);
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

  it('maps VALIDATION_ERROR result to next(AppError) 400 VALIDATION_ERROR', async () => {
    const handler = createChangePasswordHandler(
      mockService({ ok: false, reason: 'VALIDATION_ERROR', message: 'too short' }),
    );
    const res = mockRes();
    const next = jest.fn();
    await handler(mockReq(), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = next.mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('maps WRONG_PASSWORD result to next(AppError) 401 UNAUTHORIZED', async () => {
    const handler = createChangePasswordHandler(
      mockService({ ok: false, reason: 'WRONG_PASSWORD', message: 'Current password is incorrect.' }),
    );
    const res = mockRes();
    const next = jest.fn();
    await handler(mockReq(), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = next.mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('maps USER_NOT_FOUND result to next(AppError) 404 NOT_FOUND', async () => {
    const handler = createChangePasswordHandler(
      mockService({ ok: false, reason: 'USER_NOT_FOUND', message: 'User not found.' }),
    );
    const res = mockRes();
    const next = jest.fn();
    await handler(mockReq(), res, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = next.mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('calls next(err) on unexpected exception from service', async () => {
    const boom = new Error('db exploded');
    const svc = mockRejectingService(boom);
    const handler = createChangePasswordHandler(svc);
    const next = jest.fn();
    const res = mockRes();

    await handler(mockReq(), res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});