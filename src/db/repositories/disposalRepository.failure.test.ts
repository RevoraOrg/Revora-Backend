/**
 * Additional failure-path and boundary coverage for `DisposalRepository`.
 *
 * Complements `disposalRepository.test.ts` by pinning:
 * - the exact parameter mapping of `createWithClient` (including its
 *   currency/jurisdiction defaults and numeric stringification),
 * - propagation of a database-level rejection,
 * - the unknown-strategy boundary in the jurisdiction aggregation, and
 * - the empty-result contract of the read helpers.
 */

import { Pool } from 'pg';
import { DisposalRepository } from './disposalRepository';
import type { DisposalStrategy } from '../../services/taxation/types';

function makeMockClient(queryMock: jest.Mock = jest.fn()) {
  return { query: queryMock, release: jest.fn() };
}

function makeMockPool(queryMock: jest.Mock = jest.fn()) {
  return { query: queryMock };
}

function mockQueryResult(rows: unknown[]): any {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function createInput(override: Record<string, unknown> = {}) {
  return {
    investor_id: 'inv-1',
    offering_id: 'off-1',
    lot_id: 'lot-1',
    quantity_disposed: 50,
    cost_basis_per_unit: 10,
    total_cost_basis: 500,
    proceeds: 750,
    realized_gain_loss: 250,
    disposal_price_per_unit: 15,
    strategy: 'FIFO' as DisposalStrategy,
    disposed_at: new Date('2024-06-15'),
    ...override,
  } as any;
}

describe('DisposalRepository failure handling', () => {
  let mockPool: { query: jest.Mock };
  let repo: DisposalRepository;

  beforeEach(() => {
    mockPool = makeMockPool();
    repo = new DisposalRepository(mockPool as unknown as Pool);
  });

  describe('createWithClient parameter contract', () => {
    it('stringifies numerics and applies the USD/US defaults', async () => {
      const client = makeMockClient();
      client.query.mockResolvedValueOnce(mockQueryResult([{ id: 'disp-1' }]));

      await repo.createWithClient(client as any, createInput());

      expect(client.query).toHaveBeenCalledTimes(1);
      const [sql, params] = client.query.mock.calls[0];
      expect(String(sql)).toContain('INSERT INTO disposals');
      expect(params[3]).toBe('50');
      expect(params[4]).toBe('10');
      expect(params[5]).toBe('500');
      expect(params[6]).toBe('750');
      expect(params[7]).toBe('250');
      expect(params[8]).toBe('15');
      expect(params[9]).toBe('FIFO');
      expect(params[10]).toBe('USD');
      expect(params[11]).toBe('US');
    });

    it('honours explicit currency and jurisdiction overrides', async () => {
      const client = makeMockClient();
      client.query.mockResolvedValueOnce(mockQueryResult([{ id: 'disp-2' }]));

      await repo.createWithClient(
        client as any,
        createInput({ currency: 'EUR', jurisdiction: 'GB' }),
      );

      const [, params] = client.query.mock.calls[0];
      expect(params[10]).toBe('EUR');
      expect(params[11]).toBe('GB');
    });

    it('propagates a database rejection instead of masking it', async () => {
      const client = makeMockClient();
      const dbError = new Error('deadlock detected');
      client.query.mockRejectedValueOnce(dbError);

      await expect(repo.createWithClient(client as any, createInput())).rejects.toBe(dbError);
    });

    it('throws the exact immutability error when the insert returns no rows', async () => {
      const client = makeMockClient();
      client.query.mockResolvedValueOnce(mockQueryResult([]));

      await expect(repo.createWithClient(client as any, createInput())).rejects.toThrow(
        'Failed to create disposal record',
      );
    });
  });

  describe('read helpers empty-result contract', () => {
    it('findById returns null for zero rows without throwing', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));
      await expect(repo.findById('missing')).resolves.toBeNull();
    });

    it('listByInvestorAndOffering returns an empty array for zero rows', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));
      await expect(repo.listByInvestorAndOffering('inv-1', 'off-1')).resolves.toEqual([]);
    });

    it('passes the offering id through to the query parameters', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));
      await repo.getJurisdictionGainsSummaryByOffering('off-42');

      const [, params] = mockPool.query.mock.calls[0];
      expect(params).toEqual(['off-42']);
    });
  });

  describe('aggregation unknown-strategy boundary', () => {
    it('counts totals but ignores a strategy outside FIFO/LIFO/HIFO', async () => {
      mockPool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            jurisdiction: 'US',
            total_proceeds: '1000',
            total_cost_basis: '600',
            total_realized_gain_loss: '400',
            disposal_count: '1',
            strategy: 'UNKNOWN_STRATEGY',
            strategy_count: '1',
            strategy_gain_loss: '400',
          },
        ]),
      );

      const result = await repo.getJurisdictionGainsSummary('inv-1');

      expect(result).toHaveLength(1);
      expect(result[0].totalProceeds).toBe(1000);
      expect(result[0].disposalCount).toBe(1);
      expect(result[0].strategyBreakdown.FIFO).toEqual({ count: 0, totalGainLoss: 0 });
      expect(result[0].strategyBreakdown.LIFO).toEqual({ count: 0, totalGainLoss: 0 });
      expect(result[0].strategyBreakdown.HIFO).toEqual({ count: 0, totalGainLoss: 0 });
    });

    it('combines a known and an unknown strategy row for the same jurisdiction', async () => {
      mockPool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            jurisdiction: 'US',
            total_proceeds: '1000',
            total_cost_basis: '600',
            total_realized_gain_loss: '400',
            disposal_count: '1',
            strategy: 'HIFO',
            strategy_count: '1',
            strategy_gain_loss: '400',
          },
          {
            jurisdiction: 'US',
            total_proceeds: '500',
            total_cost_basis: '300',
            total_realized_gain_loss: '200',
            disposal_count: '1',
            strategy: 'UNKNOWN_STRATEGY',
            strategy_count: '1',
            strategy_gain_loss: '200',
          },
        ]),
      );

      const result = await repo.getJurisdictionGainsSummary('inv-1');

      expect(result).toHaveLength(1);
      expect(result[0].totalProceeds).toBe(1500);
      expect(result[0].totalRealizedGainLoss).toBe(600);
      expect(result[0].disposalCount).toBe(2);
      expect(result[0].strategyBreakdown.HIFO).toEqual({ count: 1, totalGainLoss: 400 });
    });

    it('parses fractional numeric aggregates without truncating them', async () => {
      mockPool.query.mockResolvedValueOnce(
        mockQueryResult([
          {
            jurisdiction: 'US',
            total_proceeds: '1000.25',
            total_cost_basis: '600.10',
            total_realized_gain_loss: '400.15',
            disposal_count: '3',
            strategy: 'FIFO',
            strategy_count: '3',
            strategy_gain_loss: '400.15',
          },
        ]),
      );

      const result = await repo.getJurisdictionGainsSummary('inv-1');

      expect(result[0].totalProceeds).toBeCloseTo(1000.25, 5);
      expect(result[0].totalCostBasis).toBeCloseTo(600.1, 5);
      expect(result[0].totalRealizedGainLoss).toBeCloseTo(400.15, 5);
      expect(result[0].strategyBreakdown.FIFO).toEqual({ count: 3, totalGainLoss: 400.15 });
    });
  });
});
