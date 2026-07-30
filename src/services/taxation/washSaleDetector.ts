/**
 * Wash-Sale Detector
 *
 * Detects wash-sale conditions for US tax reporting and recomputes cost basis
 * for disallowed losses. A wash sale occurs when a substantially identical security
 * is purchased within a configurable window (default 30 days) before or after a
 * disposal at a loss.
 *
 * Adjustments are idempotent per (investor, offering, date). Re-running the detector
 * for the same investor+offering+disposal_date will not create duplicate adjustments.
 *
 * Each adjustment emits an audit event via the audit_logs table with a tamper-evident
 * chain hash (prev_hash -> row_hash).
 *
 * Security Assumptions:
 * - Caller identity is asserted by trusted upstream auth middleware (investor_id).
 * - Idempotency is enforced at the repository layer via findByInvestorOfferingDate.
 * - Audit chain integrity is maintained by prev_hash -> row_hash linking in audit_logs.
 * - The wash-sale window is configurable but bounded (1-365 days).
 * - Cost basis adjustments are additive: the disallowed loss is added to the cost
 *   basis of the repurchased lot within the window.
 *
 * @module services/taxation/washSaleDetector
 */

import { Pool, PoolClient } from 'pg';
import { InvestmentLotRepository } from '../../db/repositories/investmentLotRepository';
import { WashSaleAdjustmentRepository } from '../../db/repositories/washSaleAdjustmentRepository';
import { AuditLogRepository } from '../../db/repositories/auditLogRepository';
import { InvestmentLot } from './types';
import { Errors } from '../../lib/errors';

const DEFAULT_WASH_SALE_WINDOW_DAYS = 30;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;

export interface WashSaleDetectorInput {
  investor_id: string;
  offering_id: string;
  disposed_at: Date;
  disposal_realized_gain_loss: number;
  disposal_quantity: number;
  disposal_cost_basis_per_unit: number;
  window_days?: number;
}

export interface WashSaleAdjustment {
  id: string;
  investor_id: string;
  offering_id: string;
  lot_id: string;
  original_disposal_id: string | null;
  adjustment_amount: number;
  original_cost_basis_per_unit: number;
  adjusted_cost_basis_per_unit: number;
  window_days: number;
  disposed_at: Date;
  created_at: Date;
}

export interface WashSaleDetectionResult {
  isWashSale: boolean;
  windowDays: number;
  matchedRepurchaseLots: InvestmentLot[];
  adjustmentAmount: number;
  adjustments: WashSaleAdjustment[];
  previousCostBasisPerUnit: number;
  newCostBasisPerUnit: number;
}

export class WashSaleDetector {
  private readonly lotRepo: InvestmentLotRepository;
  private readonly adjustmentRepo: WashSaleAdjustmentRepository;
  private readonly auditLogRepo: AuditLogRepository;
  private readonly db: Pool;
  private readonly defaultWindowDays: number;

  constructor(
    lotRepo: InvestmentLotRepository,
    adjustmentRepo: WashSaleAdjustmentRepository,
    auditLogRepo: AuditLogRepository,
    db: Pool,
    defaultWindowDays: number = DEFAULT_WASH_SALE_WINDOW_DAYS,
  ) {
    if (defaultWindowDays < MIN_WINDOW_DAYS || defaultWindowDays > MAX_WINDOW_DAYS) {
      throw Errors.validationError(
        `Default wash-sale window must be between ${MIN_WINDOW_DAYS} and ${MAX_WINDOW_DAYS} days`,
      );
    }
    this.lotRepo = lotRepo;
    this.adjustmentRepo = adjustmentRepo;
    this.auditLogRepo = auditLogRepo;
    this.db = db;
    this.defaultWindowDays = defaultWindowDays;
  }

