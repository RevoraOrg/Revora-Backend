import assert from 'assert';
import { createPayoutsHandlers, Payout, PayoutListResponse } from './payouts';
import {
  classifyStellarRPCFailure,
  isStellarRPCRetryable,
  StellarRPCFailureClass,
  STELLAR_TX_RESULT_CODES,
  STELLAR_OP_RESULT_CODES,
} from '../lib/stellarRpcFailure';

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

const INVESTOR = { id: 'inv-1', role: 'investor' };
const next = (e: any) => { throw e; };

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PAYOUTS: Payout[] = [
  makePayout({ id: 'pay-1', investor_id: 'inv-1', status: 'processed', amount: '100.00', created_at: new Date('2024-01-01') }),
  makePayout({ id: 'pay-2', investor_id: 'inv-1', status: 'processed', amount: '200.00', created_at: new Date('2024-01-02') }),
  makePayout({ id: 'pay-3', investor_id: 'inv-1', status: 'pending',   amount: '50.00',  created_at: new Date('2024-01-03') }),
  makePayout({ id: 'pay-4', investor_id: 'inv-1', status: 'failed',    amount: '75.00',  created_at: new Date('2024-01-04') }),
  makePayout({ id: 'pay-5', investor_id: 'inv-2', status: 'processed', amount: '999.00', created_at: new Date('2024-01-05') }),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('payouts routes', () => {
  const repo = new MockPayoutRepo(PAYOUTS);
  const handlers = createPayoutsHandlers(repo as any);

  // ═══════════════════════════════════════════════════════════════════════════
  // Auth & authorization
  // ═══════════════════════════════════════════════════════════════════════════

  describe('auth boundaries', () => {
    it('returns 401 when no user', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(null), res, next);
      assert.strictEqual(res._get().statusCode, 401);
    });

    it('returns 401 when user has no id', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq({ role: 'investor' }), res, next);
      assert.strictEqual(res._get().statusCode, 401);
    });

    it('returns 403 for issuer role', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq({ id: 'u1', role: 'issuer' }), res, next);
      assert.strictEqual(res._get().statusCode, 403);
    });

    it('returns 403 for startup role', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq({ id: 'u1', role: 'startup' }), res, next);
      assert.strictEqual(res._get().statusCode, 403);
    });

    it('returns 403 for admin role', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq({ id: 'u1', role: 'admin' }), res, next);
      assert.strictEqual(res._get().statusCode, 403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Basic listing (no filters)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('basic listing', () => {
    it('returns only the requesting investor payouts', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR), res, next);
      const { statusCode, jsonData } = res._get();
      assert.strictEqual(statusCode, 200);
      assert(Array.isArray(jsonData.payouts));
      assert.strictEqual(jsonData.payouts.length, 4);
      assert.strictEqual(jsonData.total, 4);
      assert(jsonData.payouts.every((p: Payout) => p.investor_id === 'inv-1'));
    });

    it('returns empty for investor with no payouts', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq({ id: 'inv-99', role: 'investor' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 0);
      assert.strictEqual(jsonData.total, 0);
      assert.strictEqual(jsonData.hasMore, false);
    });

    it('includes pagination metadata in response', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(typeof jsonData.limit, 'number');
      assert.strictEqual(typeof jsonData.offset, 'number');
      assert.strictEqual(typeof jsonData.hasMore, 'boolean');
      assert.strictEqual(typeof jsonData.total, 'number');
    });

    it('uses default limit of 20 when not specified', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.limit, 20);
      assert.strictEqual(jsonData.offset, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Status filter
  // ═══════════════════════════════════════════════════════════════════════════

  describe('status filter', () => {
    it('filters by status=processed', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status: 'processed' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 2);
      assert.strictEqual(jsonData.total, 2);
      assert(jsonData.payouts.every((p: Payout) => p.status === 'processed'));
    });

    it('filters by status=pending', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status: 'pending' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.payouts[0].id, 'pay-3');
    });

    it('filters by status=failed', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status: 'failed' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.payouts[0].id, 'pay-4');
    });

    it('returns 400 for unknown status value', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status: 'xyz' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('Invalid status'));
    });

    it('returns 400 for status=completed (not in enum)', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status: 'completed' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Pagination
  // ═══════════════════════════════════════════════════════════════════════════

  describe('pagination', () => {
    it('paginates with limit only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '2' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 2);
      assert.strictEqual(jsonData.total, 4);
      assert.strictEqual(jsonData.limit, 2);
      assert.strictEqual(jsonData.hasMore, true);
    });

    it('paginates with offset only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: '2' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 2);
      assert.strictEqual(jsonData.offset, 2);
    });

    it('paginates with limit + offset', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '1', offset: '1' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.hasMore, true);
    });

    it('hasMore is false when all results are returned', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '100' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.hasMore, false);
    });

    it('returns 400 for negative limit', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '-1' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns 400 for negative offset', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: '-5' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns 400 for non-numeric limit', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: 'abc' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns 400 for non-numeric offset', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: 'xyz' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('caps limit at 100 when client requests more', async () => {
      // Create a repo with > 100 items
      const manyPayouts = Array.from({ length: 150 }, (_, i) =>
        makePayout({ id: `pay-m-${i}`, investor_id: 'inv-many', status: 'processed', amount: '10.00', created_at: new Date('2024-01-01') }),
      );
      const bigRepo = new MockPayoutRepo(manyPayouts);
      const bigHandlers = createPayoutsHandlers(bigRepo as any);

      const res = makeRes();
      await bigHandlers.listPayouts(makeReq({ id: 'inv-many', role: 'investor' }, { limit: '500' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.limit, 100);
      assert.strictEqual(jsonData.payouts.length, 100);
      assert.strictEqual(jsonData.hasMore, true);
    });

    it('returns empty array when offset exceeds total', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: '1000' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 0);
      assert.strictEqual(jsonData.total, 4);
      assert.strictEqual(jsonData.hasMore, false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Amount range filters
  // ═══════════════════════════════════════════════════════════════════════════

  describe('amount range filters', () => {
    it('filters by minAmount only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { minAmount: '100' }), res, next);
      const { jsonData } = res._get();
      assert(jsonData.payouts.every((p: Payout) => parseFloat(p.amount) >= 100));
      assert.strictEqual(jsonData.payouts.length, 2); // 100 and 200
    });

    it('filters by maxAmount only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { maxAmount: '75' }), res, next);
      const { jsonData } = res._get();
      assert(jsonData.payouts.every((p: Payout) => parseFloat(p.amount) <= 75));
      assert.strictEqual(jsonData.payouts.length, 2); // 50 and 75
    });

    it('filters by both minAmount and maxAmount', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { minAmount: '60', maxAmount: '150' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 2); // 75 and 100
    });

    it('returns 400 for non-numeric minAmount', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { minAmount: 'abc' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('minAmount'));
    });

    it('returns 400 for non-numeric maxAmount', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { maxAmount: 'xyz' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('maxAmount'));
    });

    it('returns 400 for negative minAmount', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { minAmount: '-10' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns 400 for negative maxAmount', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { maxAmount: '-5' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('returns empty when no payouts match amount range', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { minAmount: '500', maxAmount: '600' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 0);
      assert.strictEqual(jsonData.total, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Date range filters
  // ═══════════════════════════════════════════════════════════════════════════

  describe('date range filters', () => {
    it('filters by from date only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { from: '2024-01-03' }), res, next);
      const { jsonData } = res._get();
      // pay-3 (Jan 3) and pay-4 (Jan 4)
      assert.strictEqual(jsonData.payouts.length, 2);
    });

    it('filters by to date only', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { to: '2024-01-02' }), res, next);
      const { jsonData } = res._get();
      // pay-1 (Jan 1) and pay-2 (Jan 2)
      assert.strictEqual(jsonData.payouts.length, 2);
    });

    it('filters by both from and to dates', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { from: '2024-01-02', to: '2024-01-03' }), res, next);
      const { jsonData } = res._get();
      // pay-2 (Jan 2) and pay-3 (Jan 3)
      assert.strictEqual(jsonData.payouts.length, 2);
    });

    it('returns 400 for invalid from date', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { from: 'not-a-date' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('from'));
    });

    it('returns 400 for invalid to date', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { to: 'garbage' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('to'));
    });

    it('returns empty when no payouts match date range', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { from: '2025-01-01', to: '2025-12-31' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Sorting
  // ═══════════════════════════════════════════════════════════════════════════

  describe('sorting', () => {
    it('sorts by created_at desc by default', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR), res, next);
      const { jsonData } = res._get();
      const dates = jsonData.payouts.map((p: Payout) => new Date(p.created_at).getTime());
      for (let i = 1; i < dates.length; i++) {
        assert(dates[i] <= dates[i - 1], 'should be descending by created_at');
      }
    });

    it('sorts by created_at asc', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortOrder: 'asc' }), res, next);
      const { jsonData } = res._get();
      const dates = jsonData.payouts.map((p: Payout) => new Date(p.created_at).getTime());
      for (let i = 1; i < dates.length; i++) {
        assert(dates[i] >= dates[i - 1], 'should be ascending by created_at');
      }
    });

    it('sorts by amount desc', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: 'amount', sortOrder: 'desc' }), res, next);
      const { jsonData } = res._get();
      const amounts = jsonData.payouts.map((p: Payout) => parseFloat(p.amount));
      for (let i = 1; i < amounts.length; i++) {
        assert(amounts[i] <= amounts[i - 1], 'should be descending by amount');
      }
    });

    it('sorts by amount asc', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: 'amount', sortOrder: 'asc' }), res, next);
      const { jsonData } = res._get();
      const amounts = jsonData.payouts.map((p: Payout) => parseFloat(p.amount));
      for (let i = 1; i < amounts.length; i++) {
        assert(amounts[i] >= amounts[i - 1], 'should be ascending by amount');
      }
    });

    it('sorts by status', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: 'status', sortOrder: 'asc' }), res, next);
      const { jsonData } = res._get();
      const statuses = jsonData.payouts.map((p: Payout) => p.status);
      for (let i = 1; i < statuses.length; i++) {
        assert(statuses[i] >= statuses[i - 1], 'should be ascending by status');
      }
    });

    it('returns 400 for invalid sortBy', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: 'hackerfield' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('sortBy'));
    });

    it('returns 400 for invalid sortOrder', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortOrder: 'random' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
      assert(res._get().jsonData.error.includes('sortOrder'));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Combined filters + pagination + sorting
  // ═══════════════════════════════════════════════════════════════════════════

  describe('combined filters', () => {
    it('applies status + amount + date + sort + pagination together', async () => {
      const res = makeRes();
      await handlers.listPayouts(
        makeReq(INVESTOR, {
          status: 'processed',
          minAmount: '50',
          from: '2024-01-01',
          to: '2024-01-05',
          sortBy: 'amount',
          sortOrder: 'asc',
          limit: '1',
          offset: '0',
        }),
        res,
        next,
      );
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.total, 2); // pay-1 (100) and pay-2 (200) are both processed
      assert.strictEqual(jsonData.hasMore, true);
      // First by amount asc = 100.00
      assert.strictEqual(jsonData.payouts[0].amount, '100.00');
    });

    it('combined: second page of previous query', async () => {
      const res = makeRes();
      await handlers.listPayouts(
        makeReq(INVESTOR, {
          status: 'processed',
          minAmount: '50',
          from: '2024-01-01',
          to: '2024-01-05',
          sortBy: 'amount',
          sortOrder: 'asc',
          limit: '1',
          offset: '1',
        }),
        res,
        next,
      );
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.payouts[0].amount, '200.00');
      assert.strictEqual(jsonData.hasMore, false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Error handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    it('calls next(err) on repository failure', async () => {
      const failingRepo = { listPayoutsByInvestor: async () => { throw new Error('DB error'); } };
      const failHandlers = createPayoutsHandlers(failingRepo as any);
      let capturedErr: any = null;
      const res = makeRes();
      await failHandlers.listPayouts(makeReq(INVESTOR), res, (e: any) => { capturedErr = e; });
      assert(capturedErr instanceof Error && capturedErr.message === 'DB error');
    });
  });
});

