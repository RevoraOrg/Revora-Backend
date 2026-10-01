/**
 * Regression coverage for the explicit failure / empty-result branches of
 * `DistributionRepository` (src/db/repositories/distributionRepository.ts).
 *
 * The sibling `distributionRepository.test.ts` exercises only the happy paths.
 * These tests pin the three branches named in the issue:
 *
 *   - `createDistributionRun` → `throw new Error('Failed to create distribution run')`
 *     when the INSERT returns zero rows,
 *   - `createPayout` → `throw new Error('Failed to create payout')`
 *     when the INSERT returns zero rows,
 *   - `findRunByParams` → `return null` when the idempotency lookup matches nothing,
 *
 * plus the neighbouring normal paths (transaction-client seam, mapper coercion of
 * nullable columns) and the boundary inputs that decide the bound SQL parameters,
 * so a silent behaviour change in any of them fails loudly here.
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import {
  DistributionRepository,
  DistributionRun,
  Payout,
} from './distributionRepository';

/** A `QueryResult` with no returned rows — the exceptional INSERT shape. */
function emptyResult(): QueryResult<any> {
  return { rows: [], rowCount: 0, command: 'INSERT', oid: 0, fields: [] } as QueryResult<any>;
}

/** A `QueryResult` carrying a single row. */
function oneRow(row: Record<string, unknown>): QueryResult<any> {
  return { rows: [row], rowCount: 1, command: 'INSERT', oid: 0, fields: [] } as QueryResult<any>;
}