  /**
   * Detect wash-sale conditions for a given investor+offering+disposal date.
   *
   * A wash sale is triggered when the investor repurchased the same or substantially
   * identical security within the window (before or after the disposal date) and the
   * original disposal was executed at a loss.
   *
   * The adjustment recomputes cost basis by adding the disallowed loss to the
   * repurchased lot's cost basis per unit.
   *
   * This operation is idempotent per (investor, offering, disposed_at). If an
   * adjustment already exists for the same key, it is returned without duplication.
   *
   * @param input - Detection parameters including investor, offering, disposal details, and optional window
   * @returns WashSaleDetectionResult with adjustment details and audit chain info
   */
  async detect(input: WashSaleDetectorInput): Promise<WashSaleDetectionResult> {
    const windowDays = input.window_days ?? this.defaultWindowDays;
    if (windowDays < MIN_WINDOW_DAYS || windowDays > MAX_WINDOW_DAYS) {
      throw Errors.validationError(
        `Wash-sale window must be between ${MIN_WINDOW_DAYS} and ${MAX_WINDOW_DAYS} days`,
      );
    }

    if (input.disposal_realized_gain_loss >= 0) {
      return {
        isWashSale: false,
        windowDays: windowDays,
        matchedRepurchaseLots: [],
        adjustmentAmount: 0,
        adjustments: [],
        previousCostBasisPerUnit: input.disposal_cost_basis_per_unit,
        newCostBasisPerUnit: input.disposal_cost_basis_per_unit,
      };
    }

    const disposedAt = input.disposed_at;
    const windowStart = new Date(
      disposedAt.getTime() - windowDays * 24 * 60 * 60 * 1000,
    );
    const windowEnd = new Date(
      disposedAt.getTime() + windowDays * 24 * 60 * 60 * 1000,
    );

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      const existing = await this.adjustmentRepo.findByInvestorOfferingDate(
        client,
        input.investor_id,
        input.offering_id,
        disposedAt,
      );

      if (existing) {
        await client.query('COMMIT');
        return {
          isWashSale: true,
          windowDays: windowDays,
          matchedRepurchaseLots: [],
          adjustmentAmount: existing.adjustment_amount,
          adjustments: [existing],
          previousCostBasisPerUnit: existing.original_cost_basis_per_unit,
          newCostBasisPerUnit: existing.adjusted_cost_basis_per_unit,
        };
      }

      const repurchaseLots =
        await this.lotRepo.findByInvestorOfferingAndDateRange(
          client,
          input.investor_id,
          input.offering_id,
          windowStart,
          windowEnd,
        );

      if (repurchaseLots.length === 0) {
        await client.query('COMMIT');
        return {
          isWashSale: false,
          windowDays: windowDays,
          matchedRepurchaseLots: [],
          adjustmentAmount: 0,
          adjustments: [],
          previousCostBasisPerUnit: input.disposal_cost_basis_per_unit,
          newCostBasisPerUnit: input.disposal_cost_basis_per_unit,
        };
      }

      const totalDisallowedLoss = Math.abs(input.disposal_realized_gain_loss);
      const repurchaseTotalQuantity = repurchaseLots.reduce(
        (sum, lot) => sum + lot.remaining_quantity,
        0,
      );

      let totalAdjustment = 0;
      const adjustments: WashSaleAdjustment[] = [];

      for (const lot of repurchaseLots) {
        const proportion =
          lot.remaining_quantity / repurchaseTotalQuantity;

        const portionOfDisallowedLoss = totalDisallowedLoss * proportion;

        const adjustedBasis =
          lot.cost_basis_per_unit + portionOfDisallowedLoss;

        totalAdjustment += portionOfDisallowedLoss;

        const adjustment = await this.adjustmentRepo.createWithClient(client, {
          investor_id: input.investor_id,
          offering_id: input.offering_id,
          lot_id: lot.id,
          original_disposal_id: null,
          adjustment_amount: portionOfDisallowedLoss,
          original_cost_basis_per_unit: lot.cost_basis_per_unit,
          adjusted_cost_basis_per_unit: adjustedBasis,
          window_days: windowDays,
          disposed_at: disposedAt,
        });

        adjustments.push(adjustment);

        await this.auditLogRepo.createAuditLog({
          user_id: input.investor_id,
          action: 'WASH_SALE_ADJUSTMENT',
          resource: `wash_sale_adjustment:${adjustment.id}`,
          details: JSON.stringify({
            investor_id: input.investor_id,
            offering_id: input.offering_id,
            lot_id: lot.id,
            adjustment_amount: portionOfDisallowedLoss,
            original_cost_basis_per_unit: lot.cost_basis_per_unit,
            adjusted_cost_basis_per_unit: adjustedBasis,
            window_days: windowDays,
            disposed_at: disposedAt.toISOString(),
            disposal_realized_gain_loss: input.disposal_realized_gain_loss,
          }),
        });
      }

      await client.query('COMMIT');

      const previousCostBasisPerUnit =
        repurchaseLots.reduce(
          (sum, lot) => sum + lot.cost_basis_per_unit,
          0,
        ) / repurchaseLots.length;

      const newCostBasisPerUnit =
        previousCostBasisPerUnit + totalAdjustment / repurchaseTotalQuantity;

      return {
        isWashSale: true,
        windowDays: windowDays,
        matchedRepurchaseLots: repurchaseLots,
        adjustmentAmount: totalAdjustment,
        adjustments: adjustments,
        previousCostBasisPerUnit: previousCostBasisPerUnit,
        newCostBasisPerUnit: newCostBasisPerUnit,
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* suppress rollback errors */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Batch-detect wash sales across all offerings for an investor on a given date.
   *
   * @param investorId - The investor to check
   * @param disposedAt - The disposal date to check against
   * @param windowDays - Optional override window (default: 30)
   * @returns Array of detection results per offering
   */
  async detectForInvestor(
    investorId: string,
    disposedAt: Date,
    disposalGainLoss: number,
    disposalQuantity: number,
    disposalCostBasisPerUnit: number,
    windowDays?: number,
  ): Promise<WashSaleDetectionResult[]> {
    const lots = await this.lotRepo.listByInvestor(investorId);
    const offeringIds = Array.from(
      new Set(lots.map((lot) => lot.offering_id)),
    );

    const results = await Promise.all(
      offeringIds.map((offeringId) =>
        this.detect({
          investor_id: investorId,
          offering_id: offeringId,
          disposed_at: disposedAt,
          disposal_realized_gain_loss: disposalGainLoss,
          disposal_quantity: disposalQuantity,
          disposal_cost_basis_per_unit: disposalCostBasisPerUnit,
          window_days: windowDays,
        }),
      ),
    );

    return results;
  }
}

/**
 * Factory function to create WashSaleDetector with dependencies.
 */
export function createWashSaleDetector(
  lotRepo: InvestmentLotRepository,
  adjustmentRepo: WashSaleAdjustmentRepository,
  auditLogRepo: AuditLogRepository,
  db: Pool,
  defaultWindowDays?: number,
): WashSaleDetector {
  return new WashSaleDetector(
    lotRepo,
    adjustmentRepo,
    auditLogRepo,
    db,
    defaultWindowDays,
  );
}