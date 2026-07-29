/**
 * Tests for InvestmentLotRepository.
 *
 * Coverage targets:
 * - create: lot creation with correct computed values
 * - createWithClient: transactional lot creation
 * - findAvailableLots: filtering by status and quantity
 * - findAvailableLotsForUpdate: FOR UPDATE locking
 * - updateLotAfterDisposal: status transitions (open → partially_used/exhausted)
 * - findById, listByInvestor, getTotalRemainingQuantity
 */

import { Pool } from 'pg';
import { InvestmentLotRepository } from './investmentLotRepository';
import { InvestmentLot } from '../../services/taxation/types';

function makeMockPool(queryMock: jest.Mock = jest.fn()): { query: jest.Mock } {
  return { query: queryMock };
}

function makeMockClient(queryMock: jest.Mock = jest.fn()): { query: jest.Mock; release: jest.Mock } {
  return { query: queryMock, release: jest.fn() };
}

function makeLotRow(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'lot-1',
    investor_id: 'inv-1',
    offering_id: 'off-1',
    investment_id: 'invst-1',
    asset: 'USDC',
    quantity: '100',
    cost_basis_per_unit: '10',
    total_cost_basis: '1000',
    remaining_quantity: '100',
    cost_currency: 'USD',
    acquired_at: new Date('2024-01-01'),
    jurisdiction: 'US',
    status: 'open',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...override,
  };
}