// ─── Stellar Result Code Classification ──────────────────────────────────────

describe('classifyStellarRPCFailure – result codes', () => {
  // ── Transaction-level result codes ────────────────────────────────────────

  describe('tx result codes', () => {
    const txCodes = Array.from(STELLAR_TX_RESULT_CODES);

    it.each(txCodes)('classifies tx code "%s" as TX_RESULT_CODE', (code) => {
      const err = { status: 400, extras: { result_codes: { transaction: code, operations: [] } } };
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.TX_RESULT_CODE);
    });

    it('classifies tx_bad_seq as TX_RESULT_CODE (explicit)', () => {
      const err = { status: 400, extras: { result_codes: { transaction: 'tx_bad_seq' } } };
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.TX_RESULT_CODE);
    });

    it('classifies tx_insufficient_fee as TX_RESULT_CODE (explicit)', () => {
      const err = { status: 400, extras: { result_codes: { transaction: 'tx_insufficient_fee' } } };
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.TX_RESULT_CODE);
    });

    it('classifies tx_bad_auth as TX_RESULT_CODE', () => {
      const err = { status: 400, extras: { result_codes: { transaction: 'tx_bad_auth' } } };
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.TX_RESULT_CODE);
    });

    it('does not classify unknown tx code as TX_RESULT_CODE', () => {
      const err = { status: 400, extras: { result_codes: { transaction: 'tx_unknown_future_code' } } };
      // Falls through to UNKNOWN since status 400 has no other handler
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.UNKNOWN);
    });
  });

  // ── Operation-level result codes ──────────────────────────────────────────

  describe('op result codes', () => {
    const opCodes = Array.from(STELLAR_OP_RESULT_CODES);

    it.each(opCodes)('classifies op code "%s" as OP_RESULT_CODE', (code) => {
      const err = {
        status: 400,
        extras: { result_codes: { transaction: 'tx_failed', operations: [code] } },
      };
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.OP_RESULT_CODE);
    });

    it('classifies op_no_destination as OP_RESULT_CODE (explicit)', () => {
      const err = {
        status: 400,
        extras: { result_codes: { transaction: 'tx_failed', operations: ['op_no_destination'] } },
      };
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.OP_RESULT_CODE);
    });

    it('classifies op_underfunded as OP_RESULT_CODE (explicit)', () => {
      const err = {
        status: 400,
        extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } },
      };
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.OP_RESULT_CODE);
    });

    it('op codes take precedence over tx codes', () => {
      const err = {
        status: 400,
        extras: {
          result_codes: { transaction: 'tx_failed', operations: ['op_no_trust', 'op_success'] },
        },
      };
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.OP_RESULT_CODE);
    });

    it('falls back to TX_RESULT_CODE when ops array has no known codes', () => {
      const err = {
        status: 400,
        extras: {
          result_codes: { transaction: 'tx_bad_seq', operations: ['op_success'] },
        },
      };
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.TX_RESULT_CODE);
    });

    it('handles missing operations array gracefully', () => {
      const err = {
        status: 400,
        extras: { result_codes: { transaction: 'tx_bad_seq' } },
      };
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.TX_RESULT_CODE);
    });
  });

  // ── HTTP status codes (existing behaviour preserved) ──────────────────────

  describe('http status codes', () => {
    it('classifies 429 as RATE_LIMIT', () => {
      assert.strictEqual(classifyStellarRPCFailure({ status: 429 }).class, StellarRPCFailureClass.RATE_LIMIT);
    });

    it('classifies 401 as UNAUTHORIZED', () => {
      assert.strictEqual(classifyStellarRPCFailure({ status: 401 }).class, StellarRPCFailureClass.UNAUTHORIZED);
    });

    it('classifies 403 as UNAUTHORIZED', () => {
      assert.strictEqual(classifyStellarRPCFailure({ status: 403 }).class, StellarRPCFailureClass.UNAUTHORIZED);
    });

    it('classifies 500 as UPSTREAM_ERROR', () => {
      assert.strictEqual(classifyStellarRPCFailure({ status: 500 }).class, StellarRPCFailureClass.UPSTREAM_ERROR);
    });

    it('classifies 503 as UPSTREAM_ERROR', () => {
      assert.strictEqual(classifyStellarRPCFailure({ status: 503 }).class, StellarRPCFailureClass.UPSTREAM_ERROR);
    });
  });

  // ── Timeout / abort ───────────────────────────────────────────────────────

  describe('timeout and abort', () => {
    it('classifies AbortError as TIMEOUT', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      assert.strictEqual(classifyStellarRPCFailure(err).class, StellarRPCFailureClass.TIMEOUT);
    });

    it('classifies message containing "timeout" as TIMEOUT', () => {
      assert.strictEqual(
        classifyStellarRPCFailure(new Error('Request timeout after 30s')).class,
        StellarRPCFailureClass.TIMEOUT,
      );
    });
  });

  // ── Malformed response ────────────────────────────────────────────────────

  describe('malformed response', () => {
    it('classifies SyntaxError as MALFORMED_RESPONSE', () => {
      assert.strictEqual(
        classifyStellarRPCFailure(new SyntaxError('Unexpected token')).class,
        StellarRPCFailureClass.MALFORMED_RESPONSE,
      );
    });
  });

  // ── Unknown / fallback ────────────────────────────────────────────────────

  describe('unknown fallback', () => {
    it('classifies null as UNKNOWN', () => {
      assert.strictEqual(classifyStellarRPCFailure(null).class, StellarRPCFailureClass.UNKNOWN);
    });

    it('classifies plain string as UNKNOWN', () => {
      assert.strictEqual(classifyStellarRPCFailure('some error').class, StellarRPCFailureClass.UNKNOWN);
    });

    it('classifies generic Error as UNKNOWN', () => {
      assert.strictEqual(classifyStellarRPCFailure(new Error('something')).class, StellarRPCFailureClass.UNKNOWN);
    });

    it('classifies object with no status as UNKNOWN', () => {
      assert.strictEqual(classifyStellarRPCFailure({ message: 'oops' }).class, StellarRPCFailureClass.UNKNOWN);
    });
  });

  // ── Security: no raw upstream strings leak ────────────────────────────────

  describe('security: raw upstream strings do not leak', () => {
    it('returns a classified object without leaking the raw upstream message', () => {
      const sensitiveErr = {
        status: 400,
        message: 'secret horizon message',
        extras: {
          result_codes: { transaction: 'tx_bad_seq' },
          envelope_xdr: 'AAAA...sensitive...XDR',
          result_xdr: 'AAAA...sensitive...result',
        },
      };
      const failure = classifyStellarRPCFailure(sensitiveErr);
      assert.strictEqual(failure.class, StellarRPCFailureClass.TX_RESULT_CODE);
      assert.notStrictEqual(failure.originalError as any, sensitiveErr);
      assert.strictEqual((failure.originalError as any).message, 'UPSTREAM_MESSAGE_REDACTED');
      assert(!JSON.stringify(failure.originalError).includes('secret horizon message'));
    });
  });
});

