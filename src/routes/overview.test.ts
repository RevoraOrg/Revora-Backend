import { Request, Response } from 'express';
import { overviewHandler } from './overview';

class MockResponse {
  statusCode = 200;
  payload: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(payload: unknown): this {
    this.payload = payload;
    return this;
  }
}

describe('overviewHandler', () => {
  it('returns correct metadata', async () => {
    const req = {} as Request;
    const res = new MockResponse();

    await overviewHandler(req, res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      name: 'Stellar RevenueShare (Revora) Backend',
      description:
        'Backend API skeleton for tokenized revenue-sharing on Stellar (offerings, investments, revenue distribution).',
      version: '0.1.0',
    });
  });
});
