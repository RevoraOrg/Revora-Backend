import assert from 'assert';
import { createOfferingHandlers } from './offerings';

class MockOfferingRepo {
  private rows: any[];
  constructor(rows: any[], private total?: number) { this.rows = rows; }
  async listByIssuer(issuerId: string, opts?: any) {
    // naive filter by status if provided
    let out = this.rows.filter(r => r.issuer_id === issuerId);
    if (opts && opts.status) out = out.filter(r => r.status === opts.status);
    if (opts && typeof opts.offset === 'number') out = out.slice(opts.offset);
    if (opts && typeof opts.limit === 'number') out = out.slice(0, opts.limit);
    return out;
  }
  async countByIssuer(issuerId: string, opts?: any) {
    if (typeof this.total === 'number') return this.total;
    const list = await this.listByIssuer(issuerId, opts);
    return list.length;
  }
}

function makeReq(user: any, query: any = {}) { return { user, query } as any; }
function makeRes() {
  let statusCode = 200; let jsonData: any = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: any) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; }
  } as any;
}

(async function run() {
  const offers = [
    { id: 'o1', issuer_id: 's1', title: 'A', status: 'draft', amount: '100.00', created_at: new Date() },
    { id: 'o2', issuer_id: 's1', title: 'B', status: 'live', amount: '200.00', created_at: new Date() },
    { id: 'o3', issuer_id: 's2', title: 'C', status: 'live', amount: '300.00', created_at: new Date() },
  ];

  const repo = new MockOfferingRepo(offers);
  const handlers = createOfferingHandlers(repo as any);

  // success list
  const req1 = makeReq({ id: 's1', role: 'startup' }, {});
  const res1 = makeRes();
  await handlers.listOfferings(req1, res1, (e:any)=>{ throw e; });
  const out1 = res1._get();
  assert(out1.statusCode === 200);
  assert(Array.isArray(out1.jsonData.offerings) && out1.jsonData.offerings.length === 2);

  // filter by status
  const req2 = makeReq({ id: 's1', role: 'startup' }, { status: 'live' });
  const res2 = makeRes();
  await handlers.listOfferings(req2, res2, (e:any)=>{ throw e; });
  const out2 = res2._get();
  assert(out2.jsonData.offerings.length === 1 && out2.jsonData.offerings[0].id === 'o2');

  // pagination limit/offset
  const req3 = makeReq({ id: 's1', role: 'startup' }, { limit: '1', offset: '1' });
  const res3 = makeRes();
  await handlers.listOfferings(req3, res3, (e:any)=>{ throw e; });
  const out3 = res3._get();
  assert(out3.jsonData.offerings.length === 1);

  // unauthorized
  const req4 = makeReq(null, {});
  const res4 = makeRes();
  await handlers.listOfferings(req4, res4, (e:any)=>{ throw e; });
  const out4 = res4._get();
  assert(out4.statusCode === 401);

  // forbidden (non-startup)
  const req5 = makeReq({ id: 's1', role: 'investor' }, {});
  const res5 = makeRes();
  await handlers.listOfferings(req5, res5, (e:any)=>{ throw e; });
  const out5 = res5._get();
  assert(out5.statusCode === 403);

  console.log('offerings route tests passed');
})();