// ─── isStellarRPCRetryable ────────────────────────────────────────────────────

describe('isStellarRPCRetryable', () => {
  it('TIMEOUT is retryable', () => {
    assert.strictEqual(isStellarRPCRetryable(StellarRPCFailureClass.TIMEOUT), true);
  });

  it('UPSTREAM_ERROR is retryable', () => {
    assert.strictEqual(isStellarRPCRetryable(StellarRPCFailureClass.UPSTREAM_ERROR), true);
  });

  it('TX_RESULT_CODE is not retryable', () => {
    assert.strictEqual(isStellarRPCRetryable(StellarRPCFailureClass.TX_RESULT_CODE), false);
  });

  it('OP_RESULT_CODE is not retryable', () => {
    assert.strictEqual(isStellarRPCRetryable(StellarRPCFailureClass.OP_RESULT_CODE), false);
  });

  it('RATE_LIMIT is not retryable (caller must back off)', () => {
    assert.strictEqual(isStellarRPCRetryable(StellarRPCFailureClass.RATE_LIMIT), false);
  });

  it('UNAUTHORIZED is not retryable', () => {
    assert.strictEqual(isStellarRPCRetryable(StellarRPCFailureClass.UNAUTHORIZED), false);
  });

  it('MALFORMED_RESPONSE is not retryable', () => {
    assert.strictEqual(isStellarRPCRetryable(StellarRPCFailureClass.MALFORMED_RESPONSE), false);
  });

  it('UNKNOWN is not retryable', () => {
    assert.strictEqual(isStellarRPCRetryable(StellarRPCFailureClass.UNKNOWN), false);
  });
});

