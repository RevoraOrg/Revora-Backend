import type { NextFunction, Request, Response } from 'express';
import { requestIdMiddleware } from './requestId';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function runMiddleware(header: string | string[] | undefined, existing?: string) {
  const req = {
    headers: header === undefined ? {} : { 'x-request-id': header },
    requestId: existing,
  } as Request;
  const res = { setHeader: jest.fn() } as unknown as Response;
  const next = jest.fn() as NextFunction;

  requestIdMiddleware()(req, res, next);

  return { req, res, next };
}

describe('requestIdMiddleware empty-result handling', () => {
  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['whitespace-only header', '   '],
    ['empty header array', []],
    ['blank header array', [' ', '\t']],
  ] as const)('generates a UUID when pickHeaderId returns undefined for %s', (_label, header) => {
    const { req, res, next } = runMiddleware(header);

    expect(req.requestId).toMatch(uuidV4);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.requestId);
    expect(req.logger).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to an existing request ID when the header is blank', () => {
    const { req, res } = runMiddleware('  ', 'existing-request-id');

    expect(req.requestId).toBe('existing-request-id');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'existing-request-id');
  });

  it('trims a normal string header', () => {
    const { req, res } = runMiddleware('  client-request-id  ');

    expect(req.requestId).toBe('client-request-id');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'client-request-id');
  });

  it('uses the first non-empty array entry and ignores later values', () => {
    const { req } = runMiddleware([' ', 'first', 'second']);

    expect(req.requestId).toBe('first');
  });
});
