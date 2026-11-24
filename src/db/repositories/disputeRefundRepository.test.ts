/**
 * Unit tests for DisputeRefundRepository (pool-mocked, no DB).
 *
 * Coverage targets:
 *   create            – SQL parameters and returned row mapping
 *   sumRefundsForDispute – uses pool by default, uses the supplied client when
 *                         one is passed, and returns '0' for empty results
 *   listByDispute     – SQL parameters, ordering clause, and row mapping
 */
import { Pool, PoolClient } from 'pg';
import { DisputeRefund, DisputeRefundRepository } from './disputeRefundRepository';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(query: jest.Mock = jest.fn()): Pool {
  return { query } as unknown as Pool;
}

function makeClient(query: jest.Mock = jest.fn()): PoolClient {
  return { query } as unknown as PoolClient;
}

function makeRefundRow(overrides: Partial<DisputeRefund> = {}): DisputeRefund {
  return {
    id: 'refund-1',
    dispute_id: 'dispute-abc',
    amount: '250.0000',
    reason: 'overpayment',
    ledger_event_id: 'event-1',
    created_at: new Date('2026-01-15T10:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('DisputeRefundRepository.create', () => {
  it('inserts with the correct positional parameters and returns the new row', async () => {
    const row = makeRefundRow();
    const query = jest.fn().mockResolvedValue({ rows: [row] });
    const repo = new DisputeRefundRepository(makePool(query));

    const result = await repo.create({
      dispute_id: 'dispute-abc',
      amount: '250.0000',
      reason: 'overpayment',
      ledger_event_id: 'event-1',
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO dispute_refunds');
    expect(sql).toContain('RETURNING *');
    expect(params).toEqual(['dispute-abc', '250.0000', 'overpayment', 'event-1']);
    expect(result).toEqual(row);
  });

  it('passes null for optional fields when they are null', async () => {
    const row = makeRefundRow({ reason: null, ledger_event_id: null });
    const query = jest.fn().mockResolvedValue({ rows: [row] });
    const repo = new DisputeRefundRepository(makePool(query));

    await repo.create({
      dispute_id: 'dispute-abc',
      amount: '100.0000',
      reason: null,
      ledger_event_id: null,
    });

    const params = query.mock.calls[0][1] as unknown[];
    expect(params[2]).toBeNull();
    expect(params[3]).toBeNull();
  });

  it('propagates a pool query failure without masking the original error', async () => {
    const failure = new Error('connection refused');
    const query = jest.fn().mockRejectedValue(failure);
    const repo = new DisputeRefundRepository(makePool(query));

    await expect(
      repo.create({ dispute_id: 'd', amount: '1.0000', reason: null, ledger_event_id: null }),
    ).rejects.toBe(failure);
  });
});

// ---------------------------------------------------------------------------
// sumRefundsForDispute
// ---------------------------------------------------------------------------

describe('DisputeRefundRepository.sumRefundsForDispute', () => {
  it('queries the pool when no client is supplied and returns the total as a string', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ total: '750.0000' }] });
    const repo = new DisputeRefundRepository(makePool(query));

    const result = await repo.sumRefundsForDispute('dispute-abc');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SELECT COALESCE(SUM(amount), 0)');
    expect(sql).toContain('FROM dispute_refunds');
    expect(params).toEqual(['dispute-abc']);
    expect(result).toBe('750.0000');
  });

  it('uses the supplied transaction client instead of the pool', async () => {
    const poolQuery = jest.fn();
    const clientQuery = jest.fn().mockResolvedValue({ rows: [{ total: '500.0000' }] });
    const client = makeClient(clientQuery);
    const repo = new DisputeRefundRepository(makePool(poolQuery));

    const result = await repo.sumRefundsForDispute('dispute-abc', client);

    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(result).toBe('500.0000');
  });

  it("returns '0' when COALESCE returns 0 (no refunds exist)", async () => {
    // DB returns the integer 0 from COALESCE(SUM(amount), 0) when the table is empty.
    const query = jest.fn().mockResolvedValue({ rows: [{ total: 0 }] });
    const repo = new DisputeRefundRepository(makePool(query));

    const result = await repo.sumRefundsForDispute('dispute-no-refunds');

    expect(result).toBe('0');
  });

  it("returns '0' when the result set is empty (no rows at all)", async () => {
    // Guard against a DB driver that returns no rows instead of a 0 row.
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new DisputeRefundRepository(makePool(query));

    const result = await repo.sumRefundsForDispute('dispute-empty');

    expect(result).toBe('0');
  });

  it('passes the dispute ID as the sole SQL parameter', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ total: '0' }] });
    const repo = new DisputeRefundRepository(makePool(query));

    await repo.sumRefundsForDispute('dispute-xyz');

    expect(query.mock.calls[0][1]).toEqual(['dispute-xyz']);
  });

  it('uses the client for the SQL query params too when a client is supplied', async () => {
    const clientQuery = jest.fn().mockResolvedValue({ rows: [{ total: '100.0000' }] });
    const client = makeClient(clientQuery);
    const repo = new DisputeRefundRepository(makePool());

    await repo.sumRefundsForDispute('dispute-tx', client);

    expect(clientQuery.mock.calls[0][1]).toEqual(['dispute-tx']);
  });
});

// ---------------------------------------------------------------------------
// listByDispute
// ---------------------------------------------------------------------------

describe('DisputeRefundRepository.listByDispute', () => {
  it('queries by dispute_id and returns the mapped rows', async () => {
    const rows = [
      makeRefundRow({ id: 'refund-1', created_at: new Date('2026-01-01T00:00:00Z') }),
      makeRefundRow({ id: 'refund-2', created_at: new Date('2026-01-02T00:00:00Z') }),
    ];
    const query = jest.fn().mockResolvedValue({ rows });
    const repo = new DisputeRefundRepository(makePool(query));

    const result = await repo.listByDispute('dispute-abc');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM dispute_refunds');
    expect(sql).toContain('WHERE dispute_id = $1');
    expect(params).toEqual(['dispute-abc']);
    expect(result).toEqual(rows);
  });

  it('orders results by created_at ASC', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new DisputeRefundRepository(makePool(query));

    await repo.listByDispute('dispute-abc');

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY created_at ASC');
  });

  it('returns an empty array when the dispute has no refunds', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new DisputeRefundRepository(makePool(query));

    const result = await repo.listByDispute('dispute-no-refunds');

    expect(result).toEqual([]);
  });

  it('propagates a pool query failure without masking the original error', async () => {
    const failure = new Error('timeout');
    const query = jest.fn().mockRejectedValue(failure);
    const repo = new DisputeRefundRepository(makePool(query));

    await expect(repo.listByDispute('dispute-abc')).rejects.toBe(failure);
  });
});
