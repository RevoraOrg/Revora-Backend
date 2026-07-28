import { NextFunction, Request, Response } from 'express';
import {
  AppError,
  ErrorCode,
  Errors,
  createError,
  sendAppError,
  throwError,
} from '../lib/errors';
import {
  createStructuredErrorLogEntry,
  errorHandler,
  mapUnknownErrorToAppError,
} from './errorHandler';
import { globalLogger } from '../lib/logger';

// Mock the global logger
jest.mock('../lib/logger', () => ({
  globalLogger: {
    warn: jest.fn(),
    error: jest.fn(),
    critical: jest.fn(),
    info: jest.fn(),
  },
}));

function makeReq(requestId?: string, path: string = '/test', method: string = 'GET'): Request {
  return { requestId, path, method } as Request;
}

function makeRes(): jest.Mocked<Pick<Response, 'status' | 'json'>> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Pick<Response, 'status' | 'json'>>;
}

describe('lib/errors', () => {
  it('creates structured AppError responses with request ids', () => {
    const err = createError(ErrorCode.BAD_REQUEST, 'bad input', 400, { field: 'email' });
    expect(err.toResponse('rid-1')).toEqual({
      code: ErrorCode.BAD_REQUEST,
      message: 'bad input',
      details: { field: 'email' },
      requestId: 'rid-1',
    });
  });

  it('exposes convenience factories with the expected codes', () => {
    expect(Errors.badRequest('bad').code).toBe(ErrorCode.BAD_REQUEST);
    expect(Errors.unauthorized().code).toBe(ErrorCode.UNAUTHORIZED);
    expect(Errors.forbidden().code).toBe(ErrorCode.FORBIDDEN);
    expect(Errors.notFound().code).toBe(ErrorCode.NOT_FOUND);
    expect(Errors.conflict('dup').code).toBe(ErrorCode.CONFLICT);
    expect(Errors.serviceUnavailable().code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(Errors.internal().code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(Errors.internal().expose).toBe(false);
  });

  it('throws AppError via throwError helper', () => {
    expect(() => {
      throwError(ErrorCode.CONFLICT, 'duplicate', 409, { id: 'x' });
    }).toThrow(AppError);
  });

  it('forwards AppError via sendAppError helper', () => {
    const next = jest.fn();
    const err = Errors.validationError('bad', { field: 'amount' });
    sendAppError(next, err);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('mapUnknownErrorToAppError', () => {
  it('returns AppError instances unchanged', () => {
    const err = Errors.forbidden('Nope');
    expect(mapUnknownErrorToAppError(err)).toBe(err);
  });

  it('sanitizes unknown errors into INTERNAL_ERROR', () => {
    const mapped = mapUnknownErrorToAppError(new Error('secret db password'));
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(mapped.statusCode).toBe(500);
    expect(mapped.message).toBe('Internal server error');
    expect(mapped.expose).toBe(false);
  });

  it('sanitizes non-Error thrown values', () => {
    const mapped = mapUnknownErrorToAppError('boom');
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(mapped.message).toBe('Internal server error');
  });
});

describe('createStructuredErrorLogEntry', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('logs structured AppError fields including details', () => {
    process.env.NODE_ENV = 'production';
    const entry = createStructuredErrorLogEntry(
      new AppError(ErrorCode.CONFLICT, 'already exists', 409, { id: 'abc' }),
      'req-1',
    );

    expect(entry).toEqual({
      type: 'error',
      requestId: 'req-1',
      code: ErrorCode.CONFLICT,
      statusCode: 409,
      message: 'already exists',
      expose: true,
      details: { id: 'abc' },
    });
  });

  it('includes stack traces for unknown errors outside production', () => {
    process.env.NODE_ENV = 'test';
    const entry = createStructuredErrorLogEntry(new Error('boom'));
    expect(entry.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(entry.stack).toContain('Error: boom');
  });

  it('omits stack traces in production', () => {
    process.env.NODE_ENV = 'production';
    const entry = createStructuredErrorLogEntry(new Error('boom'));
    expect(entry.stack).toBeUndefined();
  });
});

describe('errorHandler', () => {
  const next = jest.fn() as unknown as NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('responds with structured AppError bodies', () => {
    const res = makeRes();
    errorHandler(
      Errors.validationError('bad input', { field: 'amount' }),
      makeReq('rid-1'),
      res as unknown as Response,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      code: ErrorCode.VALIDATION_ERROR,
      message: 'bad input',
      details: { field: 'amount' },
      requestId: 'rid-1',
    });
  });

  it('sanitizes unexpected errors for clients', () => {
    const res = makeRes();
    errorHandler(new Error('secret internal failure'), makeReq(), res as unknown as Response, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'Internal server error',
    });
  });

  it('does not call next after responding', () => {
    const res = makeRes();
    errorHandler(Errors.unauthorized(), makeReq(), res as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
  });

  it('writes a structured log entry via globalLogger', () => {
    const res = makeRes();
    const error = Errors.serviceUnavailable('Dependency unavailable', { dependency: 'db' });
    errorHandler(
      error,
      makeReq('rid-2', '/ready', 'GET'),
      res as unknown as Response,
      next,
    );

    expect(globalLogger.error).toHaveBeenCalledWith('Dependency unavailable', expect.objectContaining({
      requestId: 'rid-2',
      code: ErrorCode.SERVICE_UNAVAILABLE,
      statusCode: 503,
      details: { dependency: 'db' },
      path: '/ready',
      method: 'GET',
    }));
  });

  it('logs 500 errors as error level', () => {
    const res = makeRes();
    const error = new Error('boom');
    errorHandler(
      error,
      makeReq('rid-3'),
      res as unknown as Response,
      next,
    );

    expect(globalLogger.error).toHaveBeenCalledWith('Internal server error', expect.objectContaining({
      requestId: 'rid-3',
      code: ErrorCode.INTERNAL_ERROR,
      statusCode: 500,
    }));
  });
});
