import { Request, Response, NextFunction } from 'express';
import { errorHandler } from './errorHandler';
import { AppError, ErrorCode, Errors } from '../lib/errors';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockRes(): jest.Mocked<Response> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Response>;
}

const req = {} as Request;
const next = jest.fn() as unknown as NextFunction;

// ─── errorHandler ─────────────────────────────────────────────────────────────

describe('errorHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── AppError handling ──────────────────────────────────────────────────────

  it('sends the AppError status code', () => {
    const res = makeMockRes();
    errorHandler(Errors.notFound('Offering 99 not found'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('sends the structured error body for AppError', () => {
    const res = makeMockRes();
    errorHandler(Errors.unauthorized('Token expired'), req, res, next);
    expect(res.json).toHaveBeenCalledWith({
      code: ErrorCode.UNAUTHORIZED,
      message: 'Token expired',
    });
  });

  it('includes details in the body when AppError has them', () => {
    const res = makeMockRes();
    const err = Errors.validationError('bad input', { field: 'amount' });
    errorHandler(err, req, res, next);
    expect(res.json).toHaveBeenCalledWith({
      code: ErrorCode.VALIDATION_ERROR,
      message: 'bad input',
      details: { field: 'amount' },
    });
  });

  it('handles all AppError status codes correctly', () => {
    const cases: [AppError, number][] = [
      [Errors.badRequest('x'), 400],
      [Errors.unauthorized(), 401],
      [Errors.forbidden(), 403],
      [Errors.notFound('x'), 404],
      [Errors.conflict('x'), 409],
      [Errors.internal(), 500],
    ];

    for (const [err, expectedStatus] of cases) {
      const res = makeMockRes();
      errorHandler(err, req, res, next);
      expect(res.status).toHaveBeenCalledWith(expectedStatus);
    }
  });

  it('does not call next() for AppError', () => {
    const res = makeMockRes();
    errorHandler(Errors.forbidden(), req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  // ── Unknown error handling ─────────────────────────────────────────────────

  it('returns 500 for a plain Error', () => {
    const res = makeMockRes();
    errorHandler(new Error('something exploded'), req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    });
  });

  it('returns 500 for a thrown string', () => {
    const res = makeMockRes();
    errorHandler('oops', req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    });
  });

  it('returns 500 for null', () => {
    const res = makeMockRes();
    errorHandler(null, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('does not leak error internals for unknown errors', () => {
    const res = makeMockRes();
    errorHandler(new Error('secret db password in stack'), req, res, next);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.message).toBe('Internal server error');
    expect(body.details).toBeUndefined();
  });

  it('does not call next() for unknown errors', () => {
    const res = makeMockRes();
    errorHandler(new Error('random'), req, res, next);
    expect(next).not.toHaveBeenCalled();
  });

  // ── AppError created via createError ──────────────────────────────────────

  it('handles AppError created via createError factory', () => {
    const res = makeMockRes();
    const err = new AppError(ErrorCode.CONFLICT, 'already exists', 409, { id: 'abc' });
    errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      code: 'CONFLICT',
      message: 'already exists',
      details: { id: 'abc' },
    });
  });
});