// ─── Retry Storm Tests ────────────────────────────────────────────────────────

describe('payout repo retry storm', () => {
  /**
   * Simulates a repo that fails N times then succeeds.
   * Used to verify that callers respect retry budgets and do not storm the
   * upstream with unbounded retries.
   */
  class FlakyPayoutRepo {
    public callCount = 0;
    constructor(private failTimes: number, private rows: Payout[]) {}
    async listPayoutsByInvestor(investorId: string): Promise<Payout[]> {
      this.callCount++;
      if (this.callCount <= this.failTimes) throw new Error('transient error');
      return this.rows.filter((p) => p.investor_id === investorId);
    }
  }

  const PAYOUT = makePayout({ id: 'pay-r1', investor_id: 'inv-r', status: 'processed', amount: '10.00' });

  it('propagates error to next() on first failure (no built-in retry in handler)', async () => {
    // The payout handler itself does NOT retry — it delegates retry policy to
    // the caller / middleware layer.  A single repo failure must surface as
    // next(err), not silently swallowed.
    const repo = new FlakyPayoutRepo(1, [PAYOUT]);
    const handlers = createPayoutsHandlers(repo as any);
    let capturedErr: any = null;
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-r', role: 'investor' }), res, (e: any) => { capturedErr = e; });
    assert(capturedErr instanceof Error, 'error must be forwarded to next()');
    assert.strictEqual(repo.callCount, 1, 'handler must not retry internally');
  });

  it('does not call repo more than once per request (no storm)', async () => {
    // Ensures the handler never issues multiple repo calls for a single HTTP
    // request, which would amplify load during an outage.
    const repo = new FlakyPayoutRepo(0, [PAYOUT]);
    const handlers = createPayoutsHandlers(repo as any);
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-r', role: 'investor' }), res, next);
    assert.strictEqual(repo.callCount, 1, 'exactly one repo call per request');
  });

  it('does not retry after a non-retryable Stellar result code error', async () => {
    // Simulates a repo that wraps a Stellar tx_bad_seq error.
    // The handler must not retry — tx_bad_seq is a protocol error.
    const txErr = Object.assign(new Error('tx_bad_seq'), {
      status: 400,
      extras: { result_codes: { transaction: 'tx_bad_seq' } },
    });
    const repo = { listPayoutsByInvestor: jest.fn().mockRejectedValue(txErr) };
    const handlers = createPayoutsHandlers(repo as any);
    let capturedErr: any = null;
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-r', role: 'investor' }), res, (e: any) => { capturedErr = e; });
    assert(capturedErr !== null, 'error must propagate');
    assert.strictEqual((repo.listPayoutsByInvestor as jest.Mock).mock.calls.length, 1, 'no retry on protocol error');
    // Verify the error is classified as non-retryable
    assert.strictEqual(
      isStellarRPCRetryable(classifyStellarRPCFailure(txErr).class),
      false,
    );
  });

  it('does not retry after a RATE_LIMIT error (429)', async () => {
    const rateLimitErr = { status: 429, message: 'Too Many Requests' };
    const repo = { listPayoutsByInvestor: jest.fn().mockRejectedValue(rateLimitErr) };
    const handlers = createPayoutsHandlers(repo as any);
    let capturedErr: any = null;
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-r', role: 'investor' }), res, (e: any) => { capturedErr = e; });
    assert(capturedErr !== null);
    assert.strictEqual((repo.listPayoutsByInvestor as jest.Mock).mock.calls.length, 1);
    assert.strictEqual(classifyStellarRPCFailure(rateLimitErr).class, StellarRPCFailureClass.RATE_LIMIT);
    assert.strictEqual(isStellarRPCRetryable(StellarRPCFailureClass.RATE_LIMIT), false);
  });

  it('classifies a timeout error as retryable but handler still does not retry', async () => {
    // The handler itself never retries — retryability is advisory for the
    // caller (e.g. a job queue or middleware).
    const timeoutErr = Object.assign(new Error('Request timeout'), { name: 'AbortError' });
    const repo = { listPayoutsByInvestor: jest.fn().mockRejectedValue(timeoutErr) };
    const handlers = createPayoutsHandlers(repo as any);
    let capturedErr: any = null;
    const res = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-r', role: 'investor' }), res, (e: any) => { capturedErr = e; });
    assert(capturedErr !== null);
    assert.strictEqual((repo.listPayoutsByInvestor as jest.Mock).mock.calls.length, 1);
    assert.strictEqual(classifyStellarRPCFailure(timeoutErr).class, StellarRPCFailureClass.TIMEOUT);
    assert.strictEqual(isStellarRPCRetryable(StellarRPCFailureClass.TIMEOUT), true);
  });
});

