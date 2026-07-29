/**
 * Tests for FIFO, LIFO, and HIFO cost-basis disposal strategies.
 *
 * Coverage targets:
 * - FIFO: oldest-first ordering, full/partial lot consumption, exact quantity match
 * - LIFO: newest-first ordering, full/partial lot consumption
 * - HIFO: highest-cost-first ordering, tie-breaking by FIFO
 * - Edge cases: zero remaining lots, fractional shares, single lot, insufficient quantity
 * - Immutability: strategies do not mutate input lots array
 * - Determinism: same input → same output every time
 */

import {
  FIFOStrategy,
  LIFOStrategy,
  HIFOStrategy,
  resolveStrategy,
  STRATEGY_REGISTRY,
} from './costBasisStrategies';
import { InvestmentLot, LotAllocation } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// FIFO Strategy
// ---------------------------------------------------------------------------

describe('FIFOStrategy', () => {
  const strategy = new FIFOStrategy();

  it('returns FIFO as its name', () => {
    expect(strategy.name).toBe('FIFO');
  });

  it('selects lots in chronological order (oldest first)', () => {
    const lots = [
      makeLot({ id: 'lot-b', acquired_at: new Date('2024-02-01'), remaining_quantity: 50 }),
      makeLot({ id: 'lot-a', acquired_at: new Date('2024-01-01'), remaining_quantity: 50 }),
      makeLot({ id: 'lot-c', acquired_at: new Date('2024-03-01'), remaining_quantity: 50 }),
    ];

    const result = strategy.selectLots(lots, 100);
    expect(result).toHaveLength(2);
    expect(result[0].lot.id).toBe('lot-a'); // oldest
    expect(result[1].lot.id).toBe('lot-b'); // second oldest
  });

  it('consumes a single lot completely when quantity matches exactly', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 50 }),
      makeLot({ id: 'lot-b', remaining_quantity: 50 }),
    ];

    const result = strategy.selectLots(lots, 50);
    expect(result).toHaveLength(1);
    expect(result[0].lot.id).toBe('lot-a');
    expect(result[0].quantityConsumed).toBe(50);
  });

  it('splits a lot partially when disposal quantity is less than lot quantity', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 100 }),
    ];

    const result = strategy.selectLots(lots, 30);
    expect(result).toHaveLength(1);
    expect(result[0].quantityConsumed).toBe(30);
    expect(result[0].totalCostBasis).toBe(30 * 10); // 30 units @ $10 each
  });

  it('consumes from multiple lots when disposal quantity spans lots', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 40, cost_basis_per_unit: 5 }),
      makeLot({ id: 'lot-b', remaining_quantity: 40, cost_basis_per_unit: 10 }),
      makeLot({ id: 'lot-c', remaining_quantity: 40, cost_basis_per_unit: 15 }),
    ];

    const result = strategy.selectLots(lots, 100);
    expect(result).toHaveLength(3);
    expect(result[0].quantityConsumed).toBe(40);
    expect(result[1].quantityConsumed).toBe(40);
    expect(result[2].quantityConsumed).toBe(20);
  });

  it('skips exhausted lots (remaining_quantity = 0)', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 0, status: 'exhausted' }),
      makeLot({ id: 'lot-b', remaining_quantity: 50 }),
    ];

    const result = strategy.selectLots(lots, 30);
    expect(result).toHaveLength(1);
    expect(result[0].lot.id).toBe('lot-b');
  });

  it('handles fractional shares correctly', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 10.5, cost_basis_per_unit: 12.345678 }),
    ];

    const result = strategy.selectLots(lots, 5.25);
    expect(result).toHaveLength(1);
    expect(result[0].quantityConsumed).toBe(5.25);
    expect(result[0].totalCostBasis).toBeCloseTo(5.25 * 12.345678, 8);
  });

  it('throws when total available quantity is insufficient', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 10 }),
      makeLot({ id: 'lot-b', remaining_quantity: 5 }),
    ];

    expect(() => strategy.selectLots(lots, 20)).toThrow(
      'Insufficient quantity across available lots: requested 20, available 15'
    );
  });

  it('throws when there are no lots', () => {
    expect(() => strategy.selectLots([], 10)).toThrow(
      'Insufficient quantity across available lots: requested 10, available 0'
    );
  });

  it('does not mutate the input lots array', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 100 }),
      makeLot({ id: 'lot-b', remaining_quantity: 50 }),
    ];
    const originalRemaining = lots.map((l) => l.remaining_quantity);

    strategy.selectLots(lots, 80);

    // Verify original array is unchanged
    expect(lots[0].remaining_quantity).toBe(originalRemaining[0]);
    expect(lots[1].remaining_quantity).toBe(originalRemaining[1]);
  });

  it('handles disposal of exact total of all lots', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 30 }),
      makeLot({ id: 'lot-b', remaining_quantity: 20 }),
    ];

    const result = strategy.selectLots(lots, 50);
    expect(result).toHaveLength(2);
    expect(result[0].quantityConsumed).toBe(30);
    expect(result[1].quantityConsumed).toBe(20);
  });

  it('maintains deterministic ordering for lots with same acquired_at', () => {
    const sameDate = new Date('2024-01-01');
    const lots = [
      makeLot({ id: 'lot-c', acquired_at: sameDate, remaining_quantity: 30 }),
      makeLot({ id: 'lot-a', acquired_at: sameDate, remaining_quantity: 30 }),
      makeLot({ id: 'lot-b', acquired_at: sameDate, remaining_quantity: 30 }),
    ];

    // FIFO with same timestamps: order should be stable between runs
    const result1 = strategy.selectLots(lots, 30);
    const result2 = strategy.selectLots(lots, 30);
    expect(result1[0].lot.id).toBe(result2[0].lot.id);
  });
});

// ---------------------------------------------------------------------------
// LIFO Strategy
// ---------------------------------------------------------------------------

describe('LIFOStrategy', () => {
  const strategy = new LIFOStrategy();

  it('returns LIFO as its name', () => {
    expect(strategy.name).toBe('LIFO');
  });

  it('selects lots in reverse chronological order (newest first)', () => {
    const lots = [
      makeLot({ id: 'lot-a', acquired_at: new Date('2024-01-01'), remaining_quantity: 50 }),
      makeLot({ id: 'lot-b', acquired_at: new Date('2024-02-01'), remaining_quantity: 50 }),
      makeLot({ id: 'lot-c', acquired_at: new Date('2024-03-01'), remaining_quantity: 50 }),
    ];

    const result = strategy.selectLots(lots, 100);
    expect(result).toHaveLength(2);
    expect(result[0].lot.id).toBe('lot-c'); // newest
    expect(result[1].lot.id).toBe('lot-b'); // second newest
  });

  it('consumes newest lot completely before touching older lots', () => {
    const lots = [
      makeLot({ id: 'old', acquired_at: new Date('2024-01-01'), remaining_quantity: 100 }),
      makeLot({ id: 'new', acquired_at: new Date('2024-06-01'), remaining_quantity: 50 }),
    ];

    const result = strategy.selectLots(lots, 80);
    expect(result[0].lot.id).toBe('new');
    expect(result[0].quantityConsumed).toBe(50);
    expect(result[1].lot.id).toBe('old');
    expect(result[1].quantityConsumed).toBe(30);
  });

  it('handles fractional shares correctly', () => {
    const lots = [
      makeLot({ id: 'old', acquired_at: new Date('2024-01-01'), remaining_quantity: 5.5, cost_basis_per_unit: 10 }),
      makeLot({ id: 'new', acquired_at: new Date('2024-06-01'), remaining_quantity: 3.3, cost_basis_per_unit: 15 }),
    ];

    const result = strategy.selectLots(lots, 7.7);
    expect(result[0].lot.id).toBe('new');
    expect(result[0].quantityConsumed).toBe(3.3);
    expect(result[1].lot.id).toBe('old');
    expect(result[1].quantityConsumed).toBe(4.4);
    expect(result[1].totalCostBasis).toBeCloseTo(4.4 * 10, 8);
  });

  it('throws when insufficient quantity', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 10 }),
    ];

    expect(() => strategy.selectLots(lots, 15)).toThrow('Insufficient quantity');
  });

  it('does not mutate input lots', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 100 }),
      makeLot({ id: 'lot-b', remaining_quantity: 50, acquired_at: new Date('2024-06-01') }),
    ];
    const originalRemaining = lots.map((l) => l.remaining_quantity);

    strategy.selectLots(lots, 80);

    expect(lots[0].remaining_quantity).toBe(originalRemaining[0]);
    expect(lots[1].remaining_quantity).toBe(originalRemaining[1]);
  });
});

// ---------------------------------------------------------------------------
// HIFO Strategy
// ---------------------------------------------------------------------------

describe('HIFOStrategy', () => {
  const strategy = new HIFOStrategy();

  it('returns HIFO as its name', () => {
    expect(strategy.name).toBe('HIFO');
  });

  it('selects lots by highest cost basis first', () => {
    const lots = [
      makeLot({ id: 'cheap', cost_basis_per_unit: 5, remaining_quantity: 100 }),
      makeLot({ id: 'expensive', cost_basis_per_unit: 15, remaining_quantity: 50 }),
      makeLot({ id: 'medium', cost_basis_per_unit: 10, remaining_quantity: 50 }),
    ];

    const result = strategy.selectLots(lots, 100);
    expect(result).toHaveLength(2);
    expect(result[0].lot.id).toBe('expensive'); // highest cost
    expect(result[0].quantityConsumed).toBe(50);
    expect(result[1].lot.id).toBe('medium'); // second highest
    expect(result[1].quantityConsumed).toBe(50);
  });

  it('tie-breaks by FIFO (oldest first) when cost bases are equal', () => {
    const lots = [
      makeLot({ id: 'new-cheap', cost_basis_per_unit: 10, acquired_at: new Date('2024-06-01'), remaining_quantity: 50 }),
      makeLot({ id: 'old-cheap', cost_basis_per_unit: 10, acquired_at: new Date('2024-01-01'), remaining_quantity: 50 }),
    ];

    const result = strategy.selectLots(lots, 80);
    // Both have same cost basis (10), oldest should be consumed first
    expect(result[0].lot.id).toBe('old-cheap');
    expect(result[0].quantityConsumed).toBe(50);
    expect(result[1].lot.id).toBe('new-cheap');
    expect(result[1].quantityConsumed).toBe(30);
  });

  it('minimizes realized gain by selling highest-cost-basis lots first', () => {
    const lots = [
      makeLot({ id: 'low', cost_basis_per_unit: 10, remaining_quantity: 100 }),
      makeLot({ id: 'high', cost_basis_per_unit: 20, remaining_quantity: 100 }),
    ];

    const result = strategy.selectLots(lots, 100);
    expect(result[0].lot.id).toBe('high');
    expect(result[0].costBasisPerUnit).toBe(20);
    expect(result[0].quantityConsumed).toBe(100);
  });

  it('handles fractional shares with HIFO ordering', () => {
    const lots = [
      makeLot({ id: 'a', cost_basis_per_unit: 10.5, remaining_quantity: 12.34 }),
      makeLot({ id: 'b', cost_basis_per_unit: 20.75, remaining_quantity: 5.678 }),
    ];

    const result = strategy.selectLots(lots, 8);
    expect(result[0].lot.id).toBe('b'); // highest cost
    expect(result[0].quantityConsumed).toBe(5.678);
    expect(result[1].lot.id).toBe('a');
    expect(result[1].quantityConsumed).toBeCloseTo(2.322, 3);
  });

  it('throws when insufficient quantity', () => {
    const lots = [
      makeLot({ id: 'lot-a', remaining_quantity: 5 }),
    ];

    expect(() => strategy.selectLots(lots, 10)).toThrow('Insufficient quantity');
  });

  it('does not mutate input lots', () => {
    const lots = [
      makeLot({ id: 'a', cost_basis_per_unit: 10, remaining_quantity: 50 }),
      makeLot({ id: 'b', cost_basis_per_unit: 20, remaining_quantity: 50 }),
    ];
    const originalRemaining = lots.map((l) => l.remaining_quantity);

    strategy.selectLots(lots, 80);

    expect(lots[0].remaining_quantity).toBe(originalRemaining[0]);
    expect(lots[1].remaining_quantity).toBe(originalRemaining[1]);
  });

  it('handles all lots with same cost basis (tie-break by FIFO)', () => {
    const lots = [
      makeLot({ id: 'c', cost_basis_per_unit: 10, acquired_at: new Date('2024-03-01'), remaining_quantity: 33 }),
      makeLot({ id: 'a', cost_basis_per_unit: 10, acquired_at: new Date('2024-01-01'), remaining_quantity: 33 }),
      makeLot({ id: 'b', cost_basis_per_unit: 10, acquired_at: new Date('2024-02-01'), remaining_quantity: 34 }),
    ];

    const result = strategy.selectLots(lots, 100);
    expect(result[0].lot.id).toBe('a');
    expect(result[1].lot.id).toBe('b');
    expect(result[2].lot.id).toBe('c');
  });
});

// ---------------------------------------------------------------------------
// resolveStrategy
// ---------------------------------------------------------------------------

describe('resolveStrategy', () => {
  it('resolves FIFO strategy case-insensitively', () => {
    const s = resolveStrategy('fifo');
    expect(s).toBeInstanceOf(FIFOStrategy);
    expect(s.name).toBe('FIFO');
  });

  it('resolves LIFO strategy', () => {
    const s = resolveStrategy('LIFO');
    expect(s).toBeInstanceOf(LIFOStrategy);
  });

  it('resolves HIFO strategy', () => {
    const s = resolveStrategy('HIFO');
    expect(s).toBeInstanceOf(HIFOStrategy);
  });

  it('throws for unknown strategy', () => {
    expect(() => resolveStrategy('UNKNOWN')).toThrow('Unknown disposal strategy');
  });

  it('throws for empty strategy name', () => {
    expect(() => resolveStrategy('')).toThrow('Unknown disposal strategy');
  });
});

// ---------------------------------------------------------------------------
// STRATEGY_REGISTRY
// ---------------------------------------------------------------------------

describe('STRATEGY_REGISTRY', () => {
  it('contains FIFO, LIFO, and HIFO strategies', () => {
    expect(STRATEGY_REGISTRY.FIFO).toBeInstanceOf(FIFOStrategy);
    expect(STRATEGY_REGISTRY.LIFO).toBeInstanceOf(LIFOStrategy);
    expect(STRATEGY_REGISTRY.HIFO).toBeInstanceOf(HIFOStrategy);
  });

  it('each strategy has correct name', () => {
    expect(STRATEGY_REGISTRY.FIFO.name).toBe('FIFO');
    expect(STRATEGY_REGISTRY.LIFO.name).toBe('LIFO');
    expect(STRATEGY_REGISTRY.HIFO.name).toBe('HIFO');
  });
});
