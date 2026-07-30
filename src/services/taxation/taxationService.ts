/**
 * Taxation Service: Per-Lot Cost-Basis Tracking with Pluggable Disposal Strategies
 *
 * Provides tax-reporting functionality for investment disposals using per-lot cost-basis
 * tracking with pluggable FIFO, LIFO, and HIFO strategies. Handles fractional-share splits,
 * maintains immutable historical evaluations, and emits per-jurisdiction gains totals.
 *
 * Security Assumptions:
 * - Caller identity (investor_id) is asserted by trusted upstream auth middleware.
 * - Database transactions provide ACID guarantees for concurrent disposal safety.
 * - Lot selection is deterministic for a given set of lots and strategy.
 * - Strategy changes are forward-only (new strategy applies to future disposals only).
 * - Dual-control is required for strategy changes (enforced at handler/admin layer).
 *
 * Decimal Precision:
 * - Quantities: NUMERIC(36,18) — supports fractional shares with 18 decimal places.
 * - Monetary amounts: NUMERIC(30,10) — preserves precision for cost basis and proceeds.
 *
 * @module services/taxation/taxationService
 */

import { Pool } from 'pg';
import { InvestmentLotRepository } from '../../db/repositories/investmentLotRepository';
import { DisposalRepository } from '../../db/repositories/disposalRepository';
import { WashSaleDetector, WashSaleDetectionResult } from './washSaleDetector';
import { resolveStrategy } from './costBasisStrategies';
import {
  CostBasisStrategy,
  DisposalResult,
  InvestmentLot,
  LotAllocation,
  ProcessDisposalInput,
  DisposalStrategy,
  JurisdictionGainsSummary,
} from './types';
import { Errors } from '../../lib/errors';

const DEFAULT_CURRENCY = 'USD';
const DEFAULT_JURISDICTION = 'US';

export class TaxationService {
  constructor(
    private lotRepo: InvestmentLotRepository,
    private disposalRepo: DisposalRepository,
    private db: Pool,
    private washSaleDetector?: WashSaleDetector,
  ) {}