// ─── Expanded allowlist, injection, and pagination boundary tests ─────────────
//
// Security assumptions validated here:
//  - sortBy is validated against a strict allowlist before any downstream use;
//    injection strings (SQL fragments, semicolons, comment sequences) must
//    never reach a query layer — they are rejected at the parse boundary.
//  - status and sortOrder are similarly allowlist-gated; no value outside the
//    set may pass validation.
//  - limit is capped at MAX_LIMIT (100); clients cannot request arbitrarily
//    large result sets regardless of what they send.
//  - Default limit of 20 is applied when the parameter is absent.
//  - The repo is always called with the authenticated user's own id, never
//    with a caller-supplied id, preventing IDOR enumeration.
//  - Array-shaped query parameters (e.g. ?sortBy[]=amount) are rejected or
//    treated as absent — they must not bypass the string-type guard.

describe('payouts routes – allowlist injection prevention', () => {
  const repo = new MockPayoutRepo(PAYOUTS);
  const handlers = createPayoutsHandlers(repo as any);

  // ── sortBy injection probes ──────────────────────────────────────────────

  describe('sortBy – SQL injection probes rejected with 400', () => {
    const injectionProbes = [
      'created_at; DROP TABLE payouts--',
      '1 OR 1=1',
      'amount--',
      "status'; SELECT * FROM users--",
      'created_at UNION SELECT password FROM users',
      '(SELECT 1)',
      'amount, (SELECT 1)',
      '\'; DROP TABLE--',
      'created_at\nOR\n1=1',
      'amount\x00',
      '../../../etc/passwd',
      '<script>alert(1)</script>',
      '${7*7}',
      '{{7*7}}',
    ];

    it.each(injectionProbes)(
      'rejects sortBy="%s" with 400 (never reaches repo)',
      async (probe) => {
        const repoSpy = jest.spyOn(repo, 'listPayoutsByInvestor');
        const res = makeRes();
        await handlers.listPayouts(makeReq(INVESTOR, { sortBy: probe }), res, next);
        const { statusCode, jsonData } = res._get();
        assert.strictEqual(statusCode, 400, `expected 400 for sortBy="${probe}"`);
        assert(
          typeof jsonData.error === 'string' && jsonData.error.includes('sortBy'),
          `error message must mention "sortBy", got: ${JSON.stringify(jsonData.error)}`,
        );
        // Critical: repo must NOT have been called — injection never reaches data layer
        expect(repoSpy).not.toHaveBeenCalled();
        repoSpy.mockRestore();
      },
    );

    it('rejects empty string sortBy with 400', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: '' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('rejects sortBy with leading/trailing whitespace (not in allowlist)', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: ' amount ' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('rejects sortBy with uppercase variant (case-sensitive allowlist)', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: 'AMOUNT' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });

    it('rejects sortBy=created_at; (semicolon suffix)', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: 'created_at;' }), res, next);
      assert.strictEqual(res._get().statusCode, 400);
    });
  });

  // ── status injection probes ──────────────────────────────────────────────

  describe('status – out-of-allowlist values rejected with 400', () => {
    const invalidStatuses = [
      'open',
      'closed',
      'cancelled',
      'completed',
      'PENDING',
      'Processed',
      'pending ',
      ' failed',
      "pending'; DROP TABLE--",
      '1 OR 1=1',
      '',
      'null',
      'undefined',
      'true',
    ];

    it.each(invalidStatuses)(
      'rejects status="%s" with 400',
      async (value) => {
        const res = makeRes();
        await handlers.listPayouts(makeReq(INVESTOR, { status: value }), res, next);
        assert.strictEqual(
          res._get().statusCode,
          400,
          `expected 400 for status="${value}"`,
        );
      },
    );

    it('accepts all three valid status values without error', async () => {
      for (const s of ['pending', 'processed', 'failed']) {
        const res = makeRes();
        await handlers.listPayouts(makeReq(INVESTOR, { status: s }), res, next);
        assert.strictEqual(res._get().statusCode, 200, `expected 200 for status="${s}"`);
      }
    });
  });

  // ── sortOrder injection probes ───────────────────────────────────────────

  describe('sortOrder – out-of-allowlist values rejected with 400', () => {
    const invalidOrders = [
      'ASC',
      'DESC',
      'Asc',
      'ascending',
      'descending',
      'random',
      '1',
      '-1',
      'asc; DROP TABLE--',
      'desc OR 1=1',
      '',
      'null',
    ];

    it.each(invalidOrders)(
      'rejects sortOrder="%s" with 400',
      async (value) => {
        const res = makeRes();
        await handlers.listPayouts(makeReq(INVESTOR, { sortOrder: value }), res, next);
        assert.strictEqual(
          res._get().statusCode,
          400,
          `expected 400 for sortOrder="${value}"`,
        );
      },
    );

    it('accepts "asc" and "desc" without error', async () => {
      for (const o of ['asc', 'desc']) {
        const res = makeRes();
        await handlers.listPayouts(makeReq(INVESTOR, { sortOrder: o }), res, next);
        assert.strictEqual(res._get().statusCode, 200, `expected 200 for sortOrder="${o}"`);
      }
    });
  });

  // ── Array-shaped query params (bypass attempt) ───────────────────────────

  describe('array-shaped query parameters are not treated as valid strings', () => {
    it('array sortBy is ignored (falls back to default created_at) and returns 200', async () => {
      // Express parses ?sortBy[]=amount as an array; the handler checks
      // typeof req.query.sortBy === 'string', so an array falls back to the
      // default 'created_at' which is valid — no 400, no injection.
      const req = { user: INVESTOR, query: { sortBy: ['amount', 'status'] } } as any;
      const res = makeRes();
      await handlers.listPayouts(req, res, next);
      // Default sortBy='created_at' is used; request succeeds
      assert.strictEqual(res._get().statusCode, 200);
    });

    it('array sortOrder is ignored (falls back to default desc) and returns 200', async () => {
      const req = { user: INVESTOR, query: { sortOrder: ['asc', 'desc'] } } as any;
      const res = makeRes();
      await handlers.listPayouts(req, res, next);
      assert.strictEqual(res._get().statusCode, 200);
    });

    it('array status is ignored (treated as absent) and returns 200 with all payouts', async () => {
      const req = { user: INVESTOR, query: { status: ['pending', 'processed'] } } as any;
      const res = makeRes();
      await handlers.listPayouts(req, res, next);
      // status is undefined (not a string), so no filter applied
      assert.strictEqual(res._get().statusCode, 200);
      assert.strictEqual(res._get().jsonData.total, 4);
    });

    it('array limit is coerced via parseInt and treated as valid if numeric', async () => {
      // String(array) = "2,10" → parseInt("2,10") = 2 (valid)
      const req = { user: INVESTOR, query: { limit: ['2', '10'] } } as any;
      const res = makeRes();
      await handlers.listPayouts(req, res, next);
      // parseInt(String(['2','10'])) = parseInt('2,10') = 2
      assert.strictEqual(res._get().statusCode, 200);
      assert.strictEqual(res._get().jsonData.limit, 2);
    });
  });
});

