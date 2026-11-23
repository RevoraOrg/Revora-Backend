/**
 * Tests for the synchronous investment consistency guard in
 * `investmentConsistencyGuard.ts` — `enforceInvestmentConsistency`, `canInvest`
 * and `isValidAmount`.
 *
 * The sibling `investmentConsistencyGuard.concentrationCap.test.ts` covers only
 * the async `enforceConcentrationCap` path, so these are the complementary
 * regression tests for the three documented "required field" rejections
 * (`Offering ID is required`, `Investor ID is required`,
 * `Offering status is required`) plus the status gate, the amount gate, the
 * order in which the gates fire, and the boundary inputs around them.
 *
 * Contract reference: docs/investment-consistency-checks.md
 */

import {
  canInvest,
  enforceInvestmentConsistency,
  INVESTABLE_STATUSES,
  isValidAmount,
  OfferingStatus,
} from './investmentConsistencyGuard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ConsistencyInput = Parameters<typeof enforceInvestmentConsistency>[0];

const VALID_INPUT: ConsistencyInput = {
  offeringStatus: 'published',
  amount: 1_000,
  investorId: 'investor-1',
  offeringId: 'offering-abc',
};

/** Builds an input from VALID_INPUT with individual fields overridden/blanked. */
function attempt(overrides: Partial<Record<keyof ConsistencyInput, unknown>>): void {
  enforceInvestmentConsistency({ ...VALID_INPUT, ...overrides } as ConsistencyInput);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('investmentConsistencyGuard (synchronous checks)', () => {
  describe('INVESTABLE_STATUSES', () => {
    it('exposes only `published` as investable', () => {
      expect(INVESTABLE_STATUSES).toEqual(['published']);
    });
  });

  describe('canInvest', () => {
    it.each<[OfferingStatus, boolean]>([
      ['published', true],
      ['draft', false],
      ['pending_review', false],
      ['approved', false],
      ['rejected', false],
      ['archived', false],
    ])('canInvest(%s) === %s', (status, expected) => {
      expect(canInvest(status)).toBe(expected);
    });

    it('does not throw for an out-of-contract status value', () => {
      expect(() => canInvest('not-a-status' as OfferingStatus)).not.toThrow();
      expect(canInvest('not-a-status' as OfferingStatus)).toBe(false);
    });
  });

  describe('isValidAmount', () => {
    it.each([
      ['smallest positive double', Number.MIN_VALUE],
      ['fractional', 0.1 + 0.2],
      ['one unit', 1],
      ['integer amount', 1_000],
      ['largest safe integer', Number.MAX_SAFE_INTEGER],
    ])('accepts %s', (_label, amount) => {
      expect(isValidAmount(amount)).toBe(true);
    });

    it.each([
      ['positive zero', 0],
      ['negative zero', -0],
      ['negative', -1],
      ['negative fraction', -0.5],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['NaN', NaN],
    ])('rejects %s', (_label, amount) => {
      expect(isValidAmount(amount)).toBe(false);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['numeric string', '100'],
      ['object', {}],
    ])('rejects a non-number value: %s', (_label, amount) => {
      expect(isValidAmount(amount as unknown as number)).toBe(false);
    });
  });

  describe('enforceInvestmentConsistency', () => {
    describe('required identity fields', () => {
      it('accepts a fully valid published investment without throwing', () => {
        expect(() => enforceInvestmentConsistency(VALID_INPUT)).not.toThrow();
      });

      it.each([
        ['empty string', ''],
        ['undefined', undefined],
        ['null', null],
      ])('throws `Offering ID is required` when offeringId is %s', (_label, offeringId) => {
        expect(() => attempt({ offeringId })).toThrow('Offering ID is required');
      });

      it.each([
        ['empty string', ''],
        ['undefined', undefined],
        ['null', null],
      ])('throws `Investor ID is required` when investorId is %s', (_label, investorId) => {
        expect(() => attempt({ investorId })).toThrow('Investor ID is required');
      });

      it.each([
        ['empty string', ''],
        ['undefined', undefined],
        ['null', null],
      ])('throws `Offering status is required` when offeringStatus is %s', (_label, offeringStatus) => {
        expect(() => attempt({ offeringStatus })).toThrow('Offering status is required');
      });

      it('reports the offering ID error first when every field is blank', () => {
        expect(() =>
          attempt({ offeringId: '', investorId: '', offeringStatus: '', amount: undefined as unknown as number })
        ).toThrow('Offering ID is required');
      });

      it('reports the investor ID error before the status error', () => {
        expect(() => attempt({ investorId: '', offeringStatus: '' })).toThrow('Investor ID is required');
      });
    });

    describe('offering status gate', () => {
      it.each<OfferingStatus>(['draft', 'pending_review', 'approved', 'rejected', 'archived'])(
        'rejects a %s offering and names the observed status',
        status => {
          expect(() => attempt({ offeringStatus: status })).toThrow(
            `Offering is not open for investment. Current status: ${status}`
          );
        }
      );

      it('rejects an out-of-contract status value and echoes it back', () => {
        expect(() => attempt({ offeringStatus: 'not-a-status' })).toThrow(
          'Offering is not open for investment. Current status: not-a-status'
        );
      });

      it('does not normalise case or surrounding whitespace before the status gate', () => {
        // Status matching is exact — alias/normalisation lives in offeringStatusGuard.
        expect(() => attempt({ offeringStatus: 'PUBLISHED' })).toThrow('Offering is not open for investment');
        expect(() => attempt({ offeringStatus: ' published ' })).toThrow('Offering is not open for investment');
      });
    });

    describe('amount gate', () => {
      it.each([
        ['undefined', undefined],
        ['null', null],
      ])('throws `Investment amount is required` when amount is %s', (_label, amount) => {
        expect(() => attempt({ amount })).toThrow('Investment amount is required');
      });

      it('distinguishes zero from a missing amount', () => {
        // `0` is falsy, but it must hit the positivity branch, not the "required" branch.
        expect(() => attempt({ amount: 0 })).toThrow('Investment amount must be a positive number');
        expect(() => attempt({ amount: 0 })).not.toThrow('Investment amount is required');
      });

      it.each([
        ['zero', 0],
        ['negative', -1],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['NaN', NaN],
      ])('throws `Investment amount must be a positive number` when amount is %s', (_label, amount) => {
        expect(() => attempt({ amount })).toThrow('Investment amount must be a positive number');
      });

      it('accepts the smallest positive double at the lower boundary', () => {
        expect(() => attempt({ amount: Number.MIN_VALUE })).not.toThrow();
      });
    });

    describe('gate ordering', () => {
      it('reports the status gate before the amount gate', () => {
        // Both are invalid: the offering state is checked first.
        expect(() => attempt({ offeringStatus: 'draft', amount: -1 })).toThrow(
          'Offering is not open for investment'
        );
        expect(() => attempt({ offeringStatus: 'draft', amount: -1 })).not.toThrow(
          'Investment amount must be a positive number'
        );
      });

      it('reports the amount gate only once identity and status pass', () => {
        expect(() => attempt({ amount: NaN })).toThrow('Investment amount must be a positive number');
        expect(() => attempt({ amount: NaN })).not.toThrow('Offering ID is required');
      });
    });
  });
});
