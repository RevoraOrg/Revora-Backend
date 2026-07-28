import { Router, Request, Response, NextFunction } from 'express';
import { validate } from './validate';

class MockResponse {
  // Mocked headers for setHeader/getHeader
  private _headers: Record<string, string> = {};

  public statusCode = 200;
  public payload: any;
  status(code: number) {
    this.statusCode = code;
    return this;
    }
  json(data: any) {
    this.payload = data;
    return this;
  }

  setHeader(name: string, value: string | number | readonly string[]): void {
    this._headers[name.toLowerCase()] = String(value);
  }

  getHeader(name: string): string | undefined {
    return this._headers[name.toLowerCase()];
  }
}

describe('validate middleware', () => {
  it('returns 400 when body is invalid', async () => {
    const router = Router();
    const bodySchema = { email: { type: 'string', required: true } as const };
    const mw = validate(bodySchema) as any;

    router.post('/api/demo', mw, (_req, res) => {
      (res as Response).json({ ok: true });
    });

    const req = { body: {} } as unknown as Request;
    const res = new MockResponse() as unknown as Response;
    const next: NextFunction = jest.fn();

    const routeLayer = (router as any).stack[0].route.stack[0];
    await routeLayer.handle(req, res, next);

    expect(res.statusCode).toBe(400);
    expect((res as any).payload?.error).toBe('ValidationError');
    expect(Array.isArray((res as any).payload?.details)).toBe(true);
  });

  it('returns 400 when body field does not match regex pattern', async () => {
    const router = Router();
    const POSITIVE_DECIMAL_REGEX = /^\d+(\.\d{1,18})?$/;
    const bodySchema = { amount: { type: 'string', required: true, pattern: POSITIVE_DECIMAL_REGEX } as const };
    const mw = validate(bodySchema) as any;

    router.post('/api/decimal', mw, (_req, res) => {
      (res as Response).json({ ok: true });
    });

    // Test case 1: Invalid format (negative)
    let req = { body: { amount: '-10.50' } } as unknown as Request;
    let res = new MockResponse() as unknown as Response;
    let next: NextFunction = jest.fn();

    let routeLayer = (router as any).stack[0].route.stack[0];
    await routeLayer.handle(req, res, next);

    expect(res.statusCode).toBe(400);
    expect((res as any).payload?.error).toBe('ValidationError');
    expect((res as any).payload?.details).toContain('body.amount: invalid format');

    // Test case 2: Invalid format (too many decimals)
    req = { body: { amount: '1.1234567890123456789' } } as unknown as Request;
    res = new MockResponse() as unknown as Response;
    next = jest.fn();

    routeLayer = (router as any).stack[0].route.stack[0];
    await routeLayer.handle(req, res, next);

    expect(res.statusCode).toBe(400);
    expect((res as any).payload?.details).toContain('body.amount: invalid format');
  });
});
