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

describe('offerings routes', () => {
  it('covers startup listing behavior', async () => {
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
  let err4: any;
  await handlers.listOfferings(req4, res4, (e:any)=>{ err4 = e; });
  assert(err4 && err4.statusCode === 401);

  // forbidden (non-startup)
  const req5 = makeReq({ id: 's1', role: 'investor' }, {});
  const res5 = makeRes();
  let err5: any;
  await handlers.listOfferings(req5, res5, (e:any)=>{ err5 = e; });
  assert(err5 && err5.statusCode === 403);

  // catch error coverage
  const req6 = makeReq({ id: 's1', role: 'startup' }, {});
  const res6 = makeRes();
  const errorRepo = new MockOfferingRepo([]);
  errorRepo.listByIssuer = async () => { throw new Error('DB Error'); };
  const errHandlers = createOfferingHandlers(errorRepo as any);
  let err6: any;
  await errHandlers.listOfferings(req6, res6, (e:any)=>{ err6 = e; });
  assert(err6 && err6.message === 'DB Error');

  });

  it('covers public catalog behavior (GET public offerings)', async () => {
    const offers = [
      { id: '11111111-1111-4111-8111-111111111111', issuer_id: 's1', title: 'A', status: 'live', amount: '100.00', created_at: new Date() },
      { id: '22222222-2222-4222-8222-222222222222', issuer_id: 's2', title: 'B', status: 'live', amount: '200.00', created_at: new Date() },
    ];
    
    class MockPublicRepo {
      async listPublic(opts?: any) {
        let out = offers;
        if (opts && opts.status) out = out.filter(r => r.status === opts.status);
        if (opts && typeof opts.offset === 'number') out = out.slice(opts.offset);
        if (opts && typeof opts.limit === 'number') out = out.slice(0, opts.limit);
        return out;
      }
      async countPublic(opts?: any) {
        const list = await this.listPublic(opts);
        return list.length;
      }
      async getById(id: string) {
        return offers.find(o => o.id === id) || null;
      }
    }

    const { createPublicHandlers } = require('./offerings');
    const handlers = createPublicHandlers(new MockPublicRepo() as any);

    // success listCatalog
    const req1 = makeReq(null, { limit: '1' });
    const res1 = makeRes();
    await handlers.listCatalog(req1, res1, (e:any) => { throw e; });
    const out1 = res1._get();
    assert(out1.statusCode === 200);
    assert(out1.jsonData.offerings.length === 1);
    assert(out1.jsonData.total === 2);

    // success getOfferingById (public format)
    const req2 = makeReq(null, {});
    req2.params = { id: '11111111-1111-4111-8111-111111111111' };
    const res2 = makeRes();
    await handlers.getOfferingById(req2, res2, (e:any) => { throw e; });
    const out2 = res2._get();
    assert(out2.statusCode === 200);
    assert(out2.jsonData.id === '11111111-1111-4111-8111-111111111111');
    assert(out2.jsonData.issuer_id === undefined); // Public view hides issuer_id

    // success getOfferingById (issuer format)
    const req3 = makeReq({ id: 's1', role: 'startup' }, {});
    req3.params = { id: '11111111-1111-4111-8111-111111111111' };
    const res3 = makeRes();
    await handlers.getOfferingById(req3, res3, (e:any) => { throw e; });
    const out3 = res3._get();
    assert(out3.statusCode === 200);
    assert(out3.jsonData.issuer_id === 's1'); // Issuer sees everything

    // getOfferingById invalid UUID
    const req4 = makeReq(null, {});
    req4.params = { id: 'invalid-uuid' };
    const res4 = makeRes();
    let err4: any;
    await handlers.getOfferingById(req4, res4, (e:any) => { err4 = e; });
    assert(err4 && err4.statusCode === 400);

    // getOfferingById not found
    const req5 = makeReq(null, {});
    req5.params = { id: '33333333-3333-4333-8333-333333333333' };
    const res5 = makeRes();
    let err5: any;
    await handlers.getOfferingById(req5, res5, (e:any) => { err5 = e; });
    assert(err5 && err5.statusCode === 404);

    // catch error coverage getOfferingById
    const req6 = makeReq(null, {});
    req6.params = { id: '11111111-1111-4111-8111-111111111111' };
    const res6 = makeRes();
    const errorPublicRepo = new MockPublicRepo();
    errorPublicRepo.getById = async () => { throw new Error('DB Error 2'); };
    const errPublicHandlers = createPublicHandlers(errorPublicRepo as any);
    let err6: any;
    await errPublicHandlers.getOfferingById(req6, res6, (e:any) => { err6 = e; });
    assert(err6 && err6.message === 'DB Error 2');

    // catch error coverage listCatalog
    const req7 = makeReq(null, {});
    const res7 = makeRes();
    errorPublicRepo.listPublic = async () => { throw new Error('DB Error 3'); };
    let err7: any;
    await errPublicHandlers.listCatalog(req7, res7, (e:any) => { err7 = e; });
    assert(err7 && err7.message === 'DB Error 3');
  });

  it('creates the express router correctly', () => {
    const { default: createOfferingsRouter } = require('./offerings');
    const router = createOfferingsRouter({ offeringRepo: new MockOfferingRepo([]), verifyJWT: (req: any, res: any, next: any) => next() });
    assert(router && typeof router.use === 'function');
  });
});
