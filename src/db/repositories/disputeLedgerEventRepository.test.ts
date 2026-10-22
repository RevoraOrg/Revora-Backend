import { QueryResult } from 'pg';
import { DisputeLedgerEventRepository } from './disputeLedgerEventRepository';

/**
 * Behaviour suite for `src/db/repositories/disputeLedgerEventRepository.ts`.
 *
 * `DisputeLedgerEventRepository` is the write path for dispute ledger entries —
 * it backs the money-moving side of a dispute (refunds, adjustments). These
 * tests pin the SQL contract that matters for correctness:
 *   - an empty batch is a no-op that never round-trips to Postgres;
 *   - inserts are parameterized with a 4-column placeholder group per event, in
 *     `(dispute_id, investor_id, amount, type)` order, with no value ever
 *     interpolated into the SQL string;
 *   - a caller-supplied `PoolClient` (transaction) is used instead of the pool;
 *   - reads are scoped by `dispute_id` and ordered deterministically;
 *   - `RETURNING *` rows are surfaced verbatim, including the empty case.
 */

function mockResult(rows: unknown[]): QueryResult<any> {
  return { rows, rowCount: rows.length, command: 'INSERT', oid: 0, fields: [] };
}

function makeEvent(overrides: Partial<{ dispute_id: string; investor_id: string; amount: string; type: string }> = {}) {
  return {
    dispute_id: 'dispute-1',
    investor_id: 'investor-1',
    amount: '100.50',
    type: 'refund',
    ...overrides,
  };
}

describe('DisputeLedgerEventRepository', () => {
  let pool: { query: jest.Mock };
  let repo: DisputeLedgerEventRepository;

  beforeEach(() => {
    pool = { query: jest.fn() };
    repo = new DisputeLedgerEventRepository(pool as never);
  });

  describe('createBatch', () => {
    it('short-circuits an empty batch without querying the database', async () => {
      const rows = await repo.createBatch([]);

      expect(rows).toEqual([]);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('does not query when an empty batch is given a transaction client', async () => {
      const client = { query: jest.fn() };

      const rows = await repo.createBatch([], client as never);

      expect(rows).toEqual([]);
      expect(client.query).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('inserts a single event with a $1..$4 placeholder group in column order', async () => {
      const inserted = { id: 'evt-1', ...makeEvent(), created_at: new Date() };
      pool.query.mockResolvedValueOnce(mockResult([inserted]));

      const rows = await repo.createBatch([makeEvent()]);

      expect(rows).toEqual([inserted]);
      expect(pool.query).toHaveBeenCalledTimes(1);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO dispute_ledger_events');
      expect(sql).toContain('(dispute_id, investor_id, amount, type)');
      expect(sql).toContain('VALUES ($1, $2, $3, $4)');
      expect(sql).toContain('RETURNING *');
      expect(params).toEqual(['dispute-1', 'investor-1', '100.50', 'refund']);
    });

    it('groups placeholders per event for a multi-event batch', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await repo.createBatch([
        makeEvent({ dispute_id: 'dispute-a', amount: '1' }),
        makeEvent({ dispute_id: 'dispute-b', amount: '2', type: 'adjustment' }),
        makeEvent({ dispute_id: 'dispute-c', investor_id: 'investor-3', amount: '3' }),
      ]);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12)');
      expect(params).toEqual([
        'dispute-a', 'investor-1', '1', 'refund',
        'dispute-b', 'investor-1', '2', 'adjustment',
        'dispute-c', 'investor-3', '3', 'refund',
      ]);
    });

    it('never interpolates values into the SQL string', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));
      const injection = "'; DROP TABLE dispute_ledger_events; --";

      await repo.createBatch([makeEvent({ dispute_id: injection, investor_id: injection })]);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).not.toContain('DROP TABLE');
      expect(sql).not.toContain(injection);
      expect(params).toContain(injection);
    });

    it('uses the supplied transaction client and leaves the pool untouched', async () => {
      const client = { query: jest.fn().mockResolvedValue(mockResult([{ id: 'evt-tx' }])) };

      const rows = await repo.createBatch([makeEvent()], client as never);

      expect(rows).toEqual([{ id: 'evt-tx' }]);
      expect(client.query).toHaveBeenCalledTimes(1);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('returns an empty array when RETURNING yields no rows', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await expect(repo.createBatch([makeEvent()])).resolves.toEqual([]);
    });

    it('propagates database errors instead of swallowing them', async () => {
      const failure = new Error('relation "dispute_ledger_events" does not exist');
      pool.query.mockRejectedValueOnce(failure);

      await expect(repo.createBatch([makeEvent()])).rejects.toThrow(failure);
    });

    it('preserves string amounts verbatim (no numeric coercion)', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await repo.createBatch([{ dispute_id: 'd', investor_id: 'i', amount: '0.0000001', type: 'adjustment' }]);

      expect(pool.query.mock.calls[0][1]).toEqual(['d', 'i', '0.0000001', 'adjustment']);
    });
  });

  describe('listByDispute', () => {
    it('scopes the query to one dispute and returns its rows', async () => {
      const rows = [{ id: 'evt-1', ...makeEvent(), created_at: new Date() }];
      pool.query.mockResolvedValueOnce(mockResult(rows));

      const result = await repo.listByDispute('dispute-1');

      expect(result).toEqual(rows);
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toContain('FROM dispute_ledger_events');
      expect(sql).toContain('WHERE dispute_id = $1');
      expect(sql).toContain('ORDER BY created_at ASC');
      expect(params).toEqual(['dispute-1']);
    });

    it('returns an empty array when no events exist for the dispute', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));

      await expect(repo.listByDispute('dispute-with-none')).resolves.toEqual([]);
    });

    it('parameterizes the dispute id rather than interpolating it', async () => {
      pool.query.mockResolvedValueOnce(mockResult([]));
      const injection = "' OR 1=1 --";

      await repo.listByDispute(injection);

      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).not.toContain('OR 1=1');
      expect(params).toEqual([injection]);
    });

    it('propagates database errors', async () => {
      pool.query.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(repo.listByDispute('dispute-1')).rejects.toThrow('connection terminated');
    });
  });
});
