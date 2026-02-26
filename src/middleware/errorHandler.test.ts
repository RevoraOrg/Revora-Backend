import { NextFunction, Request, Response } from 'express';
import { AppError, errorHandler } from './errorHandler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(requestId?: string): Request {
  return { requestId } as any;
}

function makeRes(): jest.Mocked<Pick<Response, 'status' | 'json'>> & { status: jest.Mock; json: jest.Mock } {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as any;
}

const noopNext = jest.fn() as unknown as NextFunction;

// ─── AppError class ───────────────────────────────────────────────────────────

describe('AppError', () => {
  it('carries statusCode and message', () => {
    const err = new AppError(422, 'Unprocessable entity');
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe('Unprocessable entity');
    expect(err.name).toBe('AppError');
  });

  it('is an instance of Error', () => {
    const err = new AppError(400, 'Bad');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
  });

  it('has a stack trace', () => {
    const err = new AppError(500, 'oops');
    expect(err.stack).toBeDefined();
  });
});

// ─── errorHandler middleware ──────────────────────────────────────────────────

describe('errorHandler', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    process.env.NODE_ENV = originalNodeEnv;
  });

  // ── AppError handling ─────────────────────────────────────────────────────

  it('responds with AppError statusCode and message', () => {
    const err = new AppError(404, 'Offering not found');
    const res = makeRes();
    errorHandler(err, makeReq(), res as unknown as Response, noopNext);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Offering not found' }),
    );
  });

  it('handles 400 AppError', () => {
    const err = new AppError(400, 'Invalid input');
    const res = makeRes();
    errorHandler(err, makeReq(), res as unknown as Response, noopNext);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid input' }));
  });

  it('handles 403 AppError', () => {
    const err = new AppError(403, 'Forbidden');
    const res = makeRes();
    errorHandler(err, makeReq(), res as unknown as Response, noopNext);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  // ── requestId forwarding ──────────────────────────────────────────────────

  it('includes requestId in response when set on req', () => {
    const err = new AppError(400, 'Bad');
    const res = makeRes();
    errorHandler(err, makeReq('req-abc-123'), res as unknown as Response, noopNext);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-abc-123' }),
    );
  });

  it('omits requestId from response when not set on req', () => {
    const err = new AppError(400, 'Bad');
    const res = makeRes();
    errorHandler(err, makeReq(), res as unknown as Response, noopNext);

    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(body.requestId).toBeUndefined();
  });

  // ── Unknown errors ────────────────────────────────────────────────────────

  it('returns 500 for plain Error in production and hides message', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('pg: password authentication failed for user "admin"');
    const res = makeRes();
    errorHandler(err, makeReq(), res as unknown as Response, noopNext);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(body.error).toBe('Internal Server Error');
    expect(body.error).not.toContain('authentication failed');
  });

  it('exposes plain Error message in non-production to aid debugging', () => {
    process.env.NODE_ENV = 'development';
    const err = new Error('connection refused');
    const res = makeRes();
    errorHandler(err, makeReq(), res as unknown as Response, noopNext);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(body.error).toBe('connection refused');
  });

  it('returns 500 "Internal Server Error" for non-Error thrown values', () => {
    const res = makeRes();
    errorHandler('something broke', makeReq(), res as unknown as Response, noopNext);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(body.error).toBe('Internal Server Error');
  });

  it('returns 500 for null thrown value', () => {
    const res = makeRes();
    errorHandler(null, makeReq(), res as unknown as Response, noopNext);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  // ── Logging ───────────────────────────────────────────────────────────────

  it('logs a structured JSON entry to console.error', () => {
    process.env.NODE_ENV = 'development';
    const err = new AppError(503, 'Service unavailable');
    errorHandler(err, makeReq('rid-1'), makeRes() as unknown as Response, noopNext);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(logged.type).toBe('error');
    expect(logged.statusCode).toBe(503);
    expect(logged.message).toBe('Service unavailable');
    expect(logged.requestId).toBe('rid-1');
  });

  it('includes stack trace in log in non-production', () => {
    process.env.NODE_ENV = 'development';
    const err = new Error('boom');
    errorHandler(err, makeReq(), makeRes() as unknown as Response, noopNext);

    const logged = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(logged.stack).toContain('Error: boom');
  });

  it('omits stack trace from log in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('boom');
    errorHandler(err, makeReq(), makeRes() as unknown as Response, noopNext);

    const logged = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(logged.stack).toBeUndefined();
  });

  it('omits stack trace from log for AppError (stack is never leaked)', () => {
    process.env.NODE_ENV = 'production';
    const err = new AppError(400, 'bad input');
    errorHandler(err, makeReq(), makeRes() as unknown as Response, noopNext);

    const logged = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(logged.stack).toBeUndefined();
  });

  // ── next() not called ─────────────────────────────────────────────────────

  it('does not call next()', () => {
    const next = jest.fn() as unknown as NextFunction;
    errorHandler(new AppError(400, 'bad'), makeReq(), makeRes() as unknown as Response, next);
    expect(next).not.toHaveBeenCalled();
  });
});
