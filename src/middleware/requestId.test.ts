import { Request, Response, NextFunction } from 'express';
import { requestIdMiddleware } from './requestId';

function makeRes() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: jest.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    getHeader: jest.fn((k: string) => headers[k.toLowerCase()]),
  };
  return res as unknown as Response;
}

describe('requestIdMiddleware', () => {
  it('uses X-Request-Id from header when provided', () => {
    const req = { headers: { 'x-request-id': 'abc-123' } } as unknown as Request;
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requestIdMiddleware()(req, res, next);

    expect(req.requestId).toBe('abc-123');
    expect(res.getHeader('X-Request-Id')).toBe('abc-123');
    expect(next).toHaveBeenCalled();
  });

  it('picks first non-empty value when header is an array', () => {
    const req = { headers: { 'x-request-id': [' ', 'foo', 'bar'] } } as unknown as Request;
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requestIdMiddleware()(req, res, next);

    expect(req.requestId).toBe('foo');
    expect(res.getHeader('X-Request-Id')).toBe('foo');
  });

  it('generates a UUID when none provided', () => {
    const req = { headers: {} } as unknown as Request;
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requestIdMiddleware()(req, res, next);

    const id = req.requestId as string;
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(res.getHeader('X-Request-Id')).toBe(id);
  });

  it('does not override existing req.requestId', () => {
    const req = { headers: {}, requestId: 'pre-set' } as unknown as Request & { requestId: string };
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    requestIdMiddleware()(req as unknown as Request, res, next);

    expect(req.requestId).toBe('pre-set');
    expect(res.getHeader('X-Request-Id')).toBe('pre-set');
  });
});