// ─── Pagination boundary tests ────────────────────────────────────────────────

describe('payouts routes – pagination boundary coverage', () => {
  const repo = new MockPayoutRepo(PAYOUTS);
  const handlers = createPayoutsHandlers(repo as any);

  describe('limit boundary values', () => {
    it('limit=1 returns exactly one record', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '1' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.limit, 1);
    });

    it('limit=99 is accepted (below MAX_LIMIT)', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '99' }), res, next);
      assert.strictEqual(res._get().statusCode, 200);
      assert.strictEqual(res._get().jsonData.limit, 99);
    });

    it('limit=100 is accepted and not clamped (exactly at MAX_LIMIT)', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '100' }), res, next);
      assert.strictEqual(res._get().statusCode, 200);
      assert.strictEqual(res._get().jsonData.limit, 100);
    });

    it('limit=101 is clamped to 100', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '101' }), res, next);
      assert.strictEqual(res._get().statusCode, 200);
      assert.strictEqual(res._get().jsonData.limit, 100);
    });

    it('limit=999 is clamped to 100 (large over-request)', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '999' }), res, next);
      assert.strictEqual(res._get().jsonData.limit, 100);
    });

    it('limit=0 returns zero records (valid non-negative int)', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '0' }), res, next);
      const { statusCode, jsonData } = res._get();
      assert.strictEqual(statusCode, 200);
      assert.strictEqual(jsonData.limit, 0);
      assert.strictEqual(jsonData.payouts.length, 0);
      assert.strictEqual(jsonData.total, 4); // total reflects unsliced count
      assert.strictEqual(jsonData.hasMore, true);
    });

    it('omitting limit applies default of 20', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, {}), res, next);
      assert.strictEqual(res._get().jsonData.limit, 20);
    });

    it('limit=1.9 is truncated to 1 by parseInt (float string)', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '1.9' }), res, next);
      // parseInt('1.9') = 1 — valid, not rejected
      assert.strictEqual(res._get().statusCode, 200);
      assert.strictEqual(res._get().jsonData.limit, 1);
    });

    it('limit=1e2 is rejected (parseInt("1e2") = 1, but "1e2" is not a plain integer string — parseInt still returns 1)', async () => {
      // parseInt('1e2', 10) = 1 (stops at 'e'), so this is treated as limit=1
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { limit: '1e2' }), res, next);
      assert.strictEqual(res._get().statusCode, 200);
      assert.strictEqual(res._get().jsonData.limit, 1);
    });
  });

  describe('offset boundary values', () => {
    it('offset=0 explicit is identical to omitting offset', async () => {
      const resOmit = makeRes();
      const resZero = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, {}), resOmit, next);
      await handlers.listPayouts(makeReq(INVESTOR, { offset: '0' }), resZero, next);
      assert.deepStrictEqual(
        resOmit._get().jsonData.payouts.map((p: Payout) => p.id),
        resZero._get().jsonData.payouts.map((p: Payout) => p.id),
      );
      assert.strictEqual(resZero._get().jsonData.offset, 0);
    });

    it('offset=3 with 4 total returns 1 record and hasMore=false', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: '3' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 1);
      assert.strictEqual(jsonData.offset, 3);
      assert.strictEqual(jsonData.hasMore, false);
    });

    it('offset=4 with 4 total returns 0 records and hasMore=false', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: '4' }), res, next);
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.payouts.length, 0);
      assert.strictEqual(jsonData.hasMore, false);
    });

    it('offset=1.7 is truncated to 1 by parseInt', async () => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { offset: '1.7' }), res, next);
      assert.strictEqual(res._get().statusCode, 200);
      assert.strictEqual(res._get().jsonData.offset, 1);
    });
  });

  describe('MAX_LIMIT prevents large result set abuse', () => {
    it('a dataset of 200 records is capped at 100 per page', async () => {
      const bigPayouts = Array.from({ length: 200 }, (_, i) =>
        makePayout({ id: `big-${i}`, investor_id: 'inv-big', amount: '1.00', created_at: new Date('2024-01-01') }),
      );
      const bigRepo = new MockPayoutRepo(bigPayouts);
      const bigHandlers = createPayoutsHandlers(bigRepo as any);

      const res = makeRes();
      await bigHandlers.listPayouts(
        makeReq({ id: 'inv-big', role: 'investor' }, { limit: '200' }),
        res,
        next,
      );
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.limit, 100);
      assert.strictEqual(jsonData.payouts.length, 100);
      assert.strictEqual(jsonData.total, 200);
      assert.strictEqual(jsonData.hasMore, true);
    });

    it('second page of a 200-record dataset is also capped at 100', async () => {
      const bigPayouts = Array.from({ length: 200 }, (_, i) =>
        makePayout({ id: `big2-${i}`, investor_id: 'inv-big2', amount: '1.00', created_at: new Date('2024-01-01') }),
      );
      const bigRepo = new MockPayoutRepo(bigPayouts);
      const bigHandlers = createPayoutsHandlers(bigRepo as any);

      const res = makeRes();
      await bigHandlers.listPayouts(
        makeReq({ id: 'inv-big2', role: 'investor' }, { limit: '200', offset: '100' }),
        res,
        next,
      );
      const { jsonData } = res._get();
      assert.strictEqual(jsonData.limit, 100);
      assert.strictEqual(jsonData.payouts.length, 100);
      assert.strictEqual(jsonData.hasMore, false);
    });
  });
});

