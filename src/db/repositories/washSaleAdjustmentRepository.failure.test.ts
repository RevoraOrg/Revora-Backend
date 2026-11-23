/**
 * Regression coverage for the failure and empty-result branches of
 * `WashSaleAdjustmentRepository` (WashSaleAdjustment failure handling).
 *
 * The repository has two explicit outcome contracts that off-chain callers rely on:
 *
 *  - `createWithClient()` throws `Failed to create wash-sale adjustment` when the
 *    INSERT returns no rows, and must never silently resolve with a partial row.
 *  - `findByInvestorOfferingDate()` returns `null` for a miss (idempotency lookup)
 *    instead of throwing.
 *
 * These tests pin those branches, the exact parameter coercion sent to `pg`
 * (numbers → strings, `undefined` disposal id → `null`, `Date` passed through),
 * and the neighbouring happy paths and boundary inputs.
 */

import { Pool, PoolClient } from 'pg';

import {
  CreateWashSaleAdjustmentInput,
  WashSaleAdjustmentRepository,
} from './washSaleAdjustmentRepository';

/** A row as Postgres returns it: numeric columns arrive as strings. */
function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'adj-1',
    investor_id: 'inv-1',
    offering_id: 'off-1',
    lot_id: 'lot-1',
    original_disposal_id: null,
    adjustment_amount: '500.0000000000',
    original_cost_basis_per_unit: '10.0000000000',
    adjusted_cost_basis_per_unit: '15.0000000000',
    window_days: '30',
    disposed_at: new Date('2024-06-15T00:00:00.000Z'),
    created_at: new Date('2024-06-16T00:00:00.000Z'),
    ...overrides,
  };
}

function baseInput(overrides: Partial<CreateWashSaleAdjustmentInput> = {}) {
  return {
    investor_id: 'inv-1',
    offering_id: 'off-1',
    lot_id: 'lot-1',
    adjustment_amount: 500,
    original_cost_basis_per_unit: 10,
    adjusted_cost_basis_per_unit: 15,
    window_days: 30,
    disposed_at: new Date('2024-06-15T00:00:00.000Z'),
    ...overrides,
  } as CreateWashSaleAdjustmentInput;
}

