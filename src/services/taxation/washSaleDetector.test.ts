/**
 * Tests for WashSaleDetector: wash-sale detection with configurable window,
 * cost-basis adjustment, idempotency, and audit event emission.
 *
 * Coverage targets:
 * - detect: full detection flow, idempotency, no-match, validation
 * - detectForInvestor: batch detection
 * - Input validation: window bounds, gain vs loss, missing fields
 * - Audit event emission per adjustment
 * - Repository interaction patterns
 *
 * @module services/taxation/washSaleDetector.test
 */

import { Pool, PoolClient } from 'pg';
import { WashSaleDetector, createWashSaleDetector } from './washSaleDetector';
import { InvestmentLotRepository } from '../../db/repositories/investmentLotRepository';
import { WashSaleAdjustmentRepository } from '../../db/repositories/washSaleAdjustmentRepository';
import { AuditLogRepository } from '../../db/repositories/auditLogRepository';
import { InvestmentLot } from './types';

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

function makeMockClient(queryOverride?: jest.Mock): {
  query: jest.Mock;
  release: jest.Mock;
} {
  return {
    query: queryOverride ?? jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
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

function makeAdjustment(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'adj-1',
    investor_id: 'inv-1',
    offering_id: 'off-1',
    lot_id: 'lot-1',
    original_disposal_id: null,
    adjustment_amount: 500,
    original_cost_basis_per_unit: 10,
    adjusted_cost_basis_per_unit: 15,
    window_days: 30,
    disposed_at: new Date('2024-06-15'),
    created_at: new Date('2024-06-16'),
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WashSaleDetector', () => {
  let mockPool: { query: jest.Mock; connect: jest.Mock };
  let mockClient: { query: jest.Mock; release: jest.Mock };
  let lotRepo: jest.Mocked<InvestmentLotRepository>;
  let adjustmentRepo: jest.Mocked<WashSaleAdjustmentRepository>;
  let auditLogRepo: jest.Mocked<AuditLogRepository>;
  let detector: WashSaleDetector;

  beforeEach(() => {
    mockPool = makeMockPool();
    mockClient = makeMockClient();
    mockPool.connect.mockResolvedValue(mockClient);

    lotRepo = {
      findByInvestorOfferingAndDateRange: jest.fn(),
      listByInvestor: jest.fn(),
      findAvailableLots: jest.fn(),
      findAvailableLotsForUpdate: jest.fn(),
      findById: jest.fn(),
    } as unknown as jest.Mocked<InvestmentLotRepository>;

    adjustmentRepo = {
      createWithClient: jest.fn(),
      findByInvestorOfferingDate: jest.fn(),
      listByInvestor: jest.fn(),
      listByLot: jest.fn(),
    } as unknown as jest.Mocked<WashSaleAdjustmentRepository>;

    auditLogRepo = {
      createAuditLog: jest.fn().mockResolvedValue({} as any),
      getAuditLogsByUser: jest.fn(),
      getAuditLogsByAction: jest.fn(),
      purgeBefore: jest.fn(),
      getAuditLogsForExport: jest.fn(),
    } as unknown as jest.Mocked<AuditLogRepository>;

    detector = createWashSaleDetector(
      lotRepo as unknown as InvestmentLotRepository,
      adjustmentRepo as unknown as WashSaleAdjustmentRepository,
      auditLogRepo as unknown as AuditLogRepository,
      mockPool as unknown as Pool,
    );
  });

  // -----------------------------------------------------------------------
  // Constructor validation
  // -----------------------------------------------------------------------

  describe('constructor validation', () => {
    it('throws for window_days below minimum (1)', () => {
      expect(() =>
        createWashSaleDetector(
          lotRepo as unknown as InvestmentLotRepository,
          adjustmentRepo as unknown as WashSaleAdjustmentRepository,
          auditLogRepo as unknown as AuditLogRepository,
          mockPool as unknown as Pool,
          0,
        ),
      ).toThrow('between 1 and 365');
    });

    it('throws for window_days above maximum (365)', () => {
      expect(() =>
        createWashSaleDetector(
          lotRepo as unknown as InvestmentLotRepository,
          adjustmentRepo as unknown as WashSaleAdjustmentRepository,
          auditLogRepo as unknown as AuditLogRepository,
          mockPool as unknown as Pool,
          366,
        ),
      ).toThrow('between 1 and 365');
    });

    it('creates detector with default window (30 days)', () => {
      const d = createWashSaleDetector(
        lotRepo as unknown as InvestmentLotRepository,
        adjustmentRepo as unknown as WashSaleAdjustmentRepository,
        auditLogRepo as unknown as AuditLogRepository,
        mockPool as unknown as Pool,
      );
      expect(d).toBeInstanceOf(WashSaleDetector);
    });

    it('creates detector with custom valid window', () => {
      const d = createWashSaleDetector(
        lotRepo as unknown as InvestmentLotRepository,
        adjustmentRepo as unknown as WashSaleAdjustmentRepository,
        auditLogRepo as unknown as AuditLogRepository,
        mockPool as unknown as Pool,
        60,
      );
      expect(d).toBeInstanceOf(WashSaleDetector);
    });
  });

  // -----------------------------------------------------------------------
  // detect — no wash sale (gain on disposal)
  // -----------------------------------------------------------------------

  describe('detect — no wash sale', () => {
    it('returns isWashSale=false when disposal was a gain', async () => {
      const result = await detector.detect({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        disposed_at: new Date('2024-06-15'),
        disposal_realized_gain_loss: 500,
        disposal_quantity: 50,
        disposal_cost_basis_per_unit: 10,
      });

      expect(result.isWashSale).toBe(false);
      expect(result.adjustmentAmount).toBe(0);
      expect(result.adjustments).toHaveLength(0);
      expect(result.previousCostBasisPerUnit).toBe(10);
      expect(result.newCostBasisPerUnit).toBe(10);
      expect(lotRepo.findByInvestorOfferingAndDateRange).not.toHaveBeenCalled();
    });

    it('returns isWashSale=false when no repurchase lots found in window', async () => {
      lotRepo.findByInvestorOfferingAndDateRange.mockResolvedValue([]);

      const result = await detector.detect({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        disposed_at: new Date('2024-06-15'),
        disposal_realized_gain_loss: -200,
        disposal_quantity: 50,
        disposal_cost_basis_per_unit: 10,
      });

      expect(result.isWashSale).toBe(false);
      expect(result.adjustmentAmount).toBe(0);
      expect(result.adjustments).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // detect — wash sale detected
  // -----------------------------------------------------------------------

  describe('detect — wash sale detected', () => {
    it('detects wash sale and creates adjustment for repurchase lot within window', async () => {
      const repurchaseLot = makeLot({
        id: 'lot-repurchase',
        acquired_at: new Date('2024-06-20'),
        remaining_quantity: 100,
        cost_basis_per_unit: 12,
      });

      lotRepo.findByInvestorOfferingAndDateRange.mockResolvedValue([repurchaseLot]);

      const adjustment = makeAdjustment({
        id: 'adj-new',
        lot_id: 'lot-repurchase',
        adjustment_amount: 200,
      });
      adjustmentRepo.createWithClient.mockResolvedValue(adjustment as any);

      const result = await detector.detect({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        disposed_at: new Date('2024-06-15'),
        disposal_realized_gain_loss: -500,
        disposal_quantity: 50,
        disposal_cost_basis_per_unit: 10,
      });

      expect(result.isWashSale).toBe(true);
      expect(result.adjustmentAmount).toBeGreaterThan(0);
      expect(result.adjustments).toHaveLength(1);
      expect(result.matchedRepurchaseLots).toHaveLength(1);
      expect(result.matchedRepurchaseLots[0].id).toBe('lot-repurchase');
      expect(auditLogRepo.createAuditLog).toHaveBeenCalledTimes(1);
    });

    it('proportionally allocates disallowed loss across multiple repurchase lots', async () => {
      const lotA = makeLot({
        id: 'lot-a',
        acquired_at: new Date('2024-06-10'),
        remaining_quantity: 60,
        cost_basis_per_unit: 10,
      });
      const lotB = makeLot({
        id: 'lot-b',
        acquired_at: new Date('2024-06-25'),
        remaining_quantity: 40,
        cost_basis_per_unit: 11,
      });

      lotRepo.findByInvestorOfferingAndDateRange.mockResolvedValue([lotA, lotB]);

      adjustmentRepo.createWithClient
        .mockResolvedValueOnce(makeAdjustment({ id: 'adj-a', lot_id: 'lot-a', adjustment_amount: 300 }) as any)
        .mockResolvedValueOnce(makeAdjustment({ id: 'adj-b', lot_id: 'lot-b', adjustment_amount: 200 }) as any);

      const result = await detector.detect({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        disposed_at: new Date('2024-06-15'),
        disposal_realized_gain_loss: -500,
        disposal_quantity: 50,
        disposal_cost_basis_per_unit: 10,
      });

      expect(result.isWashSale).toBe(true);
      expect(result.adjustments).toHaveLength(2);
      expect(result.adjustmentAmount).toBe(500);
      expect(auditLogRepo.createAuditLog).toHaveBeenCalledTimes(2);
    });

    it('allocates disallowed loss proportionally even when repurchase lots are profitable', async () => {
      const profitLot = makeLot({
        id: 'lot-profit',
        acquired_at: new Date('2024-06-20'),
        remaining_quantity: 100,
        cost_basis_per_unit: 15,
      });

      lotRepo.findByInvestorOfferingAndDateRange.mockResolvedValue([profitLot]);

      adjustmentRepo.createWithClient.mockResolvedValue(
        makeAdjustment({ id: 'adj-profit', lot_id: 'lot-profit', adjustment_amount: 500 }) as any,
      );

      const result = await detector.detect({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        disposed_at: new Date('2024-06-15'),
        disposal_realized_gain_loss: -500,
        disposal_quantity: 50,
        disposal_cost_basis_per_unit: 10,
      });

      expect(result.isWashSale).toBe(true);
      expect(result.adjustments).toHaveLength(1);
      expect(result.adjustments[0].adjustment_amount).toBe(500);
    });
  });

  // -----------------------------------------------------------------------
  // detect — idempotency
  // -----------------------------------------------------------------------

  describe('detect — idempotency', () => {
    it('returns existing adjustment without creating duplicate on repeated call', async () => {
      const existing = makeAdjustment() as Record<string, unknown>;
      adjustmentRepo.findByInvestorOfferingDate.mockResolvedValue(existing as any);

      const result = await detector.detect({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        disposed_at: new Date('2024-06-15'),
        disposal_realized_gain_loss: -300,
        disposal_quantity: 50,
        disposal_cost_basis_per_unit: 10,
      });

      expect(result.isWashSale).toBe(true);
      expect(result.adjustmentAmount).toBe(500);
      expect(adjustmentRepo.createWithClient).not.toHaveBeenCalled();
      expect(lotRepo.findByInvestorOfferingAndDateRange).not.toHaveBeenCalled();
    });

    it('returns existing adjustment on same (investor, offering, disposed_at)', async () => {
      const existing = makeAdjustment({
        adjustment_amount: 750,
        disposed_at: new Date('2024-06-15'),
      }) as Record<string, unknown>;
      adjustmentRepo.findByInvestorOfferingDate.mockResolvedValue(existing as any);

      const result = await detector.detect({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        disposed_at: new Date('2024-06-15'),
        disposal_realized_gain_loss: -300,
        disposal_quantity: 50,
        disposal_cost_basis_per_unit: 10,
      });

      expect(result.adjustmentAmount).toBe(750);
    });
  });

  // -----------------------------------------------------------------------
  // detect — validation
  // -----------------------------------------------------------------------

  describe('detect — validation', () => {
    it('throws for window_days below 1', async () => {
      await expect(
        detector.detect({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          disposed_at: new Date('2024-06-15'),
          disposal_realized_gain_loss: -100,
          disposal_quantity: 50,
          disposal_cost_basis_per_unit: 10,
          window_days: 0,
        }),
      ).rejects.toThrow('between 1 and 365');
    });

    it('throws for window_days above 365', async () => {
      await expect(
        detector.detect({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          disposed_at: new Date('2024-06-15'),
          disposal_realized_gain_loss: -100,
          disposal_quantity: 50,
          disposal_cost_basis_per_unit: 10,
          window_days: 366,
        }),
      ).rejects.toThrow('between 1 and 365');
    });

    it('handles repository error gracefully', async () => {
      lotRepo.findByInvestorOfferingAndDateRange.mockRejectedValue(new Error('DB error'));

      await expect(
        detector.detect({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          disposed_at: new Date('2024-06-15'),
          disposal_realized_gain_loss: -100,
          disposal_quantity: 50,
          disposal_cost_basis_per_unit: 10,
        }),
      ).rejects.toThrow('DB error');
    });
  });

  // -----------------------------------------------------------------------
  // detectForInvestor
  // -----------------------------------------------------------------------

  describe('detectForInvestor', () => {
    it('detects wash sales across all offerings for an investor', async () => {
      const lots = [
        makeLot({ id: 'lot-1', offering_id: 'off-1' }),
        makeLot({ id: 'lot-2', offering_id: 'off-2' }),
      ];
      lotRepo.listByInvestor.mockResolvedValue(lots);

      adjustmentRepo.findByInvestorOfferingDate.mockResolvedValue(null);
      lotRepo.findByInvestorOfferingAndDateRange.mockResolvedValue([lots[0]]);
      adjustmentRepo.createWithClient.mockResolvedValue(makeAdjustment() as any);

      const results = await detector.detectForInvestor(
        'inv-1',
        new Date('2024-06-15'),
        -300,
        50,
        10,
      );

      expect(results).toHaveLength(2);
      expect(results[0].isWashSale).toBe(true);
      expect(results[1].isWashSale).toBe(true);
      expect(lotRepo.findByInvestorOfferingAndDateRange).toHaveBeenCalledTimes(2);
    });

    it('returns result per offering even when no wash-sale for some', async () => {
      const lots = [
        makeLot({ id: 'lot-1', offering_id: 'off-1' }),
        makeLot({ id: 'lot-2', offering_id: 'off-2' }),
      ];
      lotRepo.listByInvestor.mockResolvedValue(lots);

      adjustmentRepo.findByInvestorOfferingDate.mockResolvedValue(null);
      lotRepo.findByInvestorOfferingAndDateRange.mockResolvedValue([]);

      const results = await detector.detectForInvestor(
        'inv-1',
        new Date('2024-06-15'),
        200,
        50,
        10,
      );

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.isWashSale === false)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // detect — error paths
  // -----------------------------------------------------------------------

  describe('detect — error paths', () => {
    it('handles findByInvestorOfferingDate repository error', async () => {
      adjustmentRepo.findByInvestorOfferingDate.mockRejectedValue(new Error('DB lookup failed'));

      await expect(
        detector.detect({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          disposed_at: new Date('2024-06-15'),
          disposal_realized_gain_loss: -100,
          disposal_quantity: 50,
          disposal_cost_basis_per_unit: 10,
        }),
      ).rejects.toThrow('DB lookup failed');
    });

    it('handles findByInvestorOfferingAndDateRange repository error', async () => {
      adjustmentRepo.findByInvestorOfferingDate.mockResolvedValue(null);
      lotRepo.findByInvestorOfferingAndDateRange.mockRejectedValue(new Error('DB lot lookup failed'));

      await expect(
        detector.detect({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          disposed_at: new Date('2024-06-15'),
          disposal_realized_gain_loss: -100,
          disposal_quantity: 50,
          disposal_cost_basis_per_unit: 10,
        }),
      ).rejects.toThrow('DB lot lookup failed');
    });

    it('handles createWithClient error during adjustment creation', async () => {
      adjustmentRepo.findByInvestorOfferingDate.mockResolvedValue(null);

      const losingLot = makeLot({
        id: 'lot-loss',
        acquired_at: new Date('2024-06-20'),
        remaining_quantity: 100,
        cost_basis_per_unit: 12,
      });

      lotRepo.findByInvestorOfferingAndDateRange.mockResolvedValue([losingLot]);
      adjustmentRepo.createWithClient.mockRejectedValue(new Error('Insert failed'));

      await expect(
        detector.detect({
          investor_id: 'inv-1',
          offering_id: 'off-1',
          disposed_at: new Date('2024-06-15'),
          disposal_realized_gain_loss: -500,
          disposal_quantity: 50,
          disposal_cost_basis_per_unit: 10,
        }),
      ).rejects.toThrow('Insert failed');
    });
  });

  // -----------------------------------------------------------------------
  // detect — edge cases
  // -----------------------------------------------------------------------

  describe('detect — edge cases', () => {
    it('handles disposal at exactly zero loss (no wash sale)', async () => {
      lotRepo.findByInvestorOfferingAndDateRange.mockResolvedValue([]);

      const result = await detector.detect({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        disposed_at: new Date('2024-06-15'),
        disposal_realized_gain_loss: 0,
        disposal_quantity: 50,
        disposal_cost_basis_per_unit: 10,
      });

      expect(result.isWashSale).toBe(false);
      expect(result.adjustmentAmount).toBe(0);
    });

    it('proportional basis calculation with multiple lots of different quantities', async () => {
      const lotA = makeLot({
        id: 'lot-a',
        acquired_at: new Date('2024-06-10'),
        remaining_quantity: 80,
        cost_basis_per_unit: 10,
      });
      const lotB = makeLot({
        id: 'lot-b',
        acquired_at: new Date('2024-06-25'),
        remaining_quantity: 20,
        cost_basis_per_unit: 11,
      });

      lotRepo.findByInvestorOfferingAndDateRange.mockResolvedValue([lotA, lotB]);

      adjustmentRepo.createWithClient
        .mockResolvedValueOnce(makeAdjustment({ id: 'adj-a', lot_id: 'lot-a', adjustment_amount: 400 }) as any)
        .mockResolvedValueOnce(makeAdjustment({ id: 'adj-b', lot_id: 'lot-b', adjustment_amount: 100 }) as any);

      const result = await detector.detect({
        investor_id: 'inv-1',
        offering_id: 'off-1',
        disposed_at: new Date('2024-06-15'),
        disposal_realized_gain_loss: -500,
        disposal_quantity: 50,
        disposal_cost_basis_per_unit: 10,
      });

      expect(result.isWashSale).toBe(true);
      expect(result.adjustments).toHaveLength(2);
      expect(result.adjustmentAmount).toBe(500);
      expect(result.adjustments[0].adjustment_amount).toBe(400);
      expect(result.adjustments[1].adjustment_amount).toBe(100);
    });
  });
});

// ---------------------------------------------------------------------------
// createWashSaleDetector factory
// ---------------------------------------------------------------------------

describe('createWashSaleDetector', () => {
  it('creates a WashSaleDetector instance', () => {
    const mockPool = { query: jest.fn(), connect: jest.fn() };
    const lotRepo = {} as unknown as InvestmentLotRepository;
    const adjRepo = {} as unknown as WashSaleAdjustmentRepository;
    const auditRepo = {} as unknown as AuditLogRepository;

    const detector = createWashSaleDetector(
      lotRepo,
      adjRepo,
      auditRepo,
      mockPool as unknown as Pool,
    );

    expect(detector).toBeInstanceOf(WashSaleDetector);
  });
});

// ---------------------------------------------------------------------------
// Repository tests
// ---------------------------------------------------------------------------

describe('WashSaleAdjustmentRepository', () => {
  let mockPool: { query: jest.Mock };
  let repo: WashSaleAdjustmentRepository;

  beforeEach(() => {
    mockPool = { query: jest.fn() };
    repo = new WashSaleAdjustmentRepository(mockPool as unknown as Pool);
  });

  it('creates an adjustment via createWithClient', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'adj-1',
            investor_id: 'inv-1',
            offering_id: 'off-1',
            lot_id: 'lot-1',
            original_disposal_id: null,
            adjustment_amount: '500',
            original_cost_basis_per_unit: '10',
            adjusted_cost_basis_per_unit: '15',
            window_days: '30',
            disposed_at: '2024-06-15T00:00:00.000Z',
            created_at: new Date(),
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

    expect(result.adjustment_amount).toBe(500);
    expect(result.original_cost_basis_per_unit).toBe(10);
    expect(result.adjusted_cost_basis_per_unit).toBe(15);
  });

  it('returns null when no existing adjustment for investor+offering+date', async () => {
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

  it('finds existing adjustment for investor+offering+date', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            id: 'adj-1',
            investor_id: 'inv-1',
            offering_id: 'off-1',
            lot_id: 'lot-1',
            original_disposal_id: null,
            adjustment_amount: '500',
            original_cost_basis_per_unit: '10',
            adjusted_cost_basis_per_unit: '15',
            window_days: '30',
            disposed_at: new Date('2024-06-15'),
            created_at: new Date(),
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
    expect(result!.adjustment_amount).toBe(500);
  });
});