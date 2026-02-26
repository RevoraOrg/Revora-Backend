import { NextFunction, Request, Response } from 'express';
import { createRequestIdMiddleware } from './requestId';
import * as crypto from 'crypto';

class MockResponse {
  headers: Record<string, string> = {};

  setHeader(name: string, value: unknown): void {
    this.headers[name.toLowerCase()] = String(value);
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
}

function createRequest(headers: Record<string, string> = {}): Partial<Request> {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = v;
  }
  return {
    header: ((name: string) => normalized[name.toLowerCase()]) as Request['header'],
  };
}

describe('createRequestIdMiddleware', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses incoming X-Request-Id and echoes it in response header', () => {
    const middleware = createRequestIdMiddleware();
    const req = createRequest({ 'x-request-id': 'abc-123' }) as Request;
    const res = new MockResponse() as unknown as Response;
    const next: NextFunction = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as any).requestId).toBe('abc-123');
    expect((res as any).getHeader('x-request-id')).toBe('abc-123');
  });

  it('generates UUID when header is missing and attaches/echoes it', () => {
    jest
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('00000000-0000-0000-0000-000000000000');
    const middleware = createRequestIdMiddleware();
    const req = createRequest() as Request;
    const res = new MockResponse() as unknown as Response;
    const next: NextFunction = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as any).requestId).toBe('00000000-0000-0000-0000-000000000000');
    expect((res as any).getHeader('x-request-id')).toBe(
      '00000000-0000-0000-0000-000000000000'
    );
  });

  it('supports custom source header name while echoing X-Request-Id', () => {
    const middleware = createRequestIdMiddleware({ headerName: 'x-correlation-id' });
    const req = createRequest({ 'x-correlation-id': 'corr-789' }) as Request;
    const res = new MockResponse() as unknown as Response;
    const next: NextFunction = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((req as any).requestId).toBe('corr-789');
    expect((res as any).getHeader('x-request-id')).toBe('corr-789');
  });
});