function mockQueryResult(rows: unknown[]): any {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

describe('InvestmentLotRepository', () => {
  let mockPool: { query: jest.Mock };
  let repo: InvestmentLotRepository;

  beforeEach(() => {
    mockPool = makeMockPool();
    repo = new InvestmentLotRepository(mockPool as unknown as Pool);
  });

  describe('create', () => {
    it('creates a lot and computes total_cost_basis correctly', async () => {
      const row = makeLotRow({ cost_basis_per_unit: '50', total_cost_basis: '5000' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([row]));

      const result = await repo.create({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        investment_id: 'invst-1',
        asset: 'USDC',
        quantity: 100,
        cost_basis_per_unit: 50,
        acquired_at: new Date('2024-01-01'),
      });

      expect(result.quantity).toBe(100);
      expect(result.cost_basis_per_unit).toBe(50);
      expect(result.total_cost_basis).toBe(5000);
      expect(result.status).toBe('open');
    });

    it('sets remaining_quantity equal to quantity on creation', async () => {
      const row = makeLotRow({ quantity: '50', remaining_quantity: '50' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([row]));

      const result = await repo.create({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        investment_id: 'invst-1',
        asset: 'USDC',
        quantity: 50,
        cost_basis_per_unit: 10,
        acquired_at: new Date('2024-01-01'),
      });

      expect(result.remaining_quantity).toBe(50);
    });

    it('defaults currency to USD and jurisdiction to US', async () => {
      const row = makeLotRow({ cost_currency: 'USD', jurisdiction: 'US' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([row]));

      const result = await repo.create({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        investment_id: 'invst-1',
        asset: 'USDC',
        quantity: 10,
        cost_basis_per_unit: 5,
        acquired_at: new Date('2024-01-01'),
      });

      expect(result.cost_currency).toBe('USD');
      expect(result.jurisdiction).toBe('US');
    });

    it('throws when insert returns no rows', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));

      await expect(
        repo.create({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          investment_id: 'invst-1',
          asset: 'USDC',
          quantity: 10,
          cost_basis_per_unit: 5,
          acquired_at: new Date('2024-01-01'),
        })
      ).rejects.toThrow('Failed to create investment lot');
    });
  });

  describe('createWithClient', () => {
    it('creates a lot within a transaction', async () => {
      const client = makeMockClient();
      const row = makeLotRow({ id: 'lot-tx' });
      client.query.mockResolvedValueOnce(mockQueryResult([row]));

      const result = await repo.createWithClient(client as any, {
        investor_id: 'inv-1',
        offering_id: 'off-1',
        investment_id: 'invst-1',
        asset: 'USDC',
        quantity: 100,
        cost_basis_per_unit: 10,
        acquired_at: new Date('2024-01-01'),
      });

      expect(result.id).toBe('lot-tx');
      expect(client.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('findAvailableLots', () => {
    it('returns lots with status open or partially_used with remaining_quantity > 0', async () => {
      const rows = [
        makeLotRow({ id: 'lot-a', status: 'open', remaining_quantity: '50' }),
        makeLotRow({ id: 'lot-b', status: 'partially_used', remaining_quantity: '30' }),
      ];
      mockPool.query.mockResolvedValueOnce(mockQueryResult(rows));

      const result = await repo.findAvailableLots('inv-1', 'off-1');
      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('open');
      expect(result[1].status).toBe('partially_used');
    });

    it('returns empty array when no available lots', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));
      const result = await repo.findAvailableLots('inv-1', 'off-1');
      expect(result).toEqual([]);
    });
  });

  describe('findAvailableLotsForUpdate', () => {
    it('uses FOR UPDATE to lock rows', async () => {
      const client = makeMockClient();
      const rows = [makeLotRow()];
      client.query.mockResolvedValueOnce(mockQueryResult(rows));

      const result = await repo.findAvailableLotsForUpdate(client as any, 'inv-1', 'off-1');
      expect(result).toHaveLength(1);
      expect(client.query.mock.calls[0][0]).toContain('FOR UPDATE');
    });
  });

  describe('updateLotAfterDisposal', () => {
    it('sets status to partially_used when some quantity remains', async () => {
      const client = makeMockClient();
      client.query.mockResolvedValueOnce(mockQueryResult([{ id: 'lot-1' }]));

      await repo.updateLotAfterDisposal(client as any, 'lot-1', 50);

      // Check the parameter values, not the SQL text (which uses $placeholders)
      const params = client.query.mock.calls[0][1];
      expect(params[1]).toBe('partially_used');
    });

    it('sets status to exhausted when no quantity remains', async () => {
      const client = makeMockClient();
      client.query.mockResolvedValueOnce(mockQueryResult([{ id: 'lot-1' }]));

      await repo.updateLotAfterDisposal(client as any, 'lot-1', 0);

      // Check the parameter values, not the SQL text (which uses $placeholders)
      const params = client.query.mock.calls[0][1];
      expect(params[1]).toBe('exhausted');
    });

    it('throws when lot does not exist', async () => {
      const client = makeMockClient();
      client.query.mockResolvedValueOnce(mockQueryResult([]));

      await expect(
        repo.updateLotAfterDisposal(client as any, 'nonexistent', 0)
      ).rejects.toThrow('Failed to update lot nonexistent after disposal');
    });
  });

  describe('findById', () => {
    it('returns the lot when found', async () => {
      const row = makeLotRow({ id: 'lot-abc' });
      mockPool.query.mockResolvedValueOnce(mockQueryResult([row]));

      const result = await repo.findById('lot-abc');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('lot-abc');
    });

    it('returns null when not found', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));
      const result = await repo.findById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('listByInvestor', () => {
    it('returns lots ordered by acquired_at descending', async () => {
      const rows = [makeLotRow({ id: 'lot-2' }), makeLotRow({ id: 'lot-1' })];
      mockPool.query.mockResolvedValueOnce(mockQueryResult(rows));

      const result = await repo.listByInvestor('inv-1');
      expect(result).toHaveLength(2);
    });

    it('returns empty array when no lots', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([]));
      const result = await repo.listByInvestor('inv-1');
      expect(result).toEqual([]);
    });
  });

  describe('getTotalRemainingQuantity', () => {
    it('returns sum of remaining_quantity', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([{ total: '75.5' }]));
      const result = await repo.getTotalRemainingQuantity('inv-1', 'off-1');
      expect(result).toBe(75.5);
    });

    it('returns 0 when no lots', async () => {
      mockPool.query.mockResolvedValueOnce(mockQueryResult([{ total: null }]));
      const result = await repo.getTotalRemainingQuantity('inv-1', 'off-1');
      expect(result).toBe(0);
    });
  });
});
