import {
  AppError,
  ErrorCode,
  ErrorResponse,
  Errors,
  throwError,
} from './errors';

// ─── ErrorCode ────────────────────────────────────────────────────────────────

describe('ErrorCode', () => {
  it('exposes all expected codes', () => {
    expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ErrorCode.BAD_REQUEST).toBe('BAD_REQUEST');
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCode.FORBIDDEN).toBe('FORBIDDEN');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.CONFLICT).toBe('CONFLICT');
    expect(ErrorCode.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
  });
});

// ─── AppError ─────────────────────────────────────────────────────────────────

describe('AppError', () => {
  describe('constructor', () => {
    it('sets all properties', () => {
      const err = new AppError(ErrorCode.NOT_FOUND, 404, 'thing not found');
      expect(err.code).toBe(ErrorCode.NOT_FOUND);
      expect(err.message).toBe('thing not found');
      expect(err.statusCode).toBe(404);
      expect(err.details).toBeUndefined();
      expect(err.name).toBe('AppError');
    });

    it('stores optional details', () => {
      const details = { field: 'amount', reason: 'must be positive' };
      const err = new AppError(ErrorCode.VALIDATION_ERROR, 400, 'invalid input', details);
      expect(err.details).toEqual(details);
    });

    it('is an instance of Error', () => {
      const err = new AppError(ErrorCode.INTERNAL_ERROR, 500, 'boom');
      expect(err).toBeInstanceOf(Error);
    });

    it('passes instanceof AppError after transpilation', () => {
      const err = new AppError(ErrorCode.FORBIDDEN, 403, 'no access');
      expect(err).toBeInstanceOf(AppError);
    });
  });

  describe('toResponse()', () => {
    it('returns code and message without details when details is undefined', () => {
      const err = new AppError(ErrorCode.UNAUTHORIZED, 401, 'not logged in');
      const response: ErrorResponse = err.toResponse();
      expect(response).toEqual({ code: 'UNAUTHORIZED', message: 'not logged in' });
      expect(Object.prototype.hasOwnProperty.call(response, 'details')).toBe(false);
    });

    it('includes details when present', () => {
      const details = { ids: ['a', 'b'] };
      const err = new AppError(ErrorCode.CONFLICT, 409, 'duplicate', details);
      expect(err.toResponse()).toEqual({
        code: 'CONFLICT',
        message: 'duplicate',
        details,
      });
    });

    it('includes details even when details is null', () => {
      const err = new AppError(ErrorCode.BAD_REQUEST, 400, 'bad', null);
      expect(err.toResponse().details).toBeNull();
    });
  });
});

// ─── Errors convenience factories ─────────────────────────────────────────────
// (The internal `createError` helper is exercised indirectly through every
// factory below; it is not part of the public API.)

describe('Errors', () => {
  describe('validationError', () => {
    it('creates a 400 VALIDATION_ERROR', () => {
      const err = Errors.validationError('limit must be > 0', { field: 'limit' });
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(err.message).toBe('limit must be > 0');
      expect(err.details).toEqual({ field: 'limit' });
    });
  });

  describe('badRequest', () => {
    it('creates a 400 BAD_REQUEST', () => {
      const err = Errors.badRequest('malformed body');
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe(ErrorCode.BAD_REQUEST);
    });
  });

  describe('unauthorized', () => {
    it('uses default message', () => {
      const err = Errors.unauthorized();
      expect(err.statusCode).toBe(401);
      expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
      expect(err.message).toBe('Unauthorized');
    });

    it('accepts a custom message', () => {
      const err = Errors.unauthorized('Token expired');
      expect(err.message).toBe('Token expired');
    });
  });

  describe('forbidden', () => {
    it('uses default message', () => {
      const err = Errors.forbidden();
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe(ErrorCode.FORBIDDEN);
      expect(err.message).toBe('Forbidden');
    });

    it('accepts a custom message', () => {
      const err = Errors.forbidden('investor role required');
      expect(err.message).toBe('investor role required');
    });
  });

  describe('notFound', () => {
    it('creates a 404 NOT_FOUND', () => {
      const err = Errors.notFound('Offering not found');
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe(ErrorCode.NOT_FOUND);
      expect(err.message).toBe('Offering not found');
    });
  });

  describe('conflict', () => {
    it('creates a 409 CONFLICT', () => {
      const err = Errors.conflict('investor already exists');
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe(ErrorCode.CONFLICT);
    });
  });

  describe('internal', () => {
    it('uses default message', () => {
      const err = Errors.internal();
      expect(err.statusCode).toBe(500);
      expect(err.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(err.message).toBe('Internal server error');
    });

    it('accepts a custom message and details', () => {
      const err = Errors.internal('db unreachable', { host: 'localhost' });
      expect(err.message).toBe('db unreachable');
      expect(err.details).toEqual({ host: 'localhost' });
    });
  });
});

// ─── throwError ───────────────────────────────────────────────────────────────

describe('throwError', () => {
  it('throws an AppError with the correct shape', () => {
    expect(() =>
      throwError(ErrorCode.NOT_FOUND, 'missing resource', 404)
    ).toThrow(AppError);
  });

  it('thrown error has the right code and statusCode', () => {
    try {
      throwError(ErrorCode.FORBIDDEN, 'no access', 403, { reason: 'role' });
      fail('expected throwError to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe(ErrorCode.FORBIDDEN);
      expect(appErr.statusCode).toBe(403);
      expect(appErr.details).toEqual({ reason: 'role' });
    }
  });
});

// ─── Error forwarding via the Express error handler ───────────────────────────
// The `errorHandler` middleware (src/middleware/errorHandler.ts) is responsible
// for translating AppErrors into HTTP responses; handlers forward errors to
// `next(err)` and the middleware reads `statusCode`/`message`/`toResponse()`.

describe('AppError contract consumed by the error handler', () => {
  it('produces a response whose code and message match the constructor args', () => {
    const err = Errors.notFound('Offering 42 not found');
    const response = err.toResponse();
    expect(response.code).toBe(ErrorCode.NOT_FOUND);
    expect(response.message).toBe('Offering 42 not found');
    expect(err.statusCode).toBe(404);
  });
});
