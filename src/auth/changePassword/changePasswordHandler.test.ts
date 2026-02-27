import { createChangePasswordHandler } from './changePasswordHandler';
import { ChangePasswordService } from './changePasswordService';

// ── Helpers ───────────────────────────────────────────────────────────────────
function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

function mockReq(overrides: object = {}): any {
  return {
    user: { sub: 'user-abc' },
    body: { currentPassword: 'old-pw-12345', newPassword: 'new-pw-67890' },
    ...overrides,
  };
}

function mockService(result: object): ChangePasswordService {
  return { execute: jest.fn().mockResolvedValue(result) } as unknown as ChangePasswordService;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('createChangePasswordHandler', () => {
  it('returns 200 when service resolves ok:true', async () => {
    const handler = createChangePasswordHandler(mockService({ ok: true }));
    const res = mockRes();

    await handler(mockReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ message: 'Password updated successfully.' });
  });

  it('returns 401 and does NOT call service when req.user is absent', async () => {
    const svc = mockService({ ok: true });
    const handler = createChangePasswordHandler(svc);
    const res = mockRes();

    await handler(mockReq({ user: undefined }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect((svc.execute as jest.Mock)).not.toHaveBeenCalled();
  });

  it('returns 400 and does NOT call service when body fields are missing', async () => {
    const svc = mockService({ ok: true });
    const handler = createChangePasswordHandler(svc);
    const res = mockRes();

    await handler(mockReq({ body: {} }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect((svc.execute as jest.Mock)).not.toHaveBeenCalled();
  });

  it('returns 400 on VALIDATION_ERROR from service', async () => {
    const handler = createChangePasswordHandler(
      mockService({ ok: false, reason: 'VALIDATION_ERROR', message: 'too short' }),
    );
    const res = mockRes();
    await handler(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 401 on WRONG_PASSWORD from service', async () => {
    const handler = createChangePasswordHandler(
      mockService({ ok: false, reason: 'WRONG_PASSWORD', message: 'wrong' }),
    );
    const res = mockRes();
    await handler(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 on USER_NOT_FOUND from service', async () => {
    const handler = createChangePasswordHandler(
      mockService({ ok: false, reason: 'USER_NOT_FOUND', message: 'not found' }),
    );
    const res = mockRes();
    await handler(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
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