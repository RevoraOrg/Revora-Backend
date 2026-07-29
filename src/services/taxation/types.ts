/**
 * Taxation Types: Cost-Basis Tracking with Pluggable Disposal Strategies
 *
 * Security Assumptions:
 * - Lot data is immutable once created (cost_basis_per_unit, quantity, acquired_at are never modified).
 * - Disposal records are immutable once created. Historical evaluations cannot be altered.
 * - Strategy changes are forward-only (new strategy applies to future disposals only).
 * - Dual-control is required for strategy changes (not enforced at this layer).
 *
 * @module services/taxation/types
 */

/** Status of an investment lot */
export type LotStatus = 'open' | 'partially_used' | 'exhausted';

/** Supported cost-basis disposal strategies */
export type DisposalStrategy = 'FIFO' | 'LIFO' | 'HIFO';

/** An investment lot representing a discrete acquisition */
export interface InvestmentLot {
  id: string;
  investor_id: string;
  offering_id: string;
  investment_id: string;
  asset: string;
  /** Total quantity acquired in this lot */
  quantity: number;
  /** Cost basis per unit at acquisition (immutable) */
  cost_basis_per_unit: number;
  /** Total cost basis = quantity * cost_basis_per_unit */
  total_cost_basis: number;
  /** Remaining quantity available for disposal */
  remaining_quantity: number;
  /** Currency of cost basis */
  cost_currency: string;
  /** Acquisition date (immutable, used for FIFO/LIFO ordering) */
  acquired_at: Date;
  /** Investor jurisdiction */
  jurisdiction: string;
  /** Lot status */
  status: LotStatus;
  created_at: Date;
  updated_at: Date;
}

/** Input for creating a new investment lot */
export interface CreateInvestmentLotInput {
  investor_id: string;
  offering_id: string;
  investment_id: string;
  asset: string;
  quantity: number;
  cost_basis_per_unit: number;
  cost_currency?: string;
  acquired_at: Date;
  jurisdiction?: string;
}

/** A disposal record tracking lot consumption */
export interface Disposal {
  id: string;
  investor_id: string;
  offering_id: string;
  lot_id: string;
  quantity_disposed: number;
  cost_basis_per_unit: number;
  total_cost_basis: number;
  proceeds: number;
  realized_gain_loss: number;
  disposal_price_per_unit: number;
  strategy: DisposalStrategy;
  currency: string;
  jurisdiction: string;
  disposed_at: Date;
  tax_report_finalized: boolean;
  tax_report_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Input for creating a disposal */
export interface CreateDisposalInput {
  investor_id: string;
  offering_id: string;
  lot_id: string;
  quantity_disposed: number;
  cost_basis_per_unit: number;
  total_cost_basis: number;
  proceeds: number;
  realized_gain_loss: number;
  disposal_price_per_unit: number;
  strategy: DisposalStrategy;
  currency?: string;
  jurisdiction?: string;
  disposed_at: Date;
}

/** A single lot allocation produced by a disposal strategy */
export interface LotAllocation {
  /** The lot being consumed */
  lot: InvestmentLot;
  /** Quantity consumed from this lot */
  quantityConsumed: number;
  /** Cost basis per unit from this lot */
  costBasisPerUnit: number;
  /** Total cost basis for this allocation (quantityConsumed * costBasisPerUnit) */
  totalCostBasis: number;
}

/** Result of processing a disposal through a strategy */
export interface DisposalResult {
  /** The list of lot allocations consumed */
  allocations: LotAllocation[];
  /** Total quantity disposed across all allocations */
  totalQuantityDisposed: number;
  /** Weighted average cost basis per unit across all allocations */
  weightedAverageCostBasis: number;
  /** Total cost basis across all allocations */
  totalCostBasis: number;
  /** Realized gain/loss (proceeds - totalCostBasis) */
  realizedGainLoss: number;
  /** Strategy used */
  strategy: DisposalStrategy;
}

/** Per-jurisdiction gains summary */
export interface JurisdictionGainsSummary {
  jurisdiction: string;
  totalProceeds: number;
  totalCostBasis: number;
  totalRealizedGainLoss: number;
  disposalCount: number;
  strategyBreakdown: Record<DisposalStrategy, {
    count: number;
    totalGainLoss: number;
  }>;
}

/** Input for processing a disposal */
export interface ProcessDisposalInput {
  investor_id: string;
  offering_id: string;
  quantity: number;
  disposal_price_per_unit: number;
  strategy: DisposalStrategy;
  currency?: string;
  disposed_at?: Date;
}

/** Cost-basis strategy interface */
export interface CostBasisStrategy {
  /** The strategy name */
  readonly name: DisposalStrategy;

  /**
   * Select lots to consume for a given disposal quantity.
   * Returns an ordered list of lot allocations.
   * @param lots - Available open/partially_used lots for the investor+offering
   * @param quantityToDispose - Total quantity to dispose
   * @returns Array of lot allocations covering the disposal quantity
   * @throws If insufficient quantity across all available lots
   */
  selectLots(lots: InvestmentLot[], quantityToDispose: number): LotAllocation[];
}
