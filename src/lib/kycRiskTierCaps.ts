/**
 * KYC risk-tier investment cap resolution.
 *
 * Offering concentration caps (`max_investor_share_bps`) remain the static
 * baseline. Each investor's `kyc_risk_tier` scales that baseline so higher-risk
 * investors face a lower effective cap on **new** investment intents.
 *
 * Invariants:
 * - Existing investments are never retroactively invalidated when a tier (or
 *   the offering cap) changes.
 * - A prior intent that was blocked by a tight tier is re-evaluated only on
 *   the **next** createInvestment call after a tier upgrade.
 * - `restricted` always resolves to 0 bps (blocks new capital) even when the
 *   offering has no static cap configured.
 */

export const KYC_RISK_TIERS = [
  'low',
  'standard',
  'elevated',
  'high',
  'restricted',
] as const;

export type KycRiskTier = (typeof KYC_RISK_TIERS)[number];

export const DEFAULT_KYC_RISK_TIER: KycRiskTier = 'standard';

/**
 * Multiplier applied to the offering's `max_investor_share_bps`.
 * High-risk tiers receive strictly lower multipliers.
 */
export const TIER_CAP_MULTIPLIERS: Readonly<Record<KycRiskTier, number>> = {
  low: 1.0,
  standard: 1.0,
  elevated: 0.5,
  high: 0.25,
  restricted: 0,
};

export function isKycRiskTier(value: unknown): value is KycRiskTier {
  return typeof value === 'string' && (KYC_RISK_TIERS as readonly string[]).includes(value);
}

export function parseKycRiskTier(value: unknown, fallback: KycRiskTier = DEFAULT_KYC_RISK_TIER): KycRiskTier {
  return isKycRiskTier(value) ? value : fallback;
}

export interface CapResolution {
  tier: KycRiskTier;
  multiplier: number;
  /** Offering baseline in bps, or null when the offering has no static cap. */
  offeringCapBps: number | null;
  /**
   * Effective per-investor cap in bps after applying the tier multiplier.
   * `null` means unlimited (no offering cap and tier is not `restricted`).
   * `0` means new investments are blocked.
   */
  effectiveCapBps: number | null;
}

/**
 * Resolve the effective concentration cap for an investor on an offering.
 *
 * @param offeringCapBps  Offering `max_investor_share_bps` (null = none).
 * @param tier            Investor KYC risk tier.
 */
export function resolveEffectiveCap(offeringCapBps: number | null | undefined, tier: KycRiskTier): CapResolution {
  const multiplier = TIER_CAP_MULTIPLIERS[tier];
  const base = offeringCapBps == null ? null : offeringCapBps;

  if (tier === 'restricted') {
    return {
      tier,
      multiplier,
      offeringCapBps: base,
      effectiveCapBps: 0,
    };
  }

  if (base == null) {
    return {
      tier,
      multiplier,
      offeringCapBps: null,
      effectiveCapBps: null,
    };
  }

  const scaled = Math.floor(base * multiplier);
  const effectiveCapBps = Math.min(10_000, Math.max(0, scaled));

  return {
    tier,
    multiplier,
    offeringCapBps: base,
    effectiveCapBps,
  };
}

/**
 * Convert an effective bps cap into an absolute amount against the offering size.
 * Returns `null` when unlimited; `0` when blocked.
 */
export function effectiveCapAmount(
  resolution: CapResolution,
  totalOfferingAmount: number,
): number | null {
  if (resolution.effectiveCapBps == null) return null;
  if (!Number.isFinite(totalOfferingAmount) || totalOfferingAmount < 0) {
    throw new Error('totalOfferingAmount must be a non-negative finite number');
  }
  return (resolution.effectiveCapBps / 10_000) * totalOfferingAmount;
}

export interface CapCheckInput {
  existingTotal: number;
  newAmount: number;
  totalOfferingAmount: number;
  resolution: CapResolution;
}

export type CapCheckResult =
  | { allowed: true; resolution: CapResolution; capAmount: number | null }
  | {
      allowed: false;
      resolution: CapResolution;
      capAmount: number;
      existingTotal: number;
      newAmount: number;
      reason: string;
    };

/**
 * Pure check used by the investment service on each new intent.
 * Does not mutate or inspect persisted investments beyond the totals supplied.
 */
export function evaluateInvestmentAgainstCap(input: CapCheckInput): CapCheckResult {
  const { existingTotal, newAmount, totalOfferingAmount, resolution } = input;
  const capAmount = effectiveCapAmount(resolution, totalOfferingAmount);

  if (capAmount == null) {
    return { allowed: true, resolution, capAmount: null };
  }

  if (existingTotal + newAmount > capAmount) {
    return {
      allowed: false,
      resolution,
      capAmount,
      existingTotal,
      newAmount,
      reason:
        `Investment would exceed the KYC risk-tier adjusted cap of ${resolution.effectiveCapBps} bps` +
        ` (${capAmount} units) for tier "${resolution.tier}".` +
        ` Investor has already committed ${existingTotal} units.`,
    };
  }

  return { allowed: true, resolution, capAmount };
}

/** Audit action emitted whenever an investor's tier (and thus cap) changes. */
export const INVESTOR_CAP_RECALCULATED_ACTION = 'investor.cap.recalculated';