describe('DistributionRepository failure handling', () => {
  let repository: DistributionRepository;
  let mockPool: { query: jest.Mock };
  let mockClient: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    mockClient = { query: jest.fn() };
    repository = new DistributionRepository(mockPool as unknown as Pool);
  });

  describe('createDistributionRun — zero-row INSERT is a hard failure', () => {
    it('throws `Failed to create distribution run` when the INSERT returns no rows', async () => {
      mockPool.query.mockResolvedValueOnce(emptyResult());

      await expect(
        repository.createDistributionRun({
          offering_id: 'offering-123',
          period_id: 'period-456',
          total_amount: '10000.50',
        })
      ).rejects.toThrow('Failed to create distribution run');
    });

    it('is deterministic: the same rejection is produced on every attempt', async () => {
      mockPool.query.mockResolvedValue(emptyResult());

      const messages: string[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await repository
          .createDistributionRun({
            offering_id: 'offering-123',
            period_id: 'period-456',
            total_amount: '10000.50',
          })
          .then(
            () => messages.push('resolved'),
            (error: Error) => messages.push(error.message)
          );
      }

      expect(messages).toEqual([
        'Failed to create distribution run',
        'Failed to create distribution run',
        'Failed to create distribution run',
      ]);
    });

    it('issues exactly one INSERT and never falls back to a second query or a synthesised row', async () => {
      mockPool.query.mockResolvedValueOnce(emptyResult());

      await expect(
        repository.createDistributionRun({
          offering_id: 'offering-123',
          period_id: 'period-456',
          total_amount: '10000.50',
        })
      ).rejects.toThrow();

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT\s+INTO\s+distributions/i),
        ['offering-123', 'period-456', '10000.50', expect.any(Date), 'pending', null]
      );
    });

    it('neighbouring normal path: a single returned row is mapped, not thrown', async () => {
      mockPool.query.mockResolvedValueOnce(
        oneRow({
          id: 'run-1',
          offering_id: 'offering-123',
          period_id: 'period-456',
          total_amount: '10000.50',
          status: 'pending',
          tx_batch_id: 'batch-9',
          frozen_fx_rate_id: null,
          run_at: new Date('2026-07-01T00:00:00.000Z'),
          created_at: new Date('2026-07-01T00:00:00.000Z'),
          updated_at: new Date('2026-07-01T00:00:00.000Z'),
        })
      );

      const run: DistributionRun = await repository.createDistributionRun({
        offering_id: 'offering-123',
        period_id: 'period-456',
        total_amount: '10000.50',
      });

      expect(run.id).toBe('run-1');
      expect(run.tx_batch_id).toBe('batch-9');
      // `frozen_fx_rate_id` is coerced from NULL to `undefined` by the mapper.
      expect(run.frozen_fx_rate_id).toBeUndefined();
    });
  });

  describe('createPayout — zero-row INSERT is a hard failure', () => {
    it('throws `Failed to create payout` when the INSERT returns no rows', async () => {
      mockPool.query.mockResolvedValueOnce(emptyResult());

      await expect(
        repository.createPayout({
          distribution_id: 'run-1',
          investor_id: 'inv-1',
          amount: '250.00',
        })
      ).rejects.toThrow('Failed to create payout');
    });

    it('is deterministic and does not fall through to a mapped aggregate', async () => {
      mockPool.query.mockResolvedValue(emptyResult());

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          repository.createPayout({
            distribution_id: 'run-1',
            investor_id: 'inv-1',
            amount: '250.00',
          })
        ).rejects.toThrow('Failed to create payout');
      }

      // Two attempts → exactly two INSERTs, no reads.
      expect(mockPool.query).toHaveBeenCalledTimes(2);
      for (const call of mockPool.query.mock.calls) {
        expect(String(call[0])).toMatch(/INSERT\s+INTO\s+distribution_payouts/i);
      }
    });

    it('neighbouring normal path: the returned payout row keeps its nullable columns as `undefined`', async () => {
      mockPool.query.mockResolvedValueOnce(
        oneRow({
          id: 'p-1',
          distribution_id: 'run-1',
          investor_id: 'inv-1',
          amount: '250.00',
          status: 'pending',
          tx_hash: null,
          frozen_fx_rate_id: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
      );

      const payout: Payout = await repository.createPayout({
        distribution_id: 'run-1',
        investor_id: 'inv-1',
        amount: '250.00',
      });

      expect(payout.id).toBe('p-1');
      expect(payout.tx_hash).toBeUndefined();
      expect(payout.frozen_fx_rate_id).toBeUndefined();
    });

    it('treats an empty-string tx_hash as absent, matching the INSERT parameter', async () => {
      mockPool.query.mockResolvedValueOnce(oneRow({ id: 'p-2', tx_hash: '' }));

      const payout = await repository.createPayout({
        distribution_id: 'run-1',
        investor_id: 'inv-1',
        amount: '250.00',
        tx_hash: '',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT\s+INTO\s+distribution_payouts/i),
        ['run-1', 'inv-1', '250.00', 'pending', null, null]
      );
      expect(payout.tx_hash).toBeUndefined();
    });
  });

  describe('findRunByParams — empty lookup is a null result, not an error', () => {
    it('returns null when no run matches the idempotency key', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      await expect(
        repository.findRunByParams('offering-123', 'period-456', '1000.00')
      ).resolves.toBeNull();
    });

    it('does not throw for the empty result and still queries by all three parameters', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const result = await repository.findRunByParams('offering-123', 'period-456', '0.00');

      expect(result).toBeNull();
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/SELECT\s+\*\s+FROM\s+distributions/i),
        ['offering-123', 'period-456', '0.00']
      );
    });

    it('boundary: a zero-amount lookup behaves like any other miss', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      await expect(repository.findRunByParams('o', 'p', '0')).resolves.toBeNull();

      mockPool.query.mockResolvedValueOnce(
        oneRow({
          id: 'run-zero',
          offering_id: 'o',
          period_id: 'p',
          total_amount: '0',
          status: 'pending',
          frozen_fx_rate_id: 'rate-1',
          run_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        })
      );
      const hit = await repository.findRunByParams('o', 'p', '0');
      expect(hit?.id).toBe('run-zero');
      expect(hit?.total_amount).toBe('0');
      expect(hit?.frozen_fx_rate_id).toBe('rate-1');
    });

    it('boundary: a matching row with a NULL frozen rate maps to `undefined` rather than null', async () => {
      mockPool.query.mockResolvedValueOnce(
        oneRow({
          id: 'run-2',
          offering_id: 'o',
          period_id: 'p',
          total_amount: '10.00',
          status: 'completed',
          frozen_fx_rate_id: null,
          run_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        })
      );

      const run = await repository.findRunByParams('o', 'p', '10.00');
      expect(run).not.toBeNull();
      expect(run?.frozen_fx_rate_id).toBeUndefined();
    });
  });

  describe('transaction-client seam (the neighbouring path taken inside a transaction)', () => {
    it('createDistributionRun prefers the supplied client and never touches the pool', async () => {
      mockClient.query.mockResolvedValueOnce(
        oneRow({
          id: 'run-tx',
          offering_id: 'o',
          period_id: 'p',
          total_amount: '5.00',
          status: 'pending',
          run_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        })
      );

      const run = await repository.createDistributionRun(
        { offering_id: 'o', period_id: 'p', total_amount: '5.00' },
        mockClient as unknown as PoolClient
      );

      expect(run.id).toBe('run-tx');
      expect(mockClient.query).toHaveBeenCalledTimes(1);
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('createDistributionRun surfaces the same failure through the client seam', async () => {
      mockClient.query.mockResolvedValueOnce(emptyResult());

      await expect(
        repository.createDistributionRun(
          { offering_id: 'o', period_id: 'p', total_amount: '5.00' },
          mockClient as unknown as PoolClient
        )
      ).rejects.toThrow('Failed to create distribution run');

      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('createPayout prefers the supplied client and surfaces its failure', async () => {
      mockClient.query.mockResolvedValueOnce(emptyResult());

      await expect(
        repository.createPayout(
          { distribution_id: 'run-1', investor_id: 'inv-1', amount: '1.00' },
          mockClient as unknown as PoolClient
        )
      ).rejects.toThrow('Failed to create payout');

      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('updateRunStatus prefers the supplied client', async () => {
      mockClient.query.mockResolvedValueOnce({ rowCount: 1 });

      await repository.updateRunStatus(
        'run-1',
        'failed',
        mockClient as unknown as PoolClient
      );

      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE\s+distributions\s+SET\s+status\s+=\s+\$1/i),
        ['failed', 'run-1']
      );
      expect(mockPool.query).not.toHaveBeenCalled();
    });
  });

  describe('boundary inputs that decide the bound INSERT parameters', () => {
    it('createDistributionRun: an explicit status and run_at are forwarded verbatim', async () => {
      const runAt = new Date('2026-01-02T03:04:05.000Z');
      mockPool.query.mockResolvedValueOnce(oneRow({ id: 'run-x' }));

      await repository.createDistributionRun({
        offering_id: 'o',
        period_id: 'p',
        total_amount: '1.00',
        status: 'failed',
        run_at: runAt,
        frozen_fx_rate_id: 'rate-7',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT\s+INTO\s+distributions/i),
        ['o', 'p', '1.00', runAt, 'failed', 'rate-7']
      );
    });

    it('createDistributionRun: an empty-string frozen_fx_rate_id is stored as NULL', async () => {
      mockPool.query.mockResolvedValueOnce(oneRow({ id: 'run-y' }));

      await repository.createDistributionRun({
        offering_id: 'o',
        period_id: 'p',
        total_amount: '1.00',
        frozen_fx_rate_id: '',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT\s+INTO\s+distributions/i),
        ['o', 'p', '1.00', expect.any(Date), 'pending', null]
      );
    });

    it('createPayout: an explicit status and tx_hash are forwarded verbatim', async () => {
      mockPool.query.mockResolvedValueOnce(oneRow({ id: 'p-x' }));

      await repository.createPayout({
        distribution_id: 'run-1',
        investor_id: 'inv-1',
        amount: '0.01',
        status: 'processed',
        tx_hash: '0xabc',
        frozen_fx_rate_id: 'rate-7',
      });

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT\s+INTO\s+distribution_payouts/i),
        ['run-1', 'inv-1', '0.01', 'processed', '0xabc', 'rate-7']
      );
    });
  });
});
