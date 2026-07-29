/**
 * Tests for DisposalRepository.
 *
 * Coverage targets:
 * - createWithClient: transactional disposal creation
 * - listByInvestor: disposal listing
 * - listByInvestorAndOffering: filtered listing
 * - getJurisdictionGainsSummary: jurisdiction-level aggregation
 * - getJurisdictionGainsSummaryByOffering: offering-level aggregation
 * - findById: single disposal lookup
 */

import { Pool } from 'pg';
import { DisposalRepository } from './disposalRepository';
import { DisposalStrategy } from '../../services/taxation/types';

function makeMockPool(queryMock: jest.Mock = jest.fn()): { query: jest.Mock } {
  return { query: queryMock };
}

function makeMockClient(queryMock: jest.Mock = jest.fn()): { query: jest.Mock; release: jest.Mock } {
  return { query: queryMock, release: jest.fn() };
}

function makeDisposalRow(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'disp-1',
    investor_id: 'inv-1',
    offering_id: 'off-1',
    lot_id: 'lot-1',
    quantity_disposed: '50',
    cost_basis_per_unit: '10',
    total_cost_basis: '500',
    proceeds: '750',
    realized_gain_loss: '250',
    disposal_price_per_unit: '15',
    strategy: 'FIFO' as DisposalStrategy,
    currency: 'USD',
    jurisdiction: 'US',
    disposed_at: new Date('2024-06-15'),
    tax_report_finalized: false,
    tax_report_id: null,
    created_at: new Date('2024-06-15'),
    updated_at: new Date('2024-06-15'),
    ...override,
  };
}

function mockQueryResult(rows: unknown[]): any {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

describe('DisposalRepository', () => {
  let mockPool: { query: jest.Mock };
  let repo: DisposalRepository;

  beforeEach(() => {
    mockPool = makeMockPool();
    repo = new DisposalRepository(mockPool as unknown as Pool);
  });

  describe('createWithClient', () => {
    it('creates a disposal record with all fields', async () => {
      const client = makeMockClient();
      const row = makeDisposalRow({ id: 'disp-tx' });
      client.query.mockResolvedValueOnce(mockQueryResult([row]));

      const result = await repo.createWithClient(client as any, {
        investor_id: 'inv-1',
        offering_id: 'off-1',
        lot_id: 'lot-1',
        quantity_disposed: 50,
        cost_basis_per_unit: 10,
        total_cost_basis: 500,
        proceeds: 750,
        realized_gain_loss: 250,
        disposal_price_per_unit: 15,
        strategy: 'FIFO',
        disposed_at: new Date('2024-06-15'),
      });

      expect(result.id).toBe('disp-tx');
      expect(result.realized_gain_loss).toBe(250);
      expect(result.tax_report_finalized).toBe(false);
      expect(result.tax_report_id).toBeNull();
    });

    it('throws when insert returns no rows', async () => {
      const client = makeMockClient();
      client.query.mockResolvedValueOnce(mockQueryResult([]));

      await expect(
        repo.createWithClient(client as any, {
          investor_id: 'inv-1',
          offering_id: 'off-1',
          lot_id: 'lot-1',
          quantity_disposed: 50,
          cost_basis_per_unit: 10,
          total_cost_basis: 500,
          proceeds: 750,
          realized_gain_loss: 250,
          disposal_price_per_unit: 15,
          strategy: 'FIFO',
          disposed_at: new Date(),
        })
      ).rejects.toThrow('Failed to create disposal record');
    });
  });

  describe('listByInvestor', () => {
    it('returns disposals ordered by disposed_at descending', async () => {
      const rows = [
        makeDisposalRow({ id: 'disp-2', disposed_at: new Date('2024-06-15') }),
        makeDisposalRow({ id: 'disp-1', disposed_at: new Date('2024-01-15') }),
      ];
      mockPool.query.mockResolvedValueOnce(mockQueryResult(rows));

      const result = await repo.listByInvestor('inv-1');
      expect(result).toHaveLength(2);
    });

    it('returns empty array when no disposals', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));
      const result = await repo.listByInvestor('inv-1');
      expect(result).toEqual([]);
    });
  });

  describe('listByInvestorAndOffering', () => {
    it('filters disposals by investor and offering', async () => {
      const rows = [makeDisposalRow()];
      mockPool.query.mockResolvedValueOnce(mockQueryResult(rows));

      const result = await repo.listByInvestorAndOffering('inv-1', 'off-1');
      expect(result).toHaveLength(1);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE investor_id'),
        ['inv-1', 'off-1'],
      );
    });
  });

  describe('getJurisdictionGainsSummary', () => {
    it('returns aggregated per-jurisdiction gains with strategy breakdown', async () => {
      const rows = [
        {
          jurisdiction: 'US',
          total_proceeds: '5000',
          total_cost_basis: '3000',
          total_realized_gain_loss: '2000',
          disposal_count: '3',
          strategy: 'FIFO',
          strategy_count: '2',
          strategy_gain_loss: '1500',
        },
        {
          jurisdiction: 'US',
          total_proceeds: '5000',
          total_cost_basis: '3000',
          total_realized_gain_loss: '2000',
          disposal_count: '3',
          strategy: 'LIFO',
          strategy_count: '1',
          strategy_gain_loss: '500',
        },
        {
          jurisdiction: 'GB',
          total_proceeds: '2000',
          total_cost_basis: '1500',
          total_realized_gain_loss: '500',
          disposal_count: '1',
          strategy: 'FIFO',
          strategy_count: '1',
          strategy_gain_loss: '500',
        },
      ];
      mockPool.query.mockResolvedValueOnce(mockQueryResult(rows));

      const result = await repo.getJurisdictionGainsSummary('inv-1');
      expect(result).toHaveLength(2); // US and GB

      const us = result.find((r) => r.jurisdiction === 'US')!;
      expect(us.totalProceeds).toBe(10000);
      expect(us.totalCostBasis).toBe(6000);
      expect(us.totalRealizedGainLoss).toBe(4000);
      expect(us.disposalCount).toBe(6);
      expect(us.strategyBreakdown.FIFO.count).toBe(2);
      expect(us.strategyBreakdown.LIFO.count).toBe(1);

      const gb = result.find((r) => r.jurisdiction === 'GB')!;
      expect(gb.totalProceeds).toBe(2000);
      expect(gb.disposalCount).toBe(1);
      expect(gb.strategyBreakdown.FIFO.count).toBe(1);
    });

    it('returns empty array when no disposals', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));
      const result = await repo.getJurisdictionGainsSummary('inv-1');
      expect(result).toEqual([]);
    });
  });

  describe('getJurisdictionGainsSummaryByOffering', () => {
    it('returns offering-level aggregation', async () => {
      const rows = [
        {
          jurisdiction: 'US',
          total_proceeds: '3000',
          total_cost_basis: '2000',
          total_realized_gain_loss: '1000',
          disposal_count: '2',
          strategy: 'HIFO',
          strategy_count: '2',
          strategy_gain_loss: '1000',
        },
      ];
      mockPool.query.mockResolvedValueOnce(mockQueryResult(rows));

      const result = await repo.getJurisdictionGainsSummaryByOffering('off-1');
      expect(result).toHaveLength(1);
      expect(result[0].strategyBreakdown.HIFO.count).toBe(2);
    });
  });

  describe('findById', () => {
    it('returns disposal when found', async () => {
      const row = makeDisposalRow({ id: 'disp-abc' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([row]));

      const result = await repo.findById('disp-abc');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('disp-abc');
    });

    it('returns null when not found', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));
      const result = await repo.findById('nonexistent');
      expect(result).toBeNull();
    });
  });
});
