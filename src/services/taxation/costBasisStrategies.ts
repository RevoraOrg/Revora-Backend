/**
 * Cost-Basis Disposal Strategies: FIFO, LIFO, HIFO
 *
 * Implements pluggable disposal strategies for selecting which investment lots
 * to consume when processing a disposal. Each strategy selects lots differently:
 *
 * - FIFO (First-In-First-Out): Oldest lots consumed first.
 * - LIFO (Last-In-First-Out): Newest lots consumed first.
 * - HIFO (Highest-In-First-Out): Highest cost-basis lots consumed first.
 *
 * Security Assumptions:
 * - Lot data is validated before being passed to strategies (quantity > 0, cost_basis_per_unit >= 0).
 * - Strategies are pure functions returning deterministic allocations for the same input.
 * - Immutable historical evaluations: once a disposal is recorded, the lot selection is fixed.
 *
 * @module services/taxation/costBasisStrategies
 */

import { CostBasisStrategy, InvestmentLot, LotAllocation } from './types';

/**
 * Base validation shared by all strategies.
 * Ensures sufficient quantity exists across all available lots.
 */
function validateSufficientQuantity(lots: InvestmentLot[], quantityToDispose: number): void {
  const totalAvailable = lots.reduce((sum, lot) => sum + lot.remaining_quantity, 0);
  if (totalAvailable < quantityToDispose) {
    throw new Error(
      `Insufficient quantity across available lots: requested ${quantityToDispose}, available ${totalAvailable}`
    );
  }
}

/**
 * Allocates a given quantity across the provided (already sorted) lots.
 * Consumes from each lot in order until the quantity is satisfied.
 * Skips lots with remaining_quantity <= 0.
 */
function allocateAcrossLots(lots: InvestmentLot[], quantityToDispose: number): LotAllocation[] {
  const allocations: LotAllocation[] = [];
  let remaining = quantityToDispose;

  for (const lot of lots) {
    if (remaining <= 0) break;
    if (lot.remaining_quantity <= 0) continue;

    const consumed = Math.min(lot.remaining_quantity, remaining);

    allocations.push({
      lot,
      quantityConsumed: consumed,
      costBasisPerUnit: lot.cost_basis_per_unit,
      totalCostBasis: consumed * lot.cost_basis_per_unit,
    });

    remaining -= consumed;
  }

  return allocations;
}

/**
 * FIFO Strategy: First-In-First-Out
 *
 * Consumes lots in chronological order of acquisition (oldest first).
 * This is the most common strategy and the default for US tax reporting.
 */
export class FIFOStrategy implements CostBasisStrategy {
  readonly name = 'FIFO' as const;

  selectLots(lots: InvestmentLot[], quantityToDispose: number): LotAllocation[] {
    validateSufficientQuantity(lots, quantityToDispose);

    // Sort by acquisition date ascending (oldest first)
    const sorted = [...lots].sort(
      (a, b) => a.acquired_at.getTime() - b.acquired_at.getTime()
    );

    return allocateAcrossLots(sorted, quantityToDispose);
  }
}

/**
 * LIFO Strategy: Last-In-First-Out
 *
 * Consumes lots in reverse chronological order (newest first).
 * Often used to minimize taxable gains in rising markets by selling
 * higher-cost-basis (recently acquired) lots first.
 */
export class LIFOStrategy implements CostBasisStrategy {
  readonly name = 'LIFO' as const;

  selectLots(lots: InvestmentLot[], quantityToDispose: number): LotAllocation[] {
    validateSufficientQuantity(lots, quantityToDispose);

    // Sort by acquisition date descending (newest first)
    const sorted = [...lots].sort(
      (a, b) => b.acquired_at.getTime() - a.acquired_at.getTime()
    );

    return allocateAcrossLots(sorted, quantityToDispose);
  }
}

/**
 * HIFO Strategy: Highest-In-First-Out
 *
 * Consumes lots with the highest cost basis first.
 * This minimizes taxable gains by selling the most expensive lots first.
 * When cost bases are equal, falls back to FIFO (oldest first) for determinism.
 */
export class HIFOStrategy implements CostBasisStrategy {
  readonly name = 'HIFO' as const;

  selectLots(lots: InvestmentLot[], quantityToDispose: number): LotAllocation[] {
    validateSufficientQuantity(lots, quantityToDispose);

    // Sort by cost basis descending (highest first), tie-break by acquisition date ascending (oldest first)
    const sorted = [...lots].sort((a, b) => {
      const costDiff = b.cost_basis_per_unit - a.cost_basis_per_unit;
      if (costDiff !== 0) return costDiff;
      // For equal cost basis, fall back to FIFO (oldest first) for deterministic results
      return a.acquired_at.getTime() - b.acquired_at.getTime();
    });

    return allocateAcrossLots(sorted, quantityToDispose);
  }
}

/**
 * Strategy registry for looking up strategies by name.
 * Extensible: add new strategies here.
 */
export const STRATEGY_REGISTRY: Record<string, CostBasisStrategy> = {
  FIFO: new FIFOStrategy(),
  LIFO: new LIFOStrategy(),
  HIFO: new HIFOStrategy(),
};

/**
 * Resolve a strategy by name.
 * @param strategyName - The strategy name (FIFO, LIFO, HIFO)
 * @returns The strategy instance
 * @throws If the strategy name is not recognized
 */
export function resolveStrategy(strategyName: string): CostBasisStrategy {
  const strategy = STRATEGY_REGISTRY[strategyName.toUpperCase()];
  if (!strategy) {
    throw new Error(
      `Unknown disposal strategy: ${strategyName}. Supported strategies: FIFO, LIFO, HIFO`
    );
  }
  return strategy;
}