// ─── Response shape contract ──────────────────────────────────────────────────

describe('payouts routes – response shape contract', () => {
  const repo = new MockPayoutRepo(PAYOUTS);
  const handlers = createPayoutsHandlers(repo as any);

  it('response always includes payouts, total, limit, offset, hasMore', async () => {
    const res = makeRes();
    await handlers.listPayouts(makeReq(INVESTOR), res, next);
    const { jsonData } = res._get();
    assert('payouts' in jsonData, 'missing payouts');
    assert('total' in jsonData, 'missing total');
    assert('limit' in jsonData, 'missing limit');
    assert('offset' in jsonData, 'missing offset');
    assert('hasMore' in jsonData, 'missing hasMore');
  });

  it('payouts array contains records with required payout fields', async () => {
    const res = makeRes();
    await handlers.listPayouts(makeReq(INVESTOR, { limit: '1' }), res, next);
    const payout = res._get().jsonData.payouts[0] as Payout;
    assert(typeof payout.id === 'string', 'id must be string');
    assert(typeof payout.investor_id === 'string', 'investor_id must be string');
    assert(typeof payout.amount === 'string', 'amount must be string');
    assert(['pending', 'processed', 'failed'].includes(payout.status), 'status must be valid');
  });

  it('total reflects filtered count, not raw repo count', async () => {
    const res = makeRes();
    await handlers.listPayouts(makeReq(INVESTOR, { status: 'processed', limit: '1' }), res, next);
    const { jsonData } = res._get();
    // 2 processed payouts for inv-1; limit=1 so only 1 returned but total=2
    assert.strictEqual(jsonData.total, 2);
    assert.strictEqual(jsonData.payouts.length, 1);
  });

  it('hasMore is true when offset + limit < total', async () => {
    const res = makeRes();
    await handlers.listPayouts(makeReq(INVESTOR, { limit: '2', offset: '0' }), res, next);
    assert.strictEqual(res._get().jsonData.hasMore, true);
  });

  it('hasMore is false when offset + limit >= total', async () => {
    const res = makeRes();
    await handlers.listPayouts(makeReq(INVESTOR, { limit: '2', offset: '2' }), res, next);
    assert.strictEqual(res._get().jsonData.hasMore, false);
  });
});

