import assert from 'assert';
import { createUserHandler } from './users';

// ---------------------------------------------------------------------------
// Minimal mock helpers — no supertest, no extra packages needed
// ---------------------------------------------------------------------------

class MockUserRepo {
  constructor(private row: any | null) { }
  async findUserById(_id: string) {
    return this.row;
  }
}

function makeReq(user: any): any {
  return { user };
}

function makeRes(): any {
  let statusCode = 200;
  let jsonData: any = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: any) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const sampleRow = {
  id: 'mock-uuid-123',
  email: 'dev@revora.org',
  name: 'Dayo Developer',
  role: 'admin',
  created_at: '2026-02-25T00:00:00Z',
  password_hash: 'SHOULD_NOT_BE_RETURNED',
};

describe('GET /api/users/me handler', () => {
  it('returns 200 with the user profile and no sensitive fields', async () => {
    const handler = createUserHandler(new MockUserRepo(sampleRow) as any);
    const req = makeReq({ id: 'mock-uuid-123', role: 'admin' });
    const res = makeRes();
    const errStore: { err?: any } = {};

    await handler(req, res, (e: any) => { errStore.err = e; });

    const { statusCode, jsonData } = res._get();
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(jsonData.id, 'mock-uuid-123');
    assert.strictEqual(jsonData.email, 'dev@revora.org');
    assert.strictEqual(jsonData.name, 'Dayo Developer');
    assert.strictEqual(jsonData.role, 'admin');
    assert.strictEqual(jsonData.created_at, '2026-02-25T00:00:00Z');
    // Sensitive fields must be stripped
    assert.strictEqual(jsonData.password_hash, undefined);
    assert.strictEqual(jsonData.password, undefined);
    assert.strictEqual(errStore.err, undefined);
  });

  it('returns 401 when no authenticated user is on the request', async () => {
    const handler = createUserHandler(new MockUserRepo(sampleRow) as any);
    const req = makeReq(undefined); // simulates missing/invalid JWT
    const res = makeRes();

    await handler(req, res, (e: any) => { throw e; });

    const { statusCode } = res._get();
    assert.strictEqual(statusCode, 401);
  });

  it('returns 404 when the user id does not exist in the database', async () => {
    const handler = createUserHandler(new MockUserRepo(null) as any);
    const req = makeReq({ id: 'ghost-id', role: 'investor' });
    const res = makeRes();

    await handler(req, res, (e: any) => { throw e; });

    const { statusCode } = res._get();
    assert.strictEqual(statusCode, 404);
  });

  it('forwards repository errors to next()', async () => {
    const bustedRepo = {
      findUserById: async () => { throw new Error('DB error'); },
    };
    const handler = createUserHandler(bustedRepo as any);
    const req = makeReq({ id: 'mock-uuid-123', role: 'investor' });
    const res = makeRes();
    const errStore: { err?: any } = {};

    await handler(req, res, (e: any) => { errStore.err = e; });

    assert.ok(errStore.err instanceof Error, 'error should be forwarded via next()');
    assert.strictEqual(errStore.err.message, 'DB error');
  });
});