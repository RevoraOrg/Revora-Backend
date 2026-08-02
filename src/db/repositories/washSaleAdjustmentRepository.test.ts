/**
 * Tests for WashSaleAdjustmentRepository.
 *
 * @module db/repositories/washSaleAdjustmentRepository.test
 */

import { Pool, PoolClient } from 'pg';
import { WashSaleAdjustmentRepository } from './washSaleAdjustmentRepository';

describe('WashSaleAdjustmentRepository', () => {
  let mockPool: { query: jest.Mock };
  let repo: WashSaleAdjustmentRepository;

  beforeEach(() => {
    mockPool = { query: jest.fn() } as unknown as Pool;
    repo = new WashSaleAdjustmentRepository(mockPool);
  });

  describe('createWithClient', () => {
    it('inserts and returns a wash-sale adjustment', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              id: 'adj-1',
              investor_id: 'inv-1',
              offering_id: 'off-1',
              lot_id: 'lot-1',
              original_disposal_id: null,
              adjustment_amount: '500.0000000000',
              original_cost_basis_per_unit: '10.0000000000',
              adjusted_cost_basis_per_unit: '15.0000000000',
              window_days: '30',
              disposed_at: '2024-06-15T00:00:00.000Z',
              created_at: new Date('2024-06-16'),
            },
          ],
          rowCount: 1,
        }),
      };

      const input = {
        investor_id: 'inv-1',
        offering_id: 'off-1',
        lot_id: 'lot-1',
        adjustment_amount: 500,
        original_cost_basis_per_unit: 10,
        adjusted_cost_basis_per_unit: 15,
        window_days: 30,
        disposed_at: new Date('2024-06-15'),
      };

      const result = await repo.createWithClient(mockClient as unknown as PoolClient, input);

      expect(result.id).toBe('adj-1');
      expect(result.adjustment_amount).toBe(500);
      expect(result.original_cost_basis_per_unit).toBe(10);
      expect(result.adjusted_cost_basis_per_unit).toBe(15);
      expect(result.window_days).toBe(30);
    });

    it('throws when insert returns no rows', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      };

      const input = {
        investor_id: 'inv-1',
        offering_id: 'off-1',
        lot_id: 'lot-1',
        adjustment_amount: 500,
        original_cost_basis_per_unit: 10,
        adjusted_cost_basis_per_unit: 15,
        window_days: 30,
        disposed_at: new Date('2024-06-15'),
      };

      await expect(
        repo.createWithClient(mockClient as unknown as PoolClient, input),
      ).rejects.toThrow('Failed to create wash-sale adjustment');
    });
  });

  describe('findByInvestorOfferingDate', () => {
    it('returns null when no matching adjustment exists', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      };

      const result = await repo.findByInvestorOfferingDate(
        mockClient as unknown as PoolClient,
        'inv-1',
        'off-1',
        new Date('2024-06-15'),
      );

      expect(result).toBeNull();
    });

    it('returns the most recent adjustment for the key', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              id: 'adj-1',
              investor_id: 'inv-1',
              offering_id: 'off-1',
              lot_id: 'lot-1',
              original_disposal_id: null,
              adjustment_amount: '750.0000000000',
              original_cost_basis_per_unit: '10.0000000000',
              adjusted_cost_basis_per_unit: '17.5000000000',
              window_days: '30',
              disposed_at: '2024-06-15T00:00:00.000Z',
              created_at: new Date('2024-06-16'),
            },
          ],
          rowCount: 1,
        }),
      };

      const result = await repo.findByInvestorOfferingDate(
        mockClient as unknown as PoolClient,
        'inv-1',
        'off-1',
        new Date('2024-06-15'),
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe('adj-1');
      expect(result!.adjustment_amount).toBe(750);
    });
  });

  describe('listByInvestor', () => {
    it('returns all adjustments for an investor', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'adj-1',
            investor_id: 'inv-1',
            offering_id: 'off-1',
            lot_id: 'lot-1',
            original_disposal_id: null,
            adjustment_amount: '500.0000000000',
            original_cost_basis_per_unit: '10.0000000000',
            adjusted_cost_basis_per_unit: '15.0000000000',
            window_days: '30',
            disposed_at: '2024-06-15T00:00:00.000Z',
            created_at: new Date('2024-06-16'),
          },
          {
            id: 'adj-2',
            investor_id: 'inv-1',
            offering_id: 'off-2',
            lot_id: 'lot-2',
            original_disposal_id: null,
            adjustment_amount: '250.0000000000',
            original_cost_basis_per_unit: '20.0000000000',
            adjusted_cost_basis_per_unit: '22.5000000000',
            window_days: '30',
            disposed_at: '2024-06-10T00:00:00.000Z',
            created_at: new Date('2024-06-11'),
          },
        ],
        rowCount: 2,
      });

      const result = await repo.listByInvestor('inv-1');
      expect(result).toHaveLength(2);
      expect(result[0].adjustment_amount).toBe(500);
      expect(result[1].adjustment_amount).toBe(250);
    });

    it('returns empty array when no adjustments exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await repo.listByInvestor('inv-999');
      expect(result).toEqual([]);
    });
  });

  describe('listByLot', () => {
    it('returns adjustments for a specific lot', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'adj-1',
            investor_id: 'inv-1',
            offering_id: 'off-1',
            lot_id: 'lot-1',
            original_disposal_id: null,
            adjustment_amount: '500.0000000000',
            original_cost_basis_per_unit: '10.0000000000',
            adjusted_cost_basis_per_unit: '15.0000000000',
            window_days: '30',
            disposed_at: '2024-06-15T00:00:00.000Z',
            created_at: new Date('2024-06-16'),
          },
        ],
        rowCount: 1,
      });

      const result = await repo.listByLot('lot-1');
      expect(result).toHaveLength(1);
      expect(result[0].lot_id).toBe('lot-1');
    });
  });
});