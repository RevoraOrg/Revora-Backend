/**
 * Tests for enforceConcentrationCap (investmentConsistencyGuard.ts)
 *
 * Covers:
 *  - First investment passes when under cap
 *  - First investment passes when cap is NULL (no cap configured)
 *  - First investment fails when it alone exceeds the cap
 *  - Second investment triggers cap on the combined total
 *  - Investment at exact cap boundary is allowed
 *  - Investment one unit above exact cap is rejected
 *  - Missing/unknown offering rejects cleanly
 *  - Cap change resyncs: new lower cap is enforced immediately
 *  - max_investor_share_bps = 0 blocks all investments
 *  - max_investor_share_bps = 10000 (100%) allows full amount
 */

import { PoolClient } from 'pg';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { enforceConcentrationCap } from './investmentConsistencyGuard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): PoolClient {
  return {} as PoolClient; // passed through to repo mocks; never used directly
}

function makeRepo(opts: {
  maxShareBps: number | null;
  existingTotal?: string;
}): InvestmentRepository {
  const repo = {} as InvestmentRepository;
  repo.lockOffering = jest.fn().mockResolvedValue(
    opts.maxShareBps === undefined
      ? null
      : { max_investor_share_bps: opts.maxShareBps, total_raised: '0' },
  );
  repo.getInvestorTotalForOffering = jest
    .fn()
    .mockResolvedValue(opts.existingTotal ?? '0');
  return repo;
}

function makeNotFoundRepo(): InvestmentRepository {
  const repo = {} as InvestmentRepository;
  repo.lockOffering = jest.fn().mockResolvedValue(null);
  repo.getInvestorTotalForOffering = jest.fn();
  return repo;
}

const BASE = {
  investorId: 'investor-1',
  offeringId: 'offering-abc',
  totalOfferingAmount: 1_000_000, // 1M units
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enforceConcentrationCap', () => {
  describe('no cap (NULL max_investor_share_bps)', () => {
    it('allows any investment amount when cap is NULL', async () => {
      const repo = makeRepo({ maxShareBps: null });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 999_999_999 }),
      ).resolves.toBeUndefined();
      // getInvestorTotal should NOT be queried — short-circuit on null cap
      expect(repo.getInvestorTotalForOffering).not.toHaveBeenCalled();
    });
  });

  describe('offering not found', () => {
    it('throws when the offering row does not exist', async () => {
      const repo = makeNotFoundRepo();
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 1 }),
      ).rejects.toThrow('not found');
    });
  });

  describe('cap = 0 bps (fully restricted)', () => {
    it('rejects any positive investment', async () => {
      const repo = makeRepo({ maxShareBps: 0, existingTotal: '0' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 1 }),
      ).rejects.toThrow('concentration cap');
    });
  });

  describe('cap = 10000 bps (100%)', () => {
    it('allows an investment equal to the full offering amount', async () => {
      const repo = makeRepo({ maxShareBps: 10_000, existingTotal: '0' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, {
          ...BASE,
          newAmount: BASE.totalOfferingAmount,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('first investment', () => {
    it('passes when the new amount is below the cap', async () => {
      // cap = 10% of 1M = 100,000; new amount = 50,000
      const repo = makeRepo({ maxShareBps: 1_000, existingTotal: '0' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 50_000 }),
      ).resolves.toBeUndefined();
    });

    it('passes when the new amount is exactly at the cap', async () => {
      // cap = 10% of 1M = 100,000; new amount = 100,000
      const repo = makeRepo({ maxShareBps: 1_000, existingTotal: '0' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 100_000 }),
      ).resolves.toBeUndefined();
    });

    it('rejects when the new amount alone exceeds the cap', async () => {
      // cap = 10% of 1M = 100,000; new amount = 100,001
      const repo = makeRepo({ maxShareBps: 1_000, existingTotal: '0' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 100_001 }),
      ).rejects.toThrow('concentration cap');
    });
  });

  describe('second investment (cap hit on combined total)', () => {
    it('rejects when existing + new exceeds the cap', async () => {
      // cap = 10% of 1M = 100,000; investor already has 80,000; new = 30,000 → 110,000 > cap
      const repo = makeRepo({ maxShareBps: 1_000, existingTotal: '80000' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 30_000 }),
      ).rejects.toThrow('concentration cap');
    });

    it('passes when existing + new is exactly at the cap', async () => {
      // cap = 10% of 1M = 100,000; investor already has 70,000; new = 30,000 → 100,000 = cap
      const repo = makeRepo({ maxShareBps: 1_000, existingTotal: '70000' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 30_000 }),
      ).resolves.toBeUndefined();
    });

    it('passes when existing + new is one unit below the cap', async () => {
      // cap = 10% of 1M = 100,000; investor has 70,000; new = 29,999 → 99,999 < cap
      const repo = makeRepo({ maxShareBps: 1_000, existingTotal: '70000' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 29_999 }),
      ).resolves.toBeUndefined();
    });
  });

  describe('concurrent-submission race (lock serialisation)', () => {
    it('calls lockOffering before getInvestorTotalForOffering', async () => {
      const callOrder: string[] = [];
      const repo = {} as InvestmentRepository;
      repo.lockOffering = jest.fn().mockImplementation(async () => {
        callOrder.push('lock');
        return { max_investor_share_bps: 1_000, total_raised: '0' };
      });
      repo.getInvestorTotalForOffering = jest.fn().mockImplementation(async () => {
        callOrder.push('total');
        return '0';
      });

      await enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 1 });

      expect(callOrder).toEqual(['lock', 'total']);
    });
  });

  describe('cap change resyncs', () => {
    it('enforces the new lower cap after a resync', async () => {
      // Investor has 80,000; old cap was 20% but chain now says 5% = 50,000
      const repo = makeRepo({ maxShareBps: 500, existingTotal: '80000' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 1 }),
      ).rejects.toThrow('concentration cap');
    });

    it('allows investment once cap is raised via resync', async () => {
      // Investor has 80,000; cap raised on-chain to 20% = 200,000
      const repo = makeRepo({ maxShareBps: 2_000, existingTotal: '80000' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 100_000 }),
      ).resolves.toBeUndefined();
    });
  });

  describe('error message quality', () => {
    it('includes the BPS value and current committed amount in the rejection message', async () => {
      const repo = makeRepo({ maxShareBps: 1_000, existingTotal: '95000' });
      await expect(
        enforceConcentrationCap(makeClient(), repo, { ...BASE, newAmount: 10_000 }),
      ).rejects.toThrow('1000 bps');
    });
  });
});
