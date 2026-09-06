import { Pool } from 'pg';
import { InvestmentRepository, CreateInvestmentInput, Investment } from '../db/repositories/investmentRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { UserRepository } from '../db/repositories/userRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { Errors, AppError, ErrorCode } from '../lib/errors';
import { AMLService } from '../aml/amlService';
import { TransactionContext } from '../aml/types';
import { SanctionsScreeningService, SanctionsScreenResult } from './sanctionsScreeningService';
import { sanitizeReviewLink } from '../lib/reviewLink';
import { kycNotApprovedError } from './kyc/KycProviderAdapter';

/** Relative path to the OFAC dual-control review queue for compliance staff. */
const OFAC_REVIEWS_ROUTE = '/api/v1/aml/ofac-reviews';
import {
  DEFAULT_KYC_RISK_TIER,
  evaluateInvestmentAgainstCap,
  parseKycRiskTier,
  resolveEffectiveCap,
} from '../lib/kycRiskTierCaps';

/**
 * Input for creating an investment
 */
export interface CreateInvestmentRequest {
  investor_id: string;
  offering_id: string;
  amount: string;
  asset: string;
  /** Optional beneficial-owner names (e.g. UBOs) to screen alongside the investor. */
  beneficial_owners?: string[];
}

/**
 * Investment Service
 * Handles business logic for investments, including KYC risk-tier cap gating.
 */
export class InvestmentService {
  constructor(
    private investmentRepo: InvestmentRepository,
    private offeringRepo: OfferingRepository,
    private amlService?: AMLService,
    private userRepo?: UserRepository,
    private screeningService?: SanctionsScreeningService,
    private auditLogRepo?: AuditLogRepository,
    /**
     * Feature-flagged KYC/AML approval gate. When `true`, investment
     * submissions are blocked until the investor's `kyc_status` is
     * `approved`. Defaults to `false` to preserve existing behaviour.
     */
    private readonly kycGateEnabled: boolean = false,
  ) {}

