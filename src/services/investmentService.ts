import { Pool } from 'pg';
import { InvestmentRepository, CreateInvestmentInput, Investment } from '../db/repositories/investmentRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { UserRepository } from '../db/repositories/userRepository';
import { Errors, AppError, ErrorCode } from '../lib/errors';
import { AMLService } from '../aml/amlService';
import { TransactionContext } from '../aml/types';
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

    // 6. Create investment record
    const investmentInput: CreateInvestmentInput = {
      investor_id: input.investor_id,
      offering_id: input.offering_id,
      amount: input.amount,
      asset: input.asset,
      status: 'pending', // Default status until Stellar transaction is submitted
    };

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
export function createInvestmentService(db: Pool, amlService?: AMLService): InvestmentService {
  return new InvestmentService(
    new InvestmentRepository(db),
    new OfferingRepository(db),
    amlService,
    new UserRepository(db),
  );
}
