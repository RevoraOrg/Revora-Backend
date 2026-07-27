/**
 * Unit tests for KYC risk-tier investment cap resolution.
 *
 * Covers multipliers, restricted/null offering baselines, boundary checks,
 * and the "tier upgrade unblocks only on next intent" evaluation semantics.
 */

import {
  CapResolution,
  DEFAULT_KYC_RISK_TIER,
  INVESTOR_CAP_RECALCULATED_ACTION,
  TIER_CAP_MULTIPLIERS,
  effectiveCapAmount,
  evaluateInvestmentAgainstCap,
  isKycRiskTier,
  parseKycRiskTier,
  resolveEffectiveCap,
} from '../kycRiskTierCaps';

describe('kycRiskTierCaps', () => {
  describe('isKycRiskTier / parseKycRiskTier', () => {
    it('accepts known tiers', () => {
      expect(isKycRiskTier('high')).toBe(true);
      expect(isKycRiskTier('restricted')).toBe(true);
      expect(isKycRiskTier('nope')).toBe(false);
      expect(isKycRiskTier(1)).toBe(false);
    });

    it('falls back to standard for invalid values', () => {
      expect(parseKycRiskTier(undefined)).toBe(DEFAULT_KYC_RISK_TIER);
      expect(parseKycRiskTier('bogus')).toBe('standard');
      expect(parseKycRiskTier('elevated')).toBe('elevated');
    });
  });

  describe('resolveEffectiveCap', () => {
    it('scales offering cap by tier multiplier (high-risk → lower cap)', () => {
      const base = 1_000; // 10%
      expect(resolveEffectiveCap(base, 'low').effectiveCapBps).toBe(1_000);
      expect(resolveEffectiveCap(base, 'standard').effectiveCapBps).toBe(1_000);
      expect(resolveEffectiveCap(base, 'elevated').effectiveCapBps).toBe(500);
      expect(resolveEffectiveCap(base, 'high').effectiveCapBps).toBe(250);
      expect(resolveEffectiveCap(base, 'restricted').effectiveCapBps).toBe(0);
    });

    it('floors fractional scaled bps', () => {
      // 333 * 0.25 = 83.25 → 83
      expect(resolveEffectiveCap(333, 'high').effectiveCapBps).toBe(83);
    });

    it('returns null (unlimited) when offering has no cap and tier is not restricted', () => {
      expect(resolveEffectiveCap(null, 'standard').effectiveCapBps).toBeNull();
      expect(resolveEffectiveCap(undefined, 'elevated').effectiveCapBps).toBeNull();
    });

    it('restricted always resolves to 0 even without an offering cap', () => {
      expect(resolveEffectiveCap(null, 'restricted').effectiveCapBps).toBe(0);
      expect(resolveEffectiveCap(5_000, 'restricted').effectiveCapBps).toBe(0);
    });

    it('exposes multiplier metadata for audits', () => {
      const r = resolveEffectiveCap(2_000, 'high');
      expect(r.multiplier).toBe(TIER_CAP_MULTIPLIERS.high);
      expect(r.offeringCapBps).toBe(2_000);
      expect(r.tier).toBe('high');
    });
  });

  describe('effectiveCapAmount', () => {
    it('converts bps to absolute units', () => {
      const resolution: CapResolution = {
        tier: 'elevated',
        multiplier: 0.5,
        offeringCapBps: 1_000,
        effectiveCapBps: 500,
      };
      expect(effectiveCapAmount(resolution, 1_000_000)).toBe(50_000);
    });

    it('returns null when unlimited', () => {
      const resolution = resolveEffectiveCap(null, 'standard');
      expect(effectiveCapAmount(resolution, 1_000_000)).toBeNull();
    });

    it('rejects non-finite offering size', () => {
      const resolution = resolveEffectiveCap(1_000, 'standard');
      expect(() => effectiveCapAmount(resolution, Number.NaN)).toThrow(/non-negative finite/);
    });
  });

  describe('evaluateInvestmentAgainstCap', () => {
    const offeringSize = 1_000_000;

    it('allows any amount when offering has no static cap (unlimited)', () => {
      const resolution = resolveEffectiveCap(null, 'standard');
      const result = evaluateInvestmentAgainstCap({
        existingTotal: 999_999,
        newAmount: 999_999,
        totalOfferingAmount: offeringSize,
        resolution,
      });
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.capAmount).toBeNull();
      }
    });

    it('allows investment under the tier-adjusted cap', () => {
      const resolution = resolveEffectiveCap(1_000, 'high'); // 250 bps → 25_000
      const result = evaluateInvestmentAgainstCap({
        existingTotal: 10_000,
        newAmount: 15_000,
        totalOfferingAmount: offeringSize,
        resolution,
      });
      expect(result.allowed).toBe(true);
    });

    it('rejects when existing + new would exceed the adjusted cap', () => {
      const resolution = resolveEffectiveCap(1_000, 'high'); // 25_000
      const result = evaluateInvestmentAgainstCap({
        existingTotal: 20_000,
        newAmount: 6_000,
        totalOfferingAmount: offeringSize,
        resolution,
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toMatch(/KYC risk-tier adjusted cap/);
        expect(result.capAmount).toBe(25_000);
      }
    });

    it('allows exact boundary', () => {
      const resolution = resolveEffectiveCap(1_000, 'elevated'); // 50_000
      const result = evaluateInvestmentAgainstCap({
        existingTotal: 40_000,
        newAmount: 10_000,
        totalOfferingAmount: offeringSize,
        resolution,
      });
      expect(result.allowed).toBe(true);
    });

    it('restricted blocks any positive new amount', () => {
      const resolution = resolveEffectiveCap(1_000, 'restricted');
      const result = evaluateInvestmentAgainstCap({
        existingTotal: 0,
        newAmount: 1,
        totalOfferingAmount: offeringSize,
        resolution,
      });
      expect(result.allowed).toBe(false);
    });

    it('tier upgrade unblocks prior above-cap attempt only on next evaluation', () => {
      const offeringCapBps = 1_000; // 100_000 absolute at standard
      const totalOfferingAmount = offeringSize;
      const existingTotal = 0;
      const attempted = 60_000;

      const blocked = evaluateInvestmentAgainstCap({
        existingTotal,
        newAmount: attempted,
        totalOfferingAmount,
        resolution: resolveEffectiveCap(offeringCapBps, 'high'), // 25_000
      });
      expect(blocked.allowed).toBe(false);

      // Existing commitment unchanged (still 0) — upgrade alone does nothing
      // until the next intent is evaluated:
      const afterUpgrade = evaluateInvestmentAgainstCap({
        existingTotal,
        newAmount: attempted,
        totalOfferingAmount,
        resolution: resolveEffectiveCap(offeringCapBps, 'standard'), // 100_000
      });
      expect(afterUpgrade.allowed).toBe(true);
    });

    it('never treats prior over-cap commitments as invalidating — only gates new amount', () => {
      // Investor somehow already holds 80k (legacy / grandfathered). Cap is now 50k.
      // A zero-size "intent" is not used; a tiny new amount still fails, but we do not
      // claw back the 80k — evaluate only cares about existing+new vs cap.
      const resolution = resolveEffectiveCap(1_000, 'elevated'); // 50_000
      const addMore = evaluateInvestmentAgainstCap({
        existingTotal: 80_000,
        newAmount: 1,
        totalOfferingAmount: offeringSize,
        resolution,
      });
      expect(addMore.allowed).toBe(false);
      // No mutation API exists — existingTotal is an input, not rewritten.
      expect(addMore.allowed === false && addMore.existingTotal).toBe(80_000);
    });
  });

  describe('audit action constant', () => {
    it('uses the investor.cap.recalculated action string', () => {
      expect(INVESTOR_CAP_RECALCULATED_ACTION).toBe('investor.cap.recalculated');
    });
  });
});
