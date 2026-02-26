import { Router, Request, Response, NextFunction } from 'express';
import { validate } from './validate';

class MockResponse {
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
});

