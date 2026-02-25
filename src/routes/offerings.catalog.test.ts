import assert from 'assert';
import { createPublicHandlers } from './offerings';

class MockOfferingRepo {
  private rows: any[];
  private total?: number;
  constructor(rows: any[], total?: number) { this.rows = rows; this.total = total; }
  async listPublic(opts: any) {
    let out = this.rows.slice();
    if (opts && opts.status) out = out.filter(r => r.status === opts.status);
    if (opts && typeof opts.sort === 'string') {
      if (opts.sort === 'created_at') out = out.sort((a,b)=> new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      if (opts.sort === 'revenue_share_bps') out = out.sort((a,b)=> (b.revenue_share_bps||0) - (a.revenue_share_bps||0));
    }
    if (typeof opts.offset === 'number') out = out.slice(opts.offset);
    if (typeof opts.limit === 'number') out = out.slice(0, opts.limit);
    // Return only public/safe fields
    return out.map(r => ({ id: r.id, title: r.title, status: r.status, amount: r.amount, created_at: r.created_at }));
  }
  async countPublic(opts: any) { return typeof this.total === 'number' ? this.total : (await this.listPublic(opts)).length; }
}

function makeReq(query: any = {}) { return { query } as any; }
function makeRes() { let statusCode=200; let jsonData:any=null; return { status(code:number){statusCode=code;return this}, json(obj:any){jsonData=obj;return this}, _get(){return {statusCode,jsonData}} } as any; }

(async function run(){
  const rows = [
    { id:'o1', title:'A', issuer_id:'s1', status:'active', amount:'100.00', created_at:new Date(), revenue_share_bps:500 },
    { id:'o2', title:'B', issuer_id:'s2', status:'draft', amount:'200.00', created_at:new Date(Date.now()-10000), revenue_share_bps:300 },
    { id:'o3', title:'C', issuer_id:'s3', status:'active', amount:'300.00', created_at:new Date(Date.now()-20000), revenue_share_bps:700 },
  ];

  const repo = new MockOfferingRepo(rows);
  const handlers = createPublicHandlers(repo as any);

  // List active
  const req1 = makeReq({ status: 'active' });
  const res1 = makeRes();
  await handlers.listCatalog(req1, res1, (e:any)=>{ throw e });
  const out1 = res1._get();
  assert(out1.statusCode === 200);
  assert(out1.jsonData.offerings.length === 2);

  // Pagination + sort
  const req2 = makeReq({ status: 'active', limit: '1', offset: '0', sort: 'revenue_share_bps' });
  const res2 = makeRes();
  await handlers.listCatalog(req2, res2, (e:any)=>{ throw e });
  const out2 = res2._get();
  assert(out2.jsonData.offerings.length === 1);
  // Ensure fields are public only
  assert(!('issuer_id' in out2.jsonData.offerings[0]));

  console.log('offerings catalog tests passed');
})();
