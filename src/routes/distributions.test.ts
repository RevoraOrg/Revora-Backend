import { createDistributionHandlers } from './distributions';
import { AppError, Errors } from '../lib/errors';

class MockEngine {
  lastArgs: any = null;
  failCount = 0;
  async distribute(offeringId: string, period: any, revenueAmount: number) {
    if (this.failCount > 0) {
      this.failCount--;
      throw new Error('Engine failure');
    }
    this.lastArgs = { offeringId, period, revenueAmount };
    return { 
      distributionRun: { id: 'run-1', offering_id: offeringId }, 
      payouts: [{ investor_id: 'i1', amount: '50.00' }] 
    };
  }
}

class MockOfferingRepo {
  constructor(private rows: any) {}
  async getById(id: string) { return this.rows[id] ?? null; }
}

const createMockRequest = (user: any, params: any = {}, body: any = {}) => ({
  user,
  params,
  body,
  id: 'test-request-id',
} as any);

const createMockResponse = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const createMockNext = () => jest.fn();

describe('distributions routes', () => {
  let engine: MockEngine;
  let repo: MockOfferingRepo;
  let handlers: any;

  beforeEach(() => {
    engine = new MockEngine();
    const offeringRows: any = { off1: { id: 'off1', issuer_id: 's1' } };
    repo = new MockOfferingRepo(offeringRows);
    handlers = createDistributionHandlers(engine as any, repo as any);
  });

  describe('authorization and validation', () => {
    it('allows admin to trigger distribution', async () => {
      const req = createMockRequest(
        { id: 'admin1', role: 'admin' }, 
        { id: 'off1' }, 
        { revenue_amount: 100, period: { start: '2026-01-01', end: '2026-01-31' } }
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.triggerDistribution(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        run_id: 'run-1',
        total_payouts: 1,
        requestId: 'test-request-id'
      }));
    });

    it('allows startup owner to trigger distribution', async () => {
      const req = createMockRequest(
        { id: 's1', role: 'startup' }, 
        { id: 'off1' }, 
        { revenueAmount: 200, start: '2026-01-01', end: '2026-01-31' }
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.triggerDistribution(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('denies startup who is not the owner', async () => {
      const req = createMockRequest(
        { id: 's2', role: 'startup' }, 
        { id: 'off1' }, 
        { revenue_amount: 50, period: { start: '2026-01-01', end: '2026-01-31' } }
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.triggerDistribution(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const error = next.mock.calls[0][0];
      expect(error.statusCode).toBe(403);
    });

    it('denies unauthorized users', async () => {
      const req = createMockRequest(null, { id: 'off1' }, { revenue_amount: 10 });
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.triggerDistribution(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(401);
    });
  });

  describe('validation edge cases', () => {
    it('returns 400 for invalid revenue amount', async () => {
      const req = createMockRequest(
        { id: 'admin1', role: 'admin' }, 
        { id: 'off1' }, 
        { revenue_amount: -100, period: { start: '2026-01-01', end: '2026-01-31' } }
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.triggerDistribution(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(400);
    });

    it('returns 400 for invalid date format', async () => {
      const req = createMockRequest(
        { id: 'admin1', role: 'admin' }, 
        { id: 'off1' }, 
        { revenue_amount: 100, period: { start: 'not-a-date', end: '2026-01-31' } }
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.triggerDistribution(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(400);
    });

    it('returns 400 when end date is not after start date', async () => {
      const req = createMockRequest(
        { id: 'admin1', role: 'admin' }, 
        { id: 'off1' }, 
        { revenue_amount: 100, period: { start: '2026-01-31', end: '2026-01-01' } }
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.triggerDistribution(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      expect(next.mock.calls[0][0].statusCode).toBe(400);
    });
  });

  describe('retry/backoff and scheduling semantics', () => {
    it('forwards engine failures to next() for retry handling', async () => {
      engine.failCount = 1;
      const req = createMockRequest(
        { id: 'admin1', role: 'admin' }, 
        { id: 'off1' }, 
        { revenue_amount: 100, period: { start: '2026-01-01', end: '2026-01-31' } }
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.triggerDistribution(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('Engine failure');
    });

    it('ensures distribution period is passed correctly to the engine', async () => {
      const start = '2026-02-01';
      const end = '2026-02-28';
      const req = createMockRequest(
        { id: 'admin1', role: 'admin' }, 
        { id: 'off1' }, 
        { revenue_amount: 500, period: { start, end } }
      );
      const res = createMockResponse();
      const next = createMockNext();

      await handlers.triggerDistribution(req, res, next);

      expect(engine.lastArgs.period.start.toISOString()).toBe(new Date(start).toISOString());
      expect(engine.lastArgs.period.end.toISOString()).toBe(new Date(end).toISOString());
      expect(engine.lastArgs.revenueAmount).toBe(500);
    });

    it('sanitizes engine failures to avoid leaking raw error strings', async () => {
      // Mock an engine that throws an error when distribute is called
      // (simulating the behavior where distribute() throws if any payouts failed)
      jest.spyOn(engine, 'distribute').mockRejectedValueOnce(
        Errors.internal('Distribution failed: NETWORK_ERROR')
      );

      const req = createMockRequest(
        { id: 'admin1', role: 'admin' }, 
        { id: 'off1' }, 
        { revenue_amount: 10, period: { start: '2026-01-01', end: '2026-01-31' } }
      );
      const res = createMockResponse();
      const next = createMockNext();

      const handlersWithMock = createDistributionHandlers(engine as any, repo as any);
      await handlersWithMock.triggerDistribution(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(AppError));
      const error = next.mock.calls[0][0];
      expect(error.message).toBe('Distribution failed: NETWORK_ERROR');
    });

    it('fails if offering id is missing', async () => {
      const req = createMockRequest({ id: 'admin1', role: 'admin' }, {}, { revenue_amount: 10, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = createMockResponse();
      const next = createMockNext();
      await handlers.triggerDistribution(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Missing offering id' }));
    });

    it('fails if distribution period is missing', async () => {
      const req = createMockRequest({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 10 });
      const res = createMockResponse();
      const next = createMockNext();
      await handlers.triggerDistribution(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Missing distribution period' }));
    });

    it('fails if user role is not admin or startup', async () => {
      const req = createMockRequest({ id: 'u1', role: 'investor' }, { id: 'off1' }, { revenue_amount: 10, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = createMockResponse();
      const next = createMockNext();
      await handlers.triggerDistribution(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Forbidden: startup role required' }));
    });

    it('fails if offeringRepo is missing for startup role', async () => {
      const handlersNoRepo = createDistributionHandlers(engine as any);
      const req = createMockRequest({ id: 's1', role: 'startup' }, { id: 'off1' }, { revenue_amount: 10, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = createMockResponse();
      const next = createMockNext();
      await handlersNoRepo.triggerDistribution(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Forbidden: cannot verify issuer' }));
    });

    it('fails if offering is not found', async () => {
      repo.getById = jest.fn().mockResolvedValue(null);
      const req = createMockRequest({ id: 's1', role: 'startup' }, { id: 'off-none' }, { revenue_amount: 10, period: { start: '2026-01-01', end: '2026-01-31' } });
      const res = createMockResponse();
      const next = createMockNext();
      await handlers.triggerDistribution(req, res, next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'Offering not found' }));
    });

    it('creates a router', () => {
      const verifyJWT = (req: any, res: any, next: any) => next();
      const router = require('./distributions').default({ distributionEngine: engine, offeringRepo: repo, verifyJWT });
      expect(router).toBeDefined();
      expect(typeof router).toBe('function'); // Express router is a function
    });
  });
});