describe('WashSaleAdjustmentRepository — failure and empty-result handling', () => {
  let mockPool: { query: jest.Mock };
  let repo: WashSaleAdjustmentRepository;
  let mockClient: { query: jest.Mock };

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    mockClient = { query: jest.fn() };
    repo = new WashSaleAdjustmentRepository(mockPool as unknown as Pool);
  });

  describe('createWithClient()', () => {
    it('throws when the INSERT returns no rows', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(
        repo.createWithClient(mockClient as unknown as PoolClient, baseInput())
      ).rejects.toThrow('Failed to create wash-sale adjustment');

      expect(mockClient.query).toHaveBeenCalledTimes(1);
    });

    it('does not fall back to the pool when the transaction client fails', async () => {
      const writeError = Object.assign(
        new Error('duplicate key value violates unique constraint "wash_sale_adjustments_key"'),
        { code: '23505' }
      );
      mockClient.query.mockRejectedValueOnce(writeError);

      await expect(
        repo.createWithClient(mockClient as unknown as PoolClient, baseInput())
      ).rejects.toBe(writeError);

      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('coerces numerics to strings, maps an absent disposal id to null and passes the Date through', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [dbRow()], rowCount: 1 });
      const disposedAt = new Date('2024-06-15T00:00:00.000Z');

      await repo.createWithClient(
        mockClient as unknown as PoolClient,
        baseInput({ disposed_at: disposedAt })
      );

      const [query, values] = mockClient.query.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('INSERT INTO wash_sale_adjustments');
      expect(query).toContain('RETURNING *');
      expect(values).toEqual([
        'inv-1',
        'off-1',
        'lot-1',
        null,
        '500',
        '10',
        '15',
        '30',
        disposedAt,
      ]);
    });

    it('preserves an explicit original_disposal_id', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [dbRow({ original_disposal_id: 'disp-9' })], rowCount: 1 });

      await repo.createWithClient(
        mockClient as unknown as PoolClient,
        baseInput({ original_disposal_id: 'disp-9' })
      );

      expect(mockClient.query.mock.calls[0][1][3]).toBe('disp-9');
    });

    it('maps the returned row, including a negative adjustment and a zero window', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          dbRow({
            adjustment_amount: '-500.5000000000',
            window_days: '0',
            original_disposal_id: 'disp-1',
          }),
        ],
        rowCount: 1,
      });

      const created = await repo.createWithClient(
        mockClient as unknown as PoolClient,
        baseInput()
      );

      expect(created.adjustment_amount).toBe(-500.5);
      expect(created.window_days).toBe(0);
      expect(created.original_disposal_id).toBe('disp-1');
      expect(created.created_at).toBeInstanceOf(Date);
    });
  });

  describe('findByInvestorOfferingDate()', () => {
    it('returns null for a miss instead of throwing', async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const found = await repo.findByInvestorOfferingDate(
        mockClient as unknown as PoolClient,
        'inv-1',
        'off-1',
        new Date('2024-06-15T00:00:00.000Z')
      );

      expect(found).toBeNull();
    });

    it('binds the lookup key in order and caps the result at one row', async () => {
      const disposedAt = new Date('2024-06-15T00:00:00.000Z');
      mockClient.query.mockResolvedValueOnce({ rows: [dbRow()], rowCount: 1 });

      await repo.findByInvestorOfferingDate(
        mockClient as unknown as PoolClient,
        'inv-1',
        'off-1',
        disposedAt
      );

      const [query, values] = mockClient.query.mock.calls[0] as [string, unknown[]];
      expect(query).toContain('investor_id = $1');
      expect(query).toContain('offering_id = $2');
      expect(query).toContain('disposed_at = $3');
      expect(query).toContain('ORDER BY created_at DESC');
      expect(query).toContain('LIMIT 1');
      expect(values).toEqual(['inv-1', 'off-1', disposedAt]);
    });

    it('propagates a lookup failure so idempotency cannot silently degrade', async () => {
      const lookupError = new Error('canceling statement due to statement timeout');
      mockClient.query.mockRejectedValueOnce(lookupError);

      await expect(
        repo.findByInvestorOfferingDate(
          mockClient as unknown as PoolClient,
          'inv-1',
          'off-1',
          new Date()
        )
      ).rejects.toBe(lookupError);
    });
  });

  describe('listByInvestor()/listByLot() — empty results and failures', () => {
    it('returns an empty array when an investor has no adjustments', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(repo.listByInvestor('inv-none')).resolves.toEqual([]);
    });

    it('returns an empty array when a lot has no adjustments', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(repo.listByLot('lot-none')).resolves.toEqual([]);
    });

    it('maps every row and preserves list order for the investor query', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          dbRow({ id: 'adj-1', adjustment_amount: '500.0000000000' }),
          dbRow({ id: 'adj-2', adjustment_amount: '250.0000000000', window_days: '15' }),
        ],
        rowCount: 2,
      });

      const rows = await repo.listByInvestor('inv-1');

      expect(rows.map((r) => r.id)).toEqual(['adj-1', 'adj-2']);
      expect(rows.map((r) => r.adjustment_amount)).toEqual([500, 250]);
      expect(rows[1].window_days).toBe(15);
    });

    it('propagates list failures for both selectors', async () => {
      const readError = new Error('terminating connection due to administrator command');

      mockPool.query.mockRejectedValueOnce(readError);
      await expect(repo.listByInvestor('inv-1')).rejects.toBe(readError);

      mockPool.query.mockRejectedValueOnce(readError);
      await expect(repo.listByLot('lot-1')).rejects.toBe(readError);
    });
  });

  describe('factory', () => {
    it('createWashSaleAdjustmentRepository() wires the supplied pool', async () => {
      const { createWashSaleAdjustmentRepository } = await import('./washSaleAdjustmentRepository');
      const fromFactory = createWashSaleAdjustmentRepository(mockPool as unknown as Pool);

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(fromFactory.listByInvestor('inv-1')).resolves.toEqual([]);
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });
  });
});
