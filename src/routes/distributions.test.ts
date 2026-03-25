import { createDistributionHandlers } from './distributions';

class MockEngine {
  lastArgs: any = null;
  async distribute(offeringId: string, period: any, revenueAmount: number) {
    this.lastArgs = { offeringId, period, revenueAmount };
    return { distributionRun: { id: 'run-1', offering_id: offeringId }, payouts: [{ investor_id: 'i1', amount: '50.00' }] };
  }
}

class MockOfferingRepo {
  constructor(private rows: any) {}
  async getById(id: string) { return this.rows[id] ?? null; }
}

function makeReq(user: any, params: any = {}, body: any = {}) { return { user, params, body } as any; }
function makeRes() { let statusCode = 200; let jsonData: any = null; return { status(code: number) { statusCode = code; return this; }, json(obj: any) { jsonData = obj; return this; }, _get() { return { statusCode, jsonData }; } } as any; }

describe('Distribution Trigger Authorization', () => {
  let engine: MockEngine;
  let offeringRows: any;
  let repo: MockOfferingRepo;
  let handlers: any;

  beforeEach(() => {
    engine = new MockEngine();
    offeringRows = { off1: { id: 'off1', issuer_id: 's1' } };
    repo = new MockOfferingRepo(offeringRows);
    handlers = createDistributionHandlers(engine as any, repo as any);
  });

  it('should allow admin to trigger distribution', async () => {
    const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(200);
    expect(out.jsonData.run_id).toBe('run-1');
  });

  it('should allow startup owner to trigger distribution', async () => {
    const req = makeReq({ id: 's1', role: 'startup' }, { id: 'off1' }, { revenueAmount: 200, start: new Date().toISOString(), end: new Date().toISOString() });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(200);
  });

  it('should forbid startup non-owner from triggering distribution', async () => {
    const req = makeReq({ id: 's2', role: 'startup' }, { id: 'off1' }, { revenue_amount: 50, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(403);
  });

  it('should return 401 for unauthorized user', async () => {
    const req = makeReq(null, { id: 'off1' }, { revenue_amount: 10, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(401);
  });

  it('should return 400 for invalid input', async () => {
    const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { period: { start: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(400);
  });

  it('should handle missing offering ID', async () => {
    const req = makeReq({ id: 'admin1', role: 'admin' }, {}, { revenue_amount: 100, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(400);
  });

  it('should handle non-existent offering', async () => {
    const req = makeReq({ id: 's1', role: 'startup' }, { id: 'off2' }, { revenue_amount: 100, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(404);
  });

  it('should handle zero revenue amount', async () => {
    const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 0, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(400);
  });

  it('should handle negative revenue amount', async () => {
    const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: -10, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(400);
  });

  it('should handle missing period end date', async () => {
    const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100, period: { start: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(400);
  });

  it('should handle invalid date format', async () => {
    const req = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100, period: { start: 'invalid-date', end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(400);
  });

  it('should forbid investor role', async () => {
    const req = makeReq({ id: 'inv1', role: 'investor' }, { id: 'off1' }, { revenue_amount: 100, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(403);
  });

  it('should forbid verifier role', async () => {
    const req = makeReq({ id: 'ver1', role: 'verifier' }, { id: 'off1' }, { revenue_amount: 100, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
    const res = makeRes();
    await handlers.triggerDistribution(req, res, (e: any) => { throw e; });
    const out = res._get();
    expect(out.statusCode).toBe(403);
  });
});
