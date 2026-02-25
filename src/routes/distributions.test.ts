import assert from 'assert';
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

(async function run() {
  const engine = new MockEngine();
  const offeringRows: any = { off1: { id: 'off1', issuer_id: 's1' } };
  const repo = new MockOfferingRepo(offeringRows);
  const handlers = createDistributionHandlers(engine as any, repo as any);

  // Admin success
  const req1 = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { revenue_amount: 100, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
  const res1 = makeRes();
  await handlers.triggerDistribution(req1, res1, (e: any) => { throw e; });
  const out1 = res1._get();
  assert(out1.statusCode === 200);
  assert(out1.jsonData.run_id === 'run-1');

  // Startup owner success
  const req2 = makeReq({ id: 's1', role: 'startup' }, { id: 'off1' }, { revenueAmount: 200, start: new Date().toISOString(), end: new Date().toISOString() });
  const res2 = makeRes();
  await handlers.triggerDistribution(req2, res2, (e: any) => { throw e; });
  const out2 = res2._get();
  assert(out2.statusCode === 200);

  // Forbidden startup (not issuer)
  const req3 = makeReq({ id: 's2', role: 'startup' }, { id: 'off1' }, { revenue_amount: 50, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
  const res3 = makeRes();
  await handlers.triggerDistribution(req3, res3, (e: any) => { throw e; });
  const out3 = res3._get();
  assert(out3.statusCode === 403);

  // Unauthorized
  const req4 = makeReq(null, { id: 'off1' }, { revenue_amount: 10, period: { start: new Date().toISOString(), end: new Date().toISOString() } });
  const res4 = makeRes();
  await handlers.triggerDistribution(req4, res4, (e: any) => { throw e; });
  const out4 = res4._get();
  assert(out4.statusCode === 401);

  // Bad input
  const req5 = makeReq({ id: 'admin1', role: 'admin' }, { id: 'off1' }, { period: { start: new Date().toISOString() } });
  const res5 = makeRes();
  await handlers.triggerDistribution(req5, res5, (e: any) => { throw e; });
  const out5 = res5._get();
  assert(out5.statusCode === 400);

  console.log('distributions route tests passed');
})();