// ─── IDOR prevention: repo called with authenticated user id only ─────────────

describe('payouts routes – IDOR prevention', () => {
  it('repo is called with the authenticated user id, not a query-supplied id', async () => {
    const repoMock = {
      listPayoutsByInvestor: jest.fn().mockResolvedValue([]),
    };
    const handlers = createPayoutsHandlers(repoMock as any);

    // Attacker sends their own auth token (inv-attacker) but tries to read inv-victim data
    // by injecting investor_id into query params — the handler must ignore it
    const req = {
      user: { id: 'inv-attacker', role: 'investor' },
      query: { investor_id: 'inv-victim', investorId: 'inv-victim' },
    } as any;
    const res = makeRes();
    await handlers.listPayouts(req, res, next);

    expect(repoMock.listPayoutsByInvestor).toHaveBeenCalledTimes(1);
    expect(repoMock.listPayoutsByInvestor).toHaveBeenCalledWith('inv-attacker');
    expect(repoMock.listPayoutsByInvestor).not.toHaveBeenCalledWith('inv-victim');
  });

  it('two different investors only see their own payouts from the same repo', async () => {
    const repo = new MockPayoutRepo(PAYOUTS);
    const handlers = createPayoutsHandlers(repo as any);

    const res1 = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-1', role: 'investor' }), res1, next);
    const res2 = makeRes();
    await handlers.listPayouts(makeReq({ id: 'inv-2', role: 'investor' }), res2, next);

    const ids1 = res1._get().jsonData.payouts.map((p: Payout) => p.investor_id);
    const ids2 = res2._get().jsonData.payouts.map((p: Payout) => p.investor_id);

    assert(ids1.every((id: string) => id === 'inv-1'), 'inv-1 must only see own payouts');
    assert(ids2.every((id: string) => id === 'inv-2'), 'inv-2 must only see own payouts');
    assert.strictEqual(ids1.length, 4);
    assert.strictEqual(ids2.length, 1);
  });
});

// ─── Valid allowlist values – all accepted ────────────────────────────────────

describe('payouts routes – all valid allowlist values accepted', () => {
  const repo = new MockPayoutRepo(PAYOUTS);
  const handlers = createPayoutsHandlers(repo as any);

  it.each(['created_at', 'amount', 'status'])(
    'sortBy="%s" returns 200',
    async (field) => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortBy: field }), res, next);
      assert.strictEqual(res._get().statusCode, 200, `expected 200 for sortBy="${field}"`);
    },
  );

  it.each(['asc', 'desc'])(
    'sortOrder="%s" returns 200',
    async (order) => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { sortOrder: order }), res, next);
      assert.strictEqual(res._get().statusCode, 200, `expected 200 for sortOrder="${order}"`);
    },
  );

  it.each(['pending', 'processed', 'failed'])(
    'status="%s" returns 200',
    async (status) => {
      const res = makeRes();
      await handlers.listPayouts(makeReq(INVESTOR, { status }), res, next);
      assert.strictEqual(res._get().statusCode, 200, `expected 200 for status="${status}"`);
    },
  );
});
