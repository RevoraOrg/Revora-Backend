import * as fc from 'fast-check';
import { createRegisterHandler } from './registerHandler';
import { RegisterService, DuplicateEmailError } from './registerService';
import { AppError, ErrorCode, UniqueConstraintError } from '../../lib/errors';
import { RegisteredUser } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(body: unknown = {}) {
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

function makeUser(overrides: Partial<RegisteredUser> = {}): RegisteredUser {
  return {
    id: 'user-1',
    email: 'investor@example.com',
    role: 'investor',
    created_at: new Date('2024-01-01'),
    ...overrides,
  };
}

/** A valid email that passes the handler's EMAIL_RE check. */
const VALID_EMAIL = 'test@example.com';
/** A valid password that passes the minimum-length check. */
const VALID_PASSWORD = 'ValidPassword123!';

/** Email regex used by RegisterHandler – must stay in sync with the handler. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Mock service that never queries the database ─────────────────────────────

function makeNeverCalledService(): RegisterService {
  return {
    register: jest.fn().mockRejectedValue(new Error('register should not be called')),
  } as unknown as RegisterService;
}

function makeThrowingService(error: unknown): RegisterService {
  return {
    register: jest.fn().mockRejectedValue(error),
  } as unknown as RegisterService;
}

function makeSuccessService(user: RegisteredUser = makeUser()): RegisterService {
  return {
    register: jest.fn().mockResolvedValue(user),
  } as unknown as RegisterService;
}

// ─── Property 7: Invalid email format → 400 ──────────────────────────────────

// Feature: user-uniqueness-constraints, Property 7: Invalid email format returns 400 with "email" in message

/**
 * Property 7: Invalid email format returns 400 with "email" in message
 *
 * For any string that does not match the pattern `[^\s@]+@[^\s@]+\.[^\s@]+`,
 * submitting it as the `email` field must return HTTP 400 with a response body
 * whose `message` field contains the substring "email".
 *
 * Validates: Requirements 5.2
 */
describe('RegisterHandler – invalid email format → 400 (Property 7)', () => {
  it('returns 400 with "email" in message for any non-email string', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => !EMAIL_RE.test(s) && s.length > 0),
        async (invalidEmail) => {
          const svc = makeNeverCalledService();
          const handler = createRegisterHandler(svc);
          const res = makeRes();
          let capturedErr: any = null;

          await handler(
            makeReq({ email: invalidEmail, password: VALID_PASSWORD }),
            res,
            (e: unknown) => {
              capturedErr = e;
            },
          );

          expect(capturedErr instanceof AppError).toBe(true);
          expect(capturedErr.statusCode).toBe(400);
          expect(capturedErr.message).toMatch(/email/i);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 8: Short password → 400 (Handled by service now) ───────────────

/**
 * Property 8: Short password returns 400 via service validation
 *
 * Validates: Requirements 5.3
 */
describe('RegisterHandler – weak password → 400 (Property 8)', () => {
  it('returns 400 for passwords that fail service-side strength validation', async () => {
    // In our new design, the handler doesn't check password length; the service does.
    // If the service throws a validation error, the handler forwards it to next().
    const svc = makeThrowingService(new AppError(ErrorCode.VALIDATION_ERROR, 'Weak password', 400));
    const handler = createRegisterHandler(svc);
    const res = makeRes();
    let capturedErr: any = null;

    await handler(
      makeReq({ email: VALID_EMAIL, password: 'short' }),
      res,
      (e: unknown) => {
        capturedErr = e;
      },
    );

    expect(capturedErr instanceof AppError).toBe(true);
    expect(capturedErr.statusCode).toBe(400);
    expect(capturedErr.code).toBe(ErrorCode.VALIDATION_ERROR);
  });
});

// ─── Property 9: Non-string inputs → 400 ─────────────────────────────────────

// Feature: user-uniqueness-constraints, Property 9: Non-string inputs return 400

/**
 * Property 9: Non-string inputs return 400
 *
 * For any registration request where `email` or `password` is not of type
 * `string` (e.g. number, boolean, object, null), the handler must return
 * HTTP 400 without querying the database.
 *
 * Validates: Requirements 5.4
 */
describe('RegisterHandler – non-string inputs → 400 (Property 9)', () => {
  const nonStringArb = fc.oneof(
    fc.integer(),
    fc.boolean(),
    fc.object(),
    fc.constant(null),
  );

  it('returns 400 when email is a non-string value', async () => {
    await fc.assert(
      fc.asyncProperty(nonStringArb, async (nonStringEmail) => {
        const svc = makeNeverCalledService();
        const handler = createRegisterHandler(svc);
        const res = makeRes();
        let capturedErr: any = null;

        await handler(
          makeReq({ email: nonStringEmail, password: VALID_PASSWORD }),
          res,
          (e: unknown) => {
            capturedErr = e;
          },
        );

        expect(capturedErr instanceof AppError).toBe(true);
        expect(capturedErr.statusCode).toBe(400);
        // Service must not have been called
        expect((svc.register as jest.Mock).mock.calls.length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('returns 400 when password is a non-string value', async () => {
    await fc.assert(
      fc.asyncProperty(nonStringArb, async (nonStringPassword) => {
        const svc = makeNeverCalledService();
        const handler = createRegisterHandler(svc);
        const res = makeRes();
        let capturedErr: any = null;

        await handler(
          makeReq({ email: VALID_EMAIL, password: nonStringPassword }),
          res,
          (e: unknown) => {
            capturedErr = e;
          },
        );

        expect(capturedErr instanceof AppError).toBe(true);
        expect(capturedErr.statusCode).toBe(400);
        expect((svc.register as jest.Mock).mock.calls.length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Unit tests: RegisterHandler uniqueness paths (task 4.3) ─────────────────

describe('RegisterHandler – uniqueness paths (unit tests)', () => {
  // Req 7.4: returns 409 when RegisterService throws DuplicateEmailError
  it('returns 409 when RegisterService throws DuplicateEmailError', async () => {
    const svc = makeThrowingService(new DuplicateEmailError());
    const handler = createRegisterHandler(svc);
    const res = makeRes();
    let capturedErr: any = null;

    await handler(
      makeReq({ email: VALID_EMAIL, password: VALID_PASSWORD }),
      res,
      (e: unknown) => {
        capturedErr = e;
      },
    );

    expect(capturedErr instanceof AppError).toBe(true);
    expect(capturedErr.statusCode).toBe(409);
    expect(capturedErr.code).toBe(ErrorCode.CONFLICT);
    expect(capturedErr.message).toBe('Email already registered');
  });

  // Req 7.5: returns 409 when UniqueConstraintError propagates from the service layer
  it('returns 409 when UniqueConstraintError propagates from the service layer', async () => {
    const svc = makeThrowingService(new UniqueConstraintError('email'));
    const handler = createRegisterHandler(svc);
    const res = makeRes();
    let capturedErr: any = null;

    await handler(
      makeReq({ email: VALID_EMAIL, password: VALID_PASSWORD }),
      res,
      (e: unknown) => {
        capturedErr = e;
      },
    );

    expect(capturedErr instanceof AppError).toBe(true);
    expect(capturedErr.statusCode).toBe(409);
    expect(capturedErr.code).toBe(ErrorCode.CONFLICT);
    expect(capturedErr.message).toBe('Email already registered');
  });
});

