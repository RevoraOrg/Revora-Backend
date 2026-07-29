/**
 * Tests for TaxationService: per-lot cost-basis tracking with pluggable strategies.
 *
 * Coverage targets:
 * - processDisposal: full end-to-end disposal, validation, transactional behavior
 * - createLot: lot creation and validation
 * - previewDisposal: dry-run without committing
 * - getJurisdictionGainsSummary: aggregation
 * - getAvailableQuantity: remaining quantity checks
 * - listLots / getAvailableLots: lot listing
 * - Error handling: invalid inputs, insufficient quantity, DB failures
 */

import { Pool, PoolClient } from 'pg';
import {
  TaxationService,
  createTaxationService,
} from './taxationService';
import { InvestmentLotRepository } from '../../db/repositories/investmentLotRepository';
import { DisposalRepository } from '../../db/repositories/disposalRepository';
import { InvestmentLot, DisposalResult, JurisdictionGainsSummary } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockPool(overrides: Partial<{ query: jest.Mock; connect: jest.Mock }> = {}): {
  query: jest.Mock;
  connect: jest.Mock;
} {
  return {
    query: overrides.query ?? jest.fn(),
    connect: overrides.connect ?? jest.fn(),
  };
}

function makeMockClient(): {
  query: jest.Mock;
  release: jest.Mock;
} {
  return {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
}

function makeLot(override: Partial<InvestmentLot> = {}): InvestmentLot {
  return {
    id: 'lot-1',
    investor_id: 'inv-1',
    offering_id: 'off-1',
    investment_id: 'invst-1',
    asset: 'USDC',
    quantity: 100,
    cost_basis_per_unit: 10,
    total_cost_basis: 1000,
    remaining_quantity: 100,
    cost_currency: 'USD',
    acquired_at: new Date('2024-01-01'),
    jurisdiction: 'US',
    status: 'open',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaxationService', () => {
  let mockPool: { query: jest.Mock; connect: jest.Mock };
  let mockClient: { query: jest.Mock; release: jest.Mock };
  let lotRepo: jest.Mocked<InvestmentLotRepository>;
  let disposalRepo: jest.Mocked<DisposalRepository>;
  let service: TaxationService;

  beforeEach(() => {
    mockPool = makeMockPool();
    mockClient = makeMockClient();
    mockPool.connect.mockResolvedValue(mockClient);

    lotRepo = {
      create: jest.fn(),
      createWithClient: jest.fn(),
      findAvailableLots: jest.fn(),
      findAvailableLotsForUpdate: jest.fn(),
      updateLotAfterDisposal: jest.fn(),
      findById: jest.fn(),
      listByInvestor: jest.fn(),
      getTotalRemainingQuantity: jest.fn(),
    } as unknown as jest.Mocked<InvestmentLotRepository>;

    disposalRepo = {
      createWithClient: jest.fn(),
      listByInvestor: jest.fn(),
      listByInvestorAndOffering: jest.fn(),
      getJurisdictionGainsSummary: jest.fn(),
      getJurisdictionGainsSummaryByOffering: jest.fn(),
      findById: jest.fn(),
    } as unknown as jest.Mocked<DisposalRepository>;

    service = new TaxationService(
      lotRepo as unknown as InvestmentLotRepository,
      disposalRepo as unknown as DisposalRepository,
      mockPool as unknown as Pool,
    );
  });

  // -----------------------------------------------------------------------
  // createLot
  // -----------------------------------------------------------------------

  describe('createLot', () => {
    it('creates a lot with valid inputs', async () => {
      const lot = makeLot();
      lotRepo.create.mockResolvedValue(lot);

      const result = await service.createLot({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        investment_id: 'invst-1',
        asset: 'USDC',
        quantity: 100,
        cost_basis_per_unit: 10,
        acquired_at: new Date('2024-01-01'),
      });

      expect(result).toEqual(lot);
      expect(lotRepo.create).toHaveBeenCalledTimes(1);
    });

    it('throws validation error for zero quantity', async () => {
      await expect(
        service.createLot({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          investment_id: 'invst-1',
          asset: 'USDC',
          quantity: 0,
          cost_basis_per_unit: 10,
          acquired_at: new Date(),
        })
      ).rejects.toThrow('Lot quantity must be greater than zero');
    });

    it('throws validation error for negative quantity', async () => {
      await expect(
        service.createLot({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          investment_id: 'invst-1',
          asset: 'USDC',
          quantity: -5,
          cost_basis_per_unit: 10,
          acquired_at: new Date(),
        })
      ).rejects.toThrow('Lot quantity must be greater than zero');
    });

    it('throws validation error for negative cost basis', async () => {
      await expect(
        service.createLot({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          investment_id: 'invst-1',
          asset: 'USDC',
          quantity: 10,
          cost_basis_per_unit: -1,
          acquired_at: new Date(),
        })
      ).rejects.toThrow('Cost basis per unit cannot be negative');
    });

    it('allows zero cost basis (gift/airdrop scenario)', async () => {
      const lot = makeLot({ cost_basis_per_unit: 0, total_cost_basis: 0 });
      lotRepo.create.mockResolvedValue(lot);

      const result = await service.createLot({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        investment_id: 'invst-1',
        asset: 'USDC',
        quantity: 100,
        cost_basis_per_unit: 0,
        acquired_at: new Date(),
      });

      expect(result.cost_basis_per_unit).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // processDisposal
  // -----------------------------------------------------------------------

  describe('processDisposal', () => {
    const disposalInput = {
      investor_id: 'inv-1',
      offering_id: 'off-1',
      quantity: 50,
      disposal_price_per_unit: 15,
      strategy: 'FIFO' as const,
    };

    beforeEach(() => {
      // Mock BEGIN/COMMIT
      mockClient.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT
    });

    it('processes a disposal with FIFO strategy successfully', async () => {
      const lots = [
        makeLot({ id: 'lot-1', remaining_quantity: 100, cost_basis_per_unit: 10 }),
      ];

      lotRepo.findAvailableLots.mockResolvedValue(lots);
      lotRepo.findAvailableLotsForUpdate.mockResolvedValue(lots);
      lotRepo.updateLotAfterDisposal.mockResolvedValue(undefined);
      disposalRepo.createWithClient.mockResolvedValue({
        id: 'disp-1',
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
        currency: 'USD',
        jurisdiction: 'US',
        disposed_at: new Date(),
        tax_report_finalized: false,
        tax_report_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const result = await service.processDisposal(disposalInput);

      expect(result.strategy).toBe('FIFO');
      expect(result.totalQuantityDisposed).toBe(50);
      expect(result.totalCostBasis).toBe(500);
      expect(result.realizedGainLoss).toBe(250); // 750 - 500
      expect(result.allocations).toHaveLength(1);
      expect(lotRepo.updateLotAfterDisposal).toHaveBeenCalledWith(
        mockClient,
        'lot-1',
        50,
      );
      expect(disposalRepo.createWithClient).toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('processes multi-lot disposal with LIFO strategy', async () => {
      const lots = [
        makeLot({ id: 'old', acquired_at: new Date('2024-01-01'), remaining_quantity: 40, cost_basis_per_unit: 10 }),
        makeLot({ id: 'new', acquired_at: new Date('2024-06-01'), remaining_quantity: 40, cost_basis_per_unit: 20 }),
      ];

      lotRepo.findAvailableLots.mockResolvedValue(lots);
      lotRepo.findAvailableLotsForUpdate.mockResolvedValue(lots);
      lotRepo.updateLotAfterDisposal.mockResolvedValue(undefined);
      disposalRepo.createWithClient.mockResolvedValue({
        id: 'disp-1',
        investor_id: 'inv-1',
        offering_id: 'off-1',
        lot_id: 'new',
        quantity_disposed: 40,
        cost_basis_per_unit: 20,
        total_cost_basis: 800,
        proceeds: 600,
        realized_gain_loss: -200,
        disposal_price_per_unit: 15,
        strategy: 'LIFO',
        currency: 'USD',
        jurisdiction: 'US',
        disposed_at: new Date(),
        tax_report_finalized: false,
        tax_report_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const result = await service.processDisposal({
        ...disposalInput,
        strategy: 'LIFO',
        quantity: 60,
      });

      // LIFO: newest first
      expect(result.allocations[0].lot.id).toBe('new');
      expect(result.allocations[0].quantityConsumed).toBe(40);
      expect(result.allocations[1].lot.id).toBe('old');
      expect(result.allocations[1].quantityConsumed).toBe(20);
    });

    it('processes disposal with HIFO strategy', async () => {
      const lots = [
        makeLot({ id: 'cheap', cost_basis_per_unit: 5, remaining_quantity: 100 }),
        makeLot({ id: 'expensive', cost_basis_per_unit: 15, remaining_quantity: 100 }),
      ];

      lotRepo.findAvailableLots.mockResolvedValue(lots);
      lotRepo.findAvailableLotsForUpdate.mockResolvedValue(lots);
      lotRepo.updateLotAfterDisposal.mockResolvedValue(undefined);
      disposalRepo.createWithClient.mockResolvedValue({
        id: 'disp-1',
        investor_id: 'inv-1',
        offering_id: 'off-1',
        lot_id: 'expensive',
        quantity_disposed: 50,
        cost_basis_per_unit: 15,
        total_cost_basis: 750,
        proceeds: 750,
        realized_gain_loss: 0,
        disposal_price_per_unit: 15,
        strategy: 'HIFO',
        currency: 'USD',
        jurisdiction: 'US',
        disposed_at: new Date(),
        tax_report_finalized: false,
        tax_report_id: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const result = await service.processDisposal({
        ...disposalInput,
        strategy: 'HIFO',
        quantity: 50,
        disposal_price_per_unit: 15,
      });

      // HIFO: highest cost first
      expect(result.allocations[0].lot.id).toBe('expensive');
      expect(result.allocations[0].costBasisPerUnit).toBe(15);
    });

    it('throws validation error for quantity <= 0', async () => {
      await expect(
        service.processDisposal({ ...disposalInput, quantity: 0 })
      ).rejects.toThrow('Disposal quantity must be greater than zero');

      await expect(
        service.processDisposal({ ...disposalInput, quantity: -10 })
      ).rejects.toThrow('Disposal quantity must be greater than zero');
    });

    it('throws validation error for negative disposal price', async () => {
      await expect(
        service.processDisposal({ ...disposalInput, disposal_price_per_unit: -5 })
      ).rejects.toThrow('Disposal price per unit cannot be negative');
    });

    it('throws when insufficient quantity across all lots', async () => {
      const lots = [makeLot({ remaining_quantity: 10 })];
      lotRepo.findAvailableLots.mockResolvedValue(lots);
      lotRepo.findAvailableLotsForUpdate.mockResolvedValue(lots);

      await expect(
        service.processDisposal({ ...disposalInput, quantity: 100 })
      ).rejects.toThrow('Insufficient quantity');
    });

    it('rolls back transaction on error during lot update', async () => {
      const lots = [makeLot({ remaining_quantity: 100 })];
      lotRepo.findAvailableLots.mockResolvedValue(lots);
      lotRepo.findAvailableLotsForUpdate.mockResolvedValue(lots);
      lotRepo.updateLotAfterDisposal.mockRejectedValue(new Error('DB error'));

      // Override query mock for ROLLBACK
      mockClient.query
        .mockReset()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

      await expect(
        service.processDisposal(disposalInput)
      ).rejects.toThrow('DB error');

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('rolls back and releases client even if rollback fails', async () => {
      const lots = [makeLot({ remaining_quantity: 100 })];
      lotRepo.findAvailableLots.mockResolvedValue(lots);
      lotRepo.findAvailableLotsForUpdate.mockResolvedValue(lots);
      lotRepo.updateLotAfterDisposal.mockRejectedValue(new Error('DB error'));

      // ROLLBACK also fails
      mockClient.query
        .mockReset()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
        .mockRejectedValueOnce(new Error('ROLLBACK failed')); // ROLLBACK fails

      await expect(
        service.processDisposal(disposalInput)
      ).rejects.toThrow('DB error');

      expect(mockClient.release).toHaveBeenCalled();
    });

    it('calculates realized gain correctly (gain scenario)', async () => {
      const lots = [makeLot({ remaining_quantity: 100, cost_basis_per_unit: 10 })];
      lotRepo.findAvailableLots.mockResolvedValue(lots);
      lotRepo.findAvailableLotsForUpdate.mockResolvedValue(lots);
      lotRepo.updateLotAfterDisposal.mockResolvedValue(undefined);
      disposalRepo.createWithClient.mockResolvedValue({} as any);

      const result = await service.processDisposal({
        ...disposalInput,
        quantity: 50,
        disposal_price_per_unit: 20, // Sale price > cost basis
      });

      expect(result.realizedGainLoss).toBeGreaterThan(0);
      expect(result.realizedGainLoss).toBe(500); // 1000 - 500
    });

    it('calculates realized loss correctly (loss scenario)', async () => {
      const lots = [makeLot({ remaining_quantity: 100, cost_basis_per_unit: 10 })];
      lotRepo.findAvailableLots.mockResolvedValue(lots);
      lotRepo.findAvailableLotsForUpdate.mockResolvedValue(lots);
      lotRepo.updateLotAfterDisposal.mockResolvedValue(undefined);
      disposalRepo.createWithClient.mockResolvedValue({} as any);

      const result = await service.processDisposal({
        ...disposalInput,
        quantity: 50,
        disposal_price_per_unit: 5, // Sale price < cost basis
      });

      expect(result.realizedGainLoss).toBeLessThan(0);
      expect(result.realizedGainLoss).toBe(-250); // 250 - 500
    });
  });

  // -----------------------------------------------------------------------
  // previewDisposal
  // -----------------------------------------------------------------------

  describe('previewDisposal', () => {
    it('returns preview without committing anything', async () => {
      const lots = [
        makeLot({ id: 'lot-1', remaining_quantity: 50, cost_basis_per_unit: 10 }),
        makeLot({ id: 'lot-2', remaining_quantity: 50, cost_basis_per_unit: 20 }),
      ];

      lotRepo.findAvailableLots.mockResolvedValue(lots);

      const result = await service.previewDisposal({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        quantity: 75,
        disposal_price_per_unit: 25,
        strategy: 'FIFO',
      });

      expect(result.allocations).toHaveLength(2);
      expect(result.strategy).toBe('FIFO');
      // Verify no DB writes occurred
      expect(lotRepo.updateLotAfterDisposal).not.toHaveBeenCalled();
      expect(disposalRepo.createWithClient).not.toHaveBeenCalled();
    });

    it('throws validation for invalid preview inputs', async () => {
      await expect(
        service.previewDisposal({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          quantity: 0,
          disposal_price_per_unit: 10,
          strategy: 'FIFO',
        })
      ).rejects.toThrow('Disposal quantity must be greater than zero');
    });

    it('preview with insufficient lots still throws', async () => {
      const lots = [makeLot({ remaining_quantity: 5 })];
      lotRepo.findAvailableLots.mockResolvedValue(lots);

      await expect(
        service.previewDisposal({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          quantity: 100,
          disposal_price_per_unit: 10,
          strategy: 'FIFO',
        })
      ).rejects.toThrow('Insufficient quantity');
    });
  });

  // -----------------------------------------------------------------------
  // getJurisdictionGainsSummary
  // -----------------------------------------------------------------------

  describe('getJurisdictionGainsSummary', () => {
    it('returns jurisdiction-level summary', async () => {
      const summary: JurisdictionGainsSummary[] = [
        {
          jurisdiction: 'US',
          totalProceeds: 5000,
          totalCostBasis: 3000,
          totalRealizedGainLoss: 2000,
          disposalCount: 5,
          strategyBreakdown: {
            FIFO: { count: 3, totalGainLoss: 1000 },
            LIFO: { count: 2, totalGainLoss: 1000 },
            HIFO: { count: 0, totalGainLoss: 0 },
          },
        },
      ];

      disposalRepo.getJurisdictionGainsSummary.mockResolvedValue(summary);

      const result = await service.getJurisdictionGainsSummary('inv-1');
      expect(result).toEqual(summary);
      expect(disposalRepo.getJurisdictionGainsSummary).toHaveBeenCalledWith('inv-1');
    });

    it('returns empty array when no disposals exist', async () => {
      disposalRepo.getJurisdictionGainsSummary.mockResolvedValue([]);
      const result = await service.getJurisdictionGainsSummary('inv-1');
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getAvailableQuantity
  // -----------------------------------------------------------------------

  describe('getAvailableQuantity', () => {
    it('returns total remaining quantity', async () => {
      lotRepo.getTotalRemainingQuantity.mockResolvedValue(75.5);
      const result = await service.getAvailableQuantity('inv-1', 'off-1');
      expect(result).toBe(75.5);
    });

    it('returns 0 when no lots exist', async () => {
      lotRepo.getTotalRemainingQuantity.mockResolvedValue(0);
      const result = await service.getAvailableQuantity('inv-1', 'off-1');
      expect(result).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // listLots
  // -----------------------------------------------------------------------

  describe('listLots', () => {
    it('lists all lots for an investor', async () => {
      const lots = [makeLot(), makeLot({ id: 'lot-2' })];
      lotRepo.listByInvestor.mockResolvedValue(lots);

      const result = await service.listLots('inv-1');
      expect(result).toHaveLength(2);
    });

    it('returns empty when no lots', async () => {
      lotRepo.listByInvestor.mockResolvedValue([]);
      const result = await service.listLots('inv-1');
      expect(result).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// createTaxationService factory
// ---------------------------------------------------------------------------

describe('createTaxationService', () => {
  it('creates a TaxationService instance', () => {
    const mockPool = { query: jest.fn(), connect: jest.fn() };
    const svc = createTaxationService(mockPool as unknown as Pool);
    expect(svc).toBeInstanceOf(TaxationService);
  });
});
