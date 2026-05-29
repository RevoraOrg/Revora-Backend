import { createRegisterHandler } from './registerHandler';
import { RegisterService, DuplicateEmailError } from './registerService';
import { RegisteredUser } from './types';

class MockRegisterService {
  result: RegisteredUser | null = null;
  shouldThrow: any = null;

  async register(_email: string, _password: string): Promise<RegisteredUser> {
    if (this.shouldThrow) throw this.shouldThrow;
    return this.result!;
  }
}

function makeReq(body: any = {}) {
  return { body } as any;
}

function makeRes() {
  let statusCode = 200;
  let jsonData: any = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: any) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; },
  } as any;
}

function makeUser(overrides: Partial<RegisteredUser> = {}): RegisteredUser {
  return {
    id: 'user-1',
    email: 'investor@example.com',
    role: 'investor',
    created_at: new Date('2024-01-01'),
    ...overrides,
  };
}

describe('RegisterHandler', () => {
  it('returns 201 on successful registration', async () => {
    const svc = new MockRegisterService();
    svc.result = makeUser();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'investor@example.com', password: 'secret123' }), res, (e: any) => { throw e; });
    const { statusCode, jsonData } = res._get();
    expect(statusCode).toBe(201);
    expect(jsonData.user.id).toBe('user-1');
  });

  it('rejects missing email with 400', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ password: 'password1' }), res, (e: any) => { throw e; });
    expect(res._get().statusCode).toBe(400);
  });

  it('rejects invalid email format with 400', async () => {
    const svc = new MockRegisterService();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'notanemail', password: 'password1' }), res, (e: any) => { throw e; });
    expect(res._get().statusCode).toBe(400);
  });

  it('returns 409 when email is already taken', async () => {
    const svc = new MockRegisterService();
    svc.shouldThrow = new DuplicateEmailError();
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    const res = makeRes();
    await handler(makeReq({ email: 'taken@example.com', password: 'password1' }), res, (e: any) => { throw e; });
    expect(res._get().statusCode).toBe(409);
  });

  it('forwards unexpected errors to next()', async () => {
    const svc = new MockRegisterService();
    svc.shouldThrow = new Error('unexpected failure');
    const handler = createRegisterHandler(svc as unknown as RegisterService);
    let capturedErr: any = null;
    const res = makeRes();
    await handler(makeReq({ email: 'investor@example.com', password: 'password1' }), res, (e: any) => { capturedErr = e; });
    expect(capturedErr.message).toBe('unexpected failure');
  });
});
