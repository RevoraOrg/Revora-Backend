import { Request, Response } from 'express';
import { overviewHandler, investorOverviewHandler, updateWeightsHandler, riskScoreEngine } from './overview';

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

describe('overview router', () => {
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

  describe('investorOverviewHandler', () => {
    it('returns investor risk score', async () => {
      const req = {
        params: { investorId: 'investor-123' },
        headers: { 'x-user-id': 'admin-1' }
      } as unknown as Request;
      const res = new MockResponse();

      jest.spyOn(riskScoreEngine, 'calculateScore').mockResolvedValue(55);

      await investorOverviewHandler(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({ investorId: 'investor-123', riskScore: 55 });
    });
  });

  describe('updateWeightsHandler', () => {
    it('updates weights when dual confirmation is provided', async () => {
      const req = {
        headers: { 'x-user-id': 'admin-1' },
        get: (name: string) => (name === 'x-revora-dual-confirmation' ? 'true' : ''),
        body: { weights: { baseScore: 10 }, confirmation: true }
      } as unknown as Request;
      const res = new MockResponse();

      jest.spyOn(riskScoreEngine, 'updateWeights').mockResolvedValue(undefined);

      await updateWeightsHandler(req, res as unknown as Response);

      expect(res.statusCode).toBe(200);
      expect(res.payload).toEqual({ success: true });
    });

    it('returns 400 when dual confirmation is missing', async () => {
      const req = {
        headers: { 'x-user-id': 'admin-1' },
        get: () => '',
        body: { weights: { baseScore: 10 } }
      } as unknown as Request;
      const res = new MockResponse();

      jest.spyOn(riskScoreEngine, 'updateWeights').mockRejectedValue(new Error('Dual-control confirmation is required'));

      await updateWeightsHandler(req, res as unknown as Response);

      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ error: 'Dual-control confirmation is required' });
    });
  });
});
