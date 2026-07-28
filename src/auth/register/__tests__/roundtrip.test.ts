/**
 * Round-trip unit tests for the registration flow.
 *
 * Covers:
 *  - Req 7.7: first registration succeeds (201), second with same email (after
 *    normalisation) returns 409.
 *  - Req 3.3: `instanceof UniqueConstraintError` is `true` after the error
 *    crosses a module boundary (verifies `Object.setPrototypeOf` fix).
 *  - Req 5.1: missing / null / undefined request body returns HTTP 400.
 */

import { AppError, ErrorCode, UniqueConstraintError } from '../../../lib/errors';
import { createRegisterHandler } from '../registerHandler';
import { RegisterService, DuplicateEmailError } from '../registerService';
import { IUserRepository, RegisteredUser } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(body: unknown) {
  return { body } as any;
}

function makeRes() {
  let statusCode = 200;
  let jsonData: unknown = null;
  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(obj: unknown) {
      jsonData = obj;
      return this;
    },
    _get() {
      return { statusCode, jsonData };
    },
  } as any;
}

function makeNext() {
  return jest.fn() as jest.Mock;
}

// ─── In-memory fake repository ────────────────────────────────────────────────

class FakeUserRepository implements IUserRepository {
  private users: Map<string, RegisteredUser & { password_hash: string }> = new Map();

  async findByEmail(email: string) {
    return this.users.get(email) ?? null;
  }

  async createUser(input: {
    email: string;
    password_hash: string;
    role: 'investor';
  }): Promise<RegisteredUser> {
    const user: RegisteredUser & { password_hash: string } = {
      id: `user-${this.users.size + 1}`,
      email: input.email,
      role: input.role,
      password_hash: input.password_hash,
      created_at: new Date(),
    };
    this.users.set(input.email, user);
    return user;
  }
}

// ─── Req 7.7: Round-trip test ─────────────────────────────────────────────────

describe('Round-trip registration (Req 7.7)', () => {
  it('accepts the first registration and rejects a second with the same email (after normalisation) with 409', async () => {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    const handler = createRegisterHandler(svc);

    // First registration – should succeed with 201
    const res1 = makeRes();
    const next1 = makeNext();
    await handler(
      makeReq({ email: 'Alice@Example.COM', password: 'ValidPass!934X' }),
      res1,
      next1,
    );
    expect(res1._get().statusCode).toBe(201);
    expect((res1._get().jsonData as any).user.email).toBe('alice@example.com');
    expect(next1).not.toHaveBeenCalled();

    // Second registration with the same email (different casing) – should return 409 via next(AppError)
    const res2 = makeRes();
    const next2 = makeNext();
    await handler(
      makeReq({ email: 'alice@example.com', password: 'Different!Pass55' }),
      res2,
      next2,
    );
    expect(next2).toHaveBeenCalledWith(expect.any(AppError));
    const err = next2.mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe(ErrorCode.CONFLICT);
    expect(err.message).toBe('Email already registered');
  });

  it('treats mixed-case variants of the same email as duplicates', async () => {
    const repo = new FakeUserRepository();
    const svc = new RegisterService(repo);
    const handler = createRegisterHandler(svc);

    const res1 = makeRes();
    const next1 = makeNext();
    await handler(
      makeReq({ email: 'USER@DOMAIN.COM', password: 'ValidPass!934X' }),
      res1,
      next1,
    );
    expect(res1._get().statusCode).toBe(201);

    const res2 = makeRes();
    const next2 = makeNext();
    await handler(
      makeReq({ email: 'user@domain.com', password: 'Another!Pass77' }),
      res2,
      next2,
    );
    expect(next2).toHaveBeenCalledWith(expect.any(AppError));
    expect((next2.mock.calls[0][0] as AppError).statusCode).toBe(409);
  });
});

// ─── Req 3.3: instanceof UniqueConstraintError across module boundary ─────────

/**
 * Verifies that `Object.setPrototypeOf` in the UniqueConstraintError constructor
 * correctly restores the prototype chain after TypeScript transpiles `extends Error`.
 * The error is constructed, passed through a function boundary, and then checked.
 */
describe('instanceof UniqueConstraintError across module boundary (Req 3.3)', () => {
  // Simulate crossing a module boundary by passing through a plain function
  function passThrough(err: unknown): unknown {
    return err;
  }

  it('instanceof UniqueConstraintError is true after crossing a function boundary', () => {
    const err = new UniqueConstraintError('email');
    const received = passThrough(err);
    expect(received instanceof UniqueConstraintError).toBe(true);
  });

  it('instanceof UniqueConstraintError is true when caught as Error', () => {
    let caught: unknown;
    try {
      throw new UniqueConstraintError('email');
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof UniqueConstraintError).toBe(true);
    expect(caught instanceof Error).toBe(true);
  });

  it('has correct name, field, and message properties', () => {
    const err = new UniqueConstraintError('email');
    expect(err.name).toBe('UniqueConstraintError');
    expect(err.field).toBe('email');
    expect(err.message).toBe('Duplicate value for field: email');
  });
});

// ─── Req 5.1: null / undefined request body returns 400 ──────────────────────

describe('RegisterHandler – null/undefined body returns 400 (Req 5.1)', () => {
  // Use a service that should never be called for these cases
  function makeNeverCalledService(): RegisterService {
    return {
      register: jest.fn().mockRejectedValue(new Error('register should not be called')),
    } as unknown as RegisterService;
  }

  it('returns 400 when req.body is null', async () => {
    const handler = createRegisterHandler(makeNeverCalledService());
    const res = makeRes();
    const next = makeNext();

    await handler(makeReq(null), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(400);
    expect((next.mock.calls[0][0] as AppError).code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('returns 400 when req.body is undefined', async () => {
    const handler = createRegisterHandler(makeNeverCalledService());
    const res = makeRes();
    const next = makeNext();

    await handler(makeReq(undefined), res, next);

    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(400);
    expect((next.mock.calls[0][0] as AppError).code).toBe(ErrorCode.BAD_REQUEST);
  });
});

