/**
 * KYC risk-tier service — updates investor tiers and emits cap-recalculation audits.
 *
 * Cap changes never invalidate existing investments; they only affect subsequent
 * `createInvestment` intents via {@link resolveEffectiveCap}.
 */

import { UserRepository, User } from '../db/repositories/userRepository';
import { SecurityAuditRepository, AuditEvent } from '../security/types';
import { Errors } from '../lib/errors';
import {
  CapResolution,
  INVESTOR_CAP_RECALCULATED_ACTION,
  KycRiskTier,
  isKycRiskTier,
  resolveEffectiveCap,
} from '../lib/kycRiskTierCaps';

export interface UpdateKycRiskTierInput {
  investorId: string;
  tier: KycRiskTier;
  /** Actor performing the change (admin user id). */
  actorId: string;
  /**
   * Optional offering baseline used only for audit context (illustrative
   * effective cap after the change). Does not mutate offerings.
   */
  referenceOfferingCapBps?: number | null;
}

export interface UpdateKycRiskTierResult {
  user: User;
  previousTier: KycRiskTier;
  resolution: CapResolution;
}

export class KycRiskTierService {
  constructor(
    private userRepo: UserRepository,
    private auditRepo: SecurityAuditRepository,
  ) {}

  /**
   * Persist a new KYC risk tier and emit `investor.cap.recalculated`.
   */
  async updateKycRiskTier(input: UpdateKycRiskTierInput): Promise<UpdateKycRiskTierResult> {
    if (!isKycRiskTier(input.tier)) {
      throw Errors.validationError(`Invalid kyc_risk_tier: ${String(input.tier)}`);
    }

    const existing = await this.userRepo.findById(input.investorId);
    if (!existing) {
      throw Errors.notFound(`Investor ${input.investorId} not found`);
    }
    if (existing.role !== 'investor') {
      throw Errors.validationError('KYC risk tier can only be set on investor accounts');
    }

    const previousTier = existing.kyc_risk_tier;
    const user =
      previousTier === input.tier
        ? existing
        : await this.userRepo.updateKycRiskTier(input.investorId, input.tier);

    const resolution = resolveEffectiveCap(
      input.referenceOfferingCapBps ?? null,
      user.kyc_risk_tier,
    );

    await this.emitCapRecalculated({
      investorId: user.id,
      actorId: input.actorId,
      previousTier,
      resolution,
      changed: previousTier !== input.tier,
    });

    return { user, previousTier, resolution };
  }

  private async emitCapRecalculated(args: {
    investorId: string;
    actorId: string;
    previousTier: KycRiskTier;
    resolution: CapResolution;
    changed: boolean;
  }): Promise<void> {
    const event: AuditEvent = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      type: 'AUTHORIZATION',
      userId: args.actorId,
      action: INVESTOR_CAP_RECALCULATED_ACTION,
      resource: `investor/${args.investorId}`,
      outcome: 'SUCCESS',
      details: {
        investor_id: args.investorId,
        previous_tier: args.previousTier,
        new_tier: args.resolution.tier,
        multiplier: args.resolution.multiplier,
        offering_cap_bps: args.resolution.offeringCapBps,
        effective_cap_bps: args.resolution.effectiveCapBps,
        changed: args.changed,
        // Explicit: existing investments are untouched.
        retroactive_invalidation: false,
      },
      securityContext: {
        requestId: `req_${Date.now()}`,
        ipAddress: 'system',
        userAgent: 'kyc-risk-tier-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    };

    await this.auditRepo.record(event);
  }
}

export function createKycRiskTierService(
  userRepo: UserRepository,
  auditRepo: SecurityAuditRepository,
): KycRiskTierService {
  return new KycRiskTierService(userRepo, auditRepo);
}
