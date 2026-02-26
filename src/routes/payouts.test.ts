import assert from 'assert';
import { createPayoutsHandlers, Payout } from './payouts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

class MockPayoutRepo {
  constructor(private rows: Payout[]) {}
  async listPayoutsByInvestor(investorId: string): Promise<Payout[]> {
    return this.rows.filter((p) => p.investor_id === investorId);
  }
}

function makeReq(user: any, query: any = {}) {
  return { user, query } as any;
}

function makeRes() {
  let statusCode = 200;
  let jsonData: any = null;
  return {
    status(code: number) { statusCode = code; return this; },
    json(obj: any) { jsonData = obj; return this; },
    _get() { return { statusCode, jsonData }; },
  } as any;
}

function makePayout(overrides: Partial<Payout> = {}): Payout {
  return {
    id: 'pay-1',
    distribution_run_id: 'run-1',
    investor_id: 'inv-1',
    amount: '50.00',
    status: 'processed',
    transaction_hash: '0xabc',
    created_at: new Date('2024-01-10'),
    updated_at: new Date('2024-01-10'),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

(async function run() {
  const payouts: Payout[] = [
    makePayout({ id: 'pay-1', investor_id: 'inv-1', status: 'processed', amount: '100.00', created_at: new Date('2024-01-01') }),
    makePayout({ id: 'pay-2', investor_id: 'inv-1', status: 'processed', amount: '200.00', created_at: new Date('2024-01-02') }),
    makePayout({ id: 'pay-3', investor_id: 'inv-1', status: 'pending',   amount: '50.00',  created_at: new Date('2024-01-03') }),
    makePayout({ id: 'pay-4', investor_id: 'inv-1', status: 'failed',    amount: '75.00',  created_at: new Date('2024-01-04') }),
    makePayout({ id: 'pay-5', investor_id: 'inv-2', status: 'processed', amount: '999.00', created_at: new Date('2024-01-05') }),
  ];
  const repo = new MockPayoutRepo(payouts);
  const handlers = createPayoutsHandlers(repo as any);

  // ── Success: returns only the requesting investor's payouts ─────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }), res, (e: any) => { throw e; });
    const { statusCode, jsonData } = res._get();
    assert(statusCode === 200, `expected 200 got ${statusCode}`);
    assert(Array.isArray(jsonData.payouts), 'payouts should be array');
    assert(jsonData.payouts.length === 4, `expected 4 payouts, got ${jsonData.payouts.length}`);
    assert(typeof jsonData.total === 'number' && jsonData.total === 4, 'total should be 4');
    assert(jsonData.payouts.every((p: Payout) => p.investor_id === 'inv-1'), 'all payouts belong to inv-1');
  }

  // ── Filter by status=processed ──────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }, { status: 'processed' }), res, (e: any) => { throw e; });
    const { statusCode, jsonData } = res._get();
    assert(statusCode === 200);
    assert(jsonData.payouts.length === 2, `expected 2 processed, got ${jsonData.payouts.length}`);
    assert(jsonData.total === 2, 'total reflects filtered count');
    assert(jsonData.payouts.every((p: Payout) => p.status === 'processed'));
  }

  // ── Filter by status=pending ────────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }, { status: 'pending' }), res, (e: any) => { throw e; });
    const { statusCode, jsonData } = res._get();
    assert(statusCode === 200);
    assert(jsonData.payouts.length === 1);
    assert(jsonData.payouts[0].id === 'pay-3');
  }

  // ── Pagination: limit only ──────────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }, { limit: '2' }), res, (e: any) => { throw e; });
    const { statusCode, jsonData } = res._get();
    assert(statusCode === 200);
    assert(jsonData.payouts.length === 2, `expected 2 with limit, got ${jsonData.payouts.length}`);
    assert(jsonData.total === 4, 'total is unsliced count');
  }

  // ── Pagination: offset only ─────────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }, { offset: '2' }), res, (e: any) => { throw e; });
    const { statusCode, jsonData } = res._get();
    assert(statusCode === 200);
    assert(jsonData.payouts.length === 2, `expected 2 after offset, got ${jsonData.payouts.length}`);
  }

  // ── Pagination: limit + offset ──────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }, { limit: '1', offset: '1' }), res, (e: any) => { throw e; });
    const { statusCode, jsonData } = res._get();
    assert(statusCode === 200);
    assert(jsonData.payouts.length === 1, `expected 1, got ${jsonData.payouts.length}`);
    assert(jsonData.payouts[0].id === 'pay-2', `expected pay-2, got ${jsonData.payouts[0].id}`);
  }

  // ── Empty result for investor with no payouts ───────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-99', role: 'investor' }), res, (e: any) => { throw e; });
    const { statusCode, jsonData } = res._get();
    assert(statusCode === 200);
    assert(jsonData.payouts.length === 0);
    assert(jsonData.total === 0);
  }

  // ── 401 when no user ────────────────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq(null), res, (e: any) => { throw e; });
    const { statusCode } = res._get();
    assert(statusCode === 401, `expected 401 got ${statusCode}`);
  }

  // ── 401 when user has no id ─────────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ role: 'investor' }), res, (e: any) => { throw e; });
    const { statusCode } = res._get();
    assert(statusCode === 401, `expected 401 got ${statusCode}`);
  }

  // ── 403 when role is not investor ───────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'issuer-1', role: 'issuer' }), res, (e: any) => { throw e; });
    const { statusCode } = res._get();
    assert(statusCode === 403, `expected 403 got ${statusCode}`);
  }

  // ── 403 for startup role ────────────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'startup-1', role: 'startup' }), res, (e: any) => { throw e; });
    const { statusCode } = res._get();
    assert(statusCode === 403, `expected 403 got ${statusCode}`);
  }

  // ── 400 for negative limit ──────────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }, { limit: '-1' }), res, (e: any) => { throw e; });
    const { statusCode } = res._get();
    assert(statusCode === 400, `expected 400 got ${statusCode}`);
  }

  // ── 400 for negative offset ─────────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }, { offset: '-5' }), res, (e: any) => { throw e; });
    const { statusCode } = res._get();
    assert(statusCode === 400, `expected 400 got ${statusCode}`);
  }

  // ── 400 for non-numeric limit ───────────────────────────────────────────────
  {
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }, { limit: 'abc' }), res, (e: any) => { throw e; });
    const { statusCode } = res._get();
    assert(statusCode === 400, `expected 400 got ${statusCode}`);
  }

  // ── next(err) called on repo failure ────────────────────────────────────────
  {
    const failingRepo = { listPayoutsByInvestor: async () => { throw new Error('DB error'); } };
    const failHandlers = createPayoutsHandlers(failingRepo as any);
    let capturedErr: any = null;
    const res = makeRes();
    await failHandlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }), res, (e: any) => { capturedErr = e; });
    assert(capturedErr instanceof Error && capturedErr.message === 'DB error');
  }

  console.log('payouts route tests passed');
})();