  /**
   * Process a disposal of investment units using the specified cost-basis strategy.
   *
   * This operation is atomic — it uses a database transaction to:
   * 1. Lock available lots FOR UPDATE (preventing concurrent disposals from double-spending).
   * 2. Run the strategy to allocate lots.
   * 3. Update lot remaining quantities and statuses.
   * 4. Create immutable disposal records.
   *
   * @param input - Disposal parameters including investor, offering, quantity, and strategy
   * @returns DisposalResult with all allocations, weighted average cost basis, and realized gain/loss
   * @throws AppError if insufficient quantity, invalid strategy, or database errors
   */
  async processDisposal(input: ProcessDisposalInput): Promise<DisposalResult> {
    // 1. Validate inputs
    if (input.quantity <= 0) {
      throw Errors.validationError('Disposal quantity must be greater than zero');
    }
    if (input.disposal_price_per_unit < 0) {
      throw Errors.validationError('Disposal price per unit cannot be negative');
    }

    let strategy: CostBasisStrategy;
    try {
      strategy = resolveStrategy(input.strategy);
    } catch (err) {
      throw Errors.validationError(
        err instanceof Error ? err.message : 'Invalid disposal strategy'
      );
    }

    const currency = input.currency || DEFAULT_CURRENCY;
    const disposedAt = input.disposed_at || new Date();

    // 2. Execute disposal within a transaction
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // Lock lots for update to prevent concurrent disposals (single read, avoids TOCTOU)
      const lockedLots = await this.lotRepo.findAvailableLotsForUpdate(
        client,
        input.investor_id,
        input.offering_id,
      );

      // Derive jurisdiction from locked lots (defaults to US if no lots exist)
      const jurisdiction = lockedLots.length > 0
        ? lockedLots[0].jurisdiction
        : DEFAULT_JURISDICTION;

      // Run strategy to get allocations
      let allocations: LotAllocation[];
      try {
        allocations = strategy.selectLots(lockedLots, input.quantity);
      } catch (err) {
        throw Errors.validationError(
          err instanceof Error ? err.message : 'Insufficient quantity for disposal'
        );
      }

      // Calculate totals
      let totalCostBasis = 0;
      const proceeds = input.quantity * input.disposal_price_per_unit;

      // Update each lot and create disposal records
      for (const allocation of allocations) {
        const newRemainingQuantity =
          allocation.lot.remaining_quantity - allocation.quantityConsumed;

        // Update lot
        await this.lotRepo.updateLotAfterDisposal(
          client,
          allocation.lot.id,
          newRemainingQuantity,
        );

        totalCostBasis += allocation.totalCostBasis;

        // Create disposal record
        await this.disposalRepo.createWithClient(client, {
          investor_id: input.investor_id,
          offering_id: input.offering_id,
          lot_id: allocation.lot.id,
          quantity_disposed: allocation.quantityConsumed,
          cost_basis_per_unit: allocation.costBasisPerUnit,
          total_cost_basis: allocation.totalCostBasis,
          proceeds: allocation.quantityConsumed * input.disposal_price_per_unit,
          realized_gain_loss:
            allocation.quantityConsumed * input.disposal_price_per_unit -
            allocation.totalCostBasis,
          disposal_price_per_unit: input.disposal_price_per_unit,
          strategy: strategy.name,
          currency,
          jurisdiction,
          disposed_at: disposedAt,
        });
      }

      await client.query('COMMIT');

      const realizedGainLoss = proceeds - totalCostBasis;
      const weightedAverageCostBasis =
        input.quantity > 0 ? totalCostBasis / input.quantity : 0;

      return {
        allocations,
        totalQuantityDisposed: input.quantity,
        weightedAverageCostBasis,
        totalCostBasis,
        realizedGainLoss,
        strategy: strategy.name,
      };
    } catch (error) {
      // Attempt rollback but don't let rollback failure mask the original error
      try { await client.query('ROLLBACK'); } catch { /* suppress rollback errors */ }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Create a new investment lot from an acquisition.
   * Called when an investment is completed and tokens are received.
   */
  async createLot(lot: {
    investor_id: string;
    offering_id: string;
    investment_id: string;
    asset: string;
    quantity: number;
    cost_basis_per_unit: number;
    acquired_at: Date;
    cost_currency?: string;
    jurisdiction?: string;
  }): Promise<InvestmentLot> {
    if (lot.quantity <= 0) {
      throw Errors.validationError('Lot quantity must be greater than zero');
    }
    if (lot.cost_basis_per_unit < 0) {
      throw Errors.validationError('Cost basis per unit cannot be negative');
    }

    return this.lotRepo.create({
      investor_id: lot.investor_id,
      offering_id: lot.offering_id,
      investment_id: lot.investment_id,
      asset: lot.asset,
      quantity: lot.quantity,
      cost_basis_per_unit: lot.cost_basis_per_unit,
      cost_currency: lot.cost_currency,
      acquired_at: lot.acquired_at,
      jurisdiction: lot.jurisdiction,
    });
  }

  /**
   * Get jurisdiction-level gains summary for an investor.
   */
  async getJurisdictionGainsSummary(investorId: string): Promise<JurisdictionGainsSummary[]> {
    return this.disposalRepo.getJurisdictionGainsSummary(investorId);
  }

  /**
   * Get jurisdiction-level gains summary for a specific offering.
   */
  async getJurisdictionGainsSummaryByOffering(
    offeringId: string,
  ): Promise<JurisdictionGainsSummary[]> {
    return this.disposalRepo.getJurisdictionGainsSummaryByOffering(offeringId);
  }

  /**
   * Get total remaining quantity across all available lots for an investor+offering.
   */
  async getAvailableQuantity(investorId: string, offeringId: string): Promise<number> {
    return this.lotRepo.getTotalRemainingQuantity(investorId, offeringId);
  }

  /**
   * List all lots for an investor.
   */
  async listLots(investorId: string): Promise<InvestmentLot[]> {
    return this.lotRepo.listByInvestor(investorId);
  }

  /**
   * Get available lots for an investor+offering (for strategy preview).
   */
  async getAvailableLots(investorId: string, offeringId: string): Promise<InvestmentLot[]> {
    return this.lotRepo.findAvailableLots(investorId, offeringId);
  }

  /**
   * Run wash-sale detection for a completed disposal.
   *
   * Checks whether the disposal at a loss triggered a wash-sale condition
   * (repurchase of substantially identical security within the configurable
   * window). If so, creates cost-basis adjustments and emits audit events.
   *
   * @param input - Wash-sale detection parameters
   * @returns WashSaleDetectionResult with any adjustments made
   */
  async detectWashSales(input: {
    investor_id: string;
    offering_id: string;
    disposed_at: Date;
    disposal_realized_gain_loss: number;
    disposal_quantity: number;
    disposal_cost_basis_per_unit: number;
    window_days?: number;
  }): Promise<WashSaleDetectionResult> {
    if (!this.washSaleDetector) {
      throw Errors.validationError('Wash-sale detector is not configured');
    }
    return this.washSaleDetector.detect(input);
  }

  /**
   * Batch-run wash-sale detection for all offerings of an investor on a date.
   */
  async detectWashSalesForInvestor(
    investorId: string,
    disposedAt: Date,
    disposalGainLoss: number,
    disposalQuantity: number,
    disposalCostBasisPerUnit: number,
    windowDays?: number,
  ): Promise<WashSaleDetectionResult[]> {
    if (!this.washSaleDetector) {
      throw Errors.validationError('Wash-sale detector is not configured');
    }
    return this.washSaleDetector.detectForInvestor(
      investorId,
      disposedAt,
      disposalGainLoss,
      disposalQuantity,
      disposalCostBasisPerUnit,
      windowDays,
    );
  }

  /**
   * Preview a disposal without executing it.
   * Returns the allocations that would be made but does not commit anything.
   */
  async previewDisposal(input: ProcessDisposalInput): Promise<DisposalResult> {
    if (input.quantity <= 0) {
      throw Errors.validationError('Disposal quantity must be greater than zero');
    }
    if (input.disposal_price_per_unit < 0) {
      throw Errors.validationError('Disposal price per unit cannot be negative');
    }

    let strategy: CostBasisStrategy;
    try {
      strategy = resolveStrategy(input.strategy);
    } catch (err) {
      throw Errors.validationError(
        err instanceof Error ? err.message : 'Invalid disposal strategy'
      );
    }

    const availableLots = await this.lotRepo.findAvailableLots(
      input.investor_id,
      input.offering_id,
    );

    let allocations: LotAllocation[];
    try {
      allocations = strategy.selectLots(availableLots, input.quantity);
    } catch (err) {
      throw Errors.validationError(
        err instanceof Error ? err.message : 'Insufficient quantity for disposal'
      );
    }

    let totalCostBasis = 0;
    for (const allocation of allocations) {
      totalCostBasis += allocation.totalCostBasis;
    }

    const proceeds = input.quantity * input.disposal_price_per_unit;
    const realizedGainLoss = proceeds - totalCostBasis;
    const weightedAverageCostBasis =
      input.quantity > 0 ? totalCostBasis / input.quantity : 0;

    return {
      allocations,
      totalQuantityDisposed: input.quantity,
      weightedAverageCostBasis,
      totalCostBasis,
      realizedGainLoss,
      strategy: strategy.name,
    };
  }
}

/**
 * Factory function to create TaxationService with dependencies.
 */
export function createTaxationService(
  db: Pool,
  washSaleDetector?: WashSaleDetector,
): TaxationService {
  return new TaxationService(
    new InvestmentLotRepository(db),
    new DisposalRepository(db),
    db,
    washSaleDetector,
  );
}
