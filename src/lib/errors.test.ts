import {
  AppError,
  ErrorCode,
  ErrorResponse,
  Errors,
  createError,
  sendAppError,
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
      const err = new AppError(ErrorCode.NOT_FOUND, 'thing not found', 404);
      expect(err.code).toBe(ErrorCode.NOT_FOUND);
      expect(err.message).toBe('thing not found');
      expect(err.statusCode).toBe(404);
      expect(err.details).toBeUndefined();
      expect(err.name).toBe('AppError');
    });

    it('stores optional details', () => {
      const details = { field: 'amount', reason: 'must be positive' };
      const err = new AppError(ErrorCode.VALIDATION_ERROR, 'invalid input', 400, details);
      expect(err.details).toEqual(details);
    });

    it('is an instance of Error', () => {
      const err = new AppError(ErrorCode.INTERNAL_ERROR, 'boom', 500);
      expect(err).toBeInstanceOf(Error);
    });

    it('passes instanceof AppError after transpilation', () => {
      const err = new AppError(ErrorCode.FORBIDDEN, 'no access', 403);
      expect(err).toBeInstanceOf(AppError);
    });
  });

  describe('toResponse()', () => {
    it('returns code and message without details when details is undefined', () => {
      const err = new AppError(ErrorCode.UNAUTHORIZED, 'not logged in', 401);
      const response: ErrorResponse = err.toResponse();
      expect(response).toEqual({ code: 'UNAUTHORIZED', message: 'not logged in' });
      expect(Object.hasOwn(response, 'details')).toBe(false);
    });

    it('includes details when present', () => {
      const details = { ids: ['a', 'b'] };
      const err = new AppError(ErrorCode.CONFLICT, 'duplicate', 409, details);
      expect(err.toResponse()).toEqual({
        code: 'CONFLICT',
        message: 'duplicate',
        details,
      });
    });

    it('includes details even when details is null', () => {
      const err = new AppError(ErrorCode.BAD_REQUEST, 'bad', 400, null);
      expect(err.toResponse().details).toBeNull();
    });
  });
});

// ─── createError ──────────────────────────────────────────────────────────────

describe('createError', () => {
  it('returns an AppError with the given properties', () => {
    const err = createError(ErrorCode.NOT_FOUND, 'resource missing', 404);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCode.NOT_FOUND);
    expect(err.message).toBe('resource missing');
    expect(err.statusCode).toBe(404);
  });

  it('forwards details', () => {
    const details = { resource: 'offering' };
    const err = createError(ErrorCode.NOT_FOUND, 'not found', 404, details);
    expect(err.details).toEqual(details);
  });
});

// ─── Errors convenience factories ─────────────────────────────────────────────

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

// ─── sendAppError ─────────────────────────────────────────────────────────────

describe('sendAppError', () => {
  it('calls next() with the AppError instance', () => {
    const next = jest.fn();
    const err = Errors.unauthorized();
    sendAppError(next, err);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(err);
  });

  it('does not modify the error before forwarding', () => {
    const next = jest.fn();
    const err = Errors.notFound('Offering 42 not found');
    sendAppError(next, err);
    const forwarded = next.mock.calls[0][0] as AppError;
    expect(forwarded.message).toBe('Offering 42 not found');
    expect(forwarded.statusCode).toBe(404);
  });
});