  /**
   * Create a new investment
   * @param input Investment data
   * @returns Created investment
   * @throws Error if offering not found, invalid, or KYC-tier cap exceeded
   */
  async createInvestment(input: CreateInvestmentRequest): Promise<Investment> {
    // 1. Validate offering exists
    const offering = await this.offeringRepo.findById(input.offering_id);
    if (!offering) {
      throw Errors.notFound(`Offering ${input.offering_id} not found`);
    }

    // 2. Validate offering is active
    const activeStatuses = ['active', 'open'];
    if (!offering.status || !activeStatuses.includes(offering.status)) {
      throw Errors.validationError(`Offering is not active. Current status: ${offering.status}`);
    }

    // 2b. KYC/AML approval gate (feature-flagged; fail-closed).
    // Blocked before any persistence or screening side effects so an
    // unverified investor can never enter the investment pipeline.
    if (this.kycGateEnabled) {
      const user = this.userRepo
        ? await this.userRepo.findById(input.investor_id)
        : null;
      const approved = user?.kyc_status === 'approved';
      if (!approved) {
        await this.recordKycGateBlocked(input, user?.kyc_status);
        throw kycNotApprovedError();
      }
    }

    // 3. Validate amount
    const amountNum = parseFloat(input.amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      throw Errors.validationError('Invalid amount: must be a positive number');
    }

    // 4. Validate asset
    if (!input.asset || input.asset.trim() === '') {
      throw Errors.validationError('Asset is required');
    }

    // 5. KYC risk-tier dynamic cap (new intents only — never touches existing rows)
    await this.assertKycTierCap({
      investorId: input.investor_id,
      offeringId: input.offering_id,
      newAmount: amountNum,
      offeringCapBps:
        typeof offering.max_investor_share_bps === 'number'
          ? offering.max_investor_share_bps
          : offering.max_investor_share_bps == null
            ? null
            : Number(offering.max_investor_share_bps),
      totalOfferingAmount: parseFloat(
        String(offering.target_amount ?? offering.total_raised ?? '0'),
      ),
    });

    // 6. OFAC / EU / UK sanctions screening (blocking, fail-closed) before persistence
    const screening = await this.screenInvestment(input);
    if (screening && !screening.cleared) {
      // Failure to obtain a verified list, or a confirmed hit → reject.
      const blocked = screening.matches.length > 0;
      await this.recordScreenBlocked(input, screening, blocked);
      if (blocked) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          403,
          'Investment blocked: investor or beneficial owner matched a sanctions list entry.',
          this.screeningDetails(screening),
        );
      }
      throw Errors.serviceUnavailable(
        'Investment blocked: sanctions list unavailable; screening could not complete (fail-closed).',
        this.screeningDetails(screening),
      );
    }

    // 7. Create investment record
    const investmentInput: CreateInvestmentInput = {
      investor_id: input.investor_id,
      offering_id: input.offering_id,
      amount: input.amount,
      asset: input.asset,
      status: 'pending', // Default status until Stellar transaction is submitted
    };

    if (screening) {
      investmentInput.screening_status = 'passed';
      investmentInput.screening_list_version =
        screening.versions['ofac'] ?? null;
      investmentInput.screening_result = {
        complete: screening.complete,
        cleared: true,
        matches: [],
        versions: screening.versions,
        screened_at: new Date().toISOString(),
      };
    }

    const investment = await this.investmentRepo.create(investmentInput);

    // 7. Run AML transaction monitoring if service is available
    if (this.amlService) {
      try {
        const context: TransactionContext = {
          investment_id: investment.id,
          investor_id: investment.investor_id,
          offering_id: investment.offering_id,
          amount: investment.amount,
          asset: investment.asset,
          timestamp: investment.created_at,
        };

        // Run AML evaluation asynchronously (non-blocking)
        this.amlService.evaluateTransaction(context).catch(error => {
          // Log error but don't fail the investment creation
          console.error('AML evaluation failed:', error);
        });
      } catch (error) {
        // Log error but don't fail the investment creation
        console.error('AML evaluation setup failed:', error);
      }
    }

    return investment;
  }

  /**
   * Run sanctions screening for the investor and any known beneficial owners.
   * Returns null when no screening service is configured (opt-in).
   */
  private async screenInvestment(
    input: CreateInvestmentRequest,
  ): Promise<SanctionsScreenResult | null> {
    if (!this.screeningService) return null;

    const name = await this.resolveInvestorName(input.investor_id);
    const identityNames = [name, ...(input.beneficial_owners ?? [])]
      .filter((n) => typeof n === 'string' && n.trim().length > 0);

    return this.screeningService.screen(identityNames);
  }

  /** Resolve the investor's display name via the user repository (if available). */
  private async resolveInvestorName(investorId: string): Promise<string> {
    if (this.userRepo) {
      const user = await this.userRepo.findById(investorId);
      if (user?.name) return user.name;
    }
    return investorId;
  }

  /**
   * Persist an audit-log entry describing a blocked (or fail-closed) submission
   * with the reason and a reviewer queue link for the OFAC dual-control queue.
   */
  private async recordScreenBlocked(
    input: CreateInvestmentRequest,
    screening: SanctionsScreenResult,
    blocked: boolean,
  ): Promise<void> {
    if (!this.auditLogRepo) return;
    const reason = blocked
      ? 'sanctions_hit'
      : 'sanctions_list_unavailable';
    const reviewerLink = sanitizeReviewLink(OFAC_REVIEWS_ROUTE);
    const details: Record<string, unknown> = {
      investor_id: input.investor_id,
      offering_id: input.offering_id,
      amount: input.amount,
      asset: input.asset,
      screening_status: blocked ? 'blocked' : 'error',
      versions: screening.versions,
      matches: screening.matches,
      reviewer_queue_link: reviewerLink,
      blocked,
    };
    await this.auditLogRepo.createAuditLog({
      user_id: input.investor_id,
      action: 'investment_sanctions_screening_blocked',
      resource: `investment_offering/${input.offering_id}`,
      details: JSON.stringify(details),
      ip_address: null,
      user_agent: 'investment-service',
    });
  }

  private screeningDetails(screening: SanctionsScreenResult): Record<string, unknown> {
    return {
      cleared: screening.cleared,
      matches: screening.matches,
      versions: screening.versions,
    };
  }

  /**
   * Persist an audit-log entry when the KYC/AML approval gate blocks a
   * submission. Fail-open would silently admit unverified investors, so the
   * block reason is recorded for compliance review.
   */
  private async recordKycGateBlocked(
    input: CreateInvestmentRequest,
    investorKycStatus: string | undefined,
  ): Promise<void> {
    if (!this.auditLogRepo) return;
    await this.auditLogRepo.createAuditLog({
      user_id: input.investor_id,
      action: 'investment_kyc_gate_blocked',
      resource: `investment_offering/${input.offering_id}`,
      details: JSON.stringify({
        investor_id: input.investor_id,
        offering_id: input.offering_id,
        amount: input.amount,
        asset: input.asset,
        investor_kyc_status: investorKycStatus ?? 'unknown',
        required_status: 'approved',
      }),
      ip_address: null,
      user_agent: 'investment-service',
    });
  }

  /**
   * Resolve the investor's KYC tier and reject the intent when it would exceed
   * the tier-adjusted concentration cap. Existing commitments are never modified.
   */
  private async assertKycTierCap(args: {
    investorId: string;
    offeringId: string;
    newAmount: number;
    offeringCapBps: number | null;
    totalOfferingAmount: number;
  }): Promise<void> {
    let tier = DEFAULT_KYC_RISK_TIER;
    if (this.userRepo) {
      const user = await this.userRepo.findById(args.investorId);
      if (user) {
        tier = parseKycRiskTier(user.kyc_risk_tier);
      }
    }

    const offeringCapBps =
      args.offeringCapBps != null && Number.isFinite(args.offeringCapBps)
        ? args.offeringCapBps
        : null;

    const resolution = resolveEffectiveCap(offeringCapBps, tier);

    // Unlimited after tier resolution — nothing to enforce.
    if (resolution.effectiveCapBps == null) {
      return;
    }

    const totalOfferingAmount = Number.isFinite(args.totalOfferingAmount)
      ? Math.max(0, args.totalOfferingAmount)
      : 0;

    const existingTotal = parseFloat(
      await this.investmentRepo.sumInvestorCommitment(args.investorId, args.offeringId),
    );

    const check = evaluateInvestmentAgainstCap({
      existingTotal: Number.isFinite(existingTotal) ? existingTotal : 0,
      newAmount: args.newAmount,
      totalOfferingAmount,
      resolution,
    });

    if (!check.allowed) {
      throw new AppError(ErrorCode.FORBIDDEN, 403, check.reason, {
        kyc_risk_tier: resolution.tier,
        effective_cap_bps: resolution.effectiveCapBps,
        offering_cap_bps: resolution.offeringCapBps,
        existing_total: check.existingTotal,
        attempted_amount: check.newAmount,
        cap_amount: check.capAmount,
      });
    }
  }
}

/**
 * Factory function to create InvestmentService with dependencies
 */
export function createInvestmentService(
  db: Pool,
  amlService?: AMLService,
  screeningService?: SanctionsScreeningService,
  auditLogRepo?: AuditLogRepository,
  kycGateEnabled: boolean = false,
): InvestmentService {
  return new InvestmentService(
    new InvestmentRepository(db),
    new OfferingRepository(db),
    amlService,
    new UserRepository(db),
    screeningService,
    auditLogRepo,
    kycGateEnabled,
  );
}
