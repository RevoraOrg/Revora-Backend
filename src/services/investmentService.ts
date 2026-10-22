import { Pool, PoolClient } from 'pg';
import { InvestmentRepository, CreateInvestmentInput, Investment } from '../db/repositories/investmentRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { UserRepository } from '../db/repositories/userRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { Errors, AppError, ErrorCode } from '../lib/errors';
import { AMLService } from '../aml/amlService';
import { TransactionContext } from '../aml/types';
import { SanctionsScreeningService, SanctionsScreenResult } from './sanctionsScreeningService';
import { sanitizeReviewLink } from '../lib/reviewLink';
import { isPositiveDecimalAmount } from '../lib/amountValidation';

/** Relative path to the OFAC dual-control review queue for compliance staff. */
const OFAC_REVIEWS_ROUTE = '/api/v1/aml/ofac-reviews';
import {
  DEFAULT_KYC_RISK_TIER,
  evaluateInvestmentAgainstCap,
  parseKycRiskTier,
  resolveEffectiveCap,
  CapResolution,
  KycRiskTier,
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
    private db?: Pool,
  ) {}

  /**
   * Create a new investment
   * @param input Investment data
   * @returns Created investment
   * @throws Error if offering not found, invalid, or KYC-tier cap exceeded
   */
  async createInvestment(input: CreateInvestmentRequest): Promise<Investment> {
    // Reject coercion-abuse inputs before database access or persistence.
    if (!isPositiveDecimalAmount(input.amount)) {
      throw Errors.validationError('Invalid amount: must be a positive decimal string');
    }

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

    if (!input.asset || input.asset.trim() === '') {
      throw Errors.validationError('Asset is required');
    }

    // Run the entire operation in a single transaction with advisory lock
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // 1. Acquire advisory lock for this investor+offering pair to serialize concurrent cap checks
      // This must be done early to prevent race conditions on the cap check
      await this.investmentRepo.acquireInvestorOfferingLock(client, input.investor_id, input.offering_id);

      // 2. Validate offering exists and is active (inside transaction for consistency)
      const offering = await this.offeringRepo.findById(input.offering_id, client);
      if (!offering) {
        await client.query('ROLLBACK');
        throw Errors.notFound(`Offering ${input.offering_id} not found`);
      }

      const activeStatuses = ['active', 'open'];
      if (!offering.status || !activeStatuses.includes(offering.status)) {
        await client.query('ROLLBACK');
        throw Errors.validationError(`Offering is not active. Current status: ${offering.status}`);
      }

      // 3. Resolve KYC tier and effective cap
      const tier = await this.resolveInvestorTier(input.investor_id, client);
      const offeringCapBps = this.parseOfferingCapBps(offering);
      const resolution = resolveEffectiveCap(offeringCapBps, tier);

      // 4. If unlimited after tier resolution, skip cap check
      if (resolution.effectiveCapBps != null) {
        const totalOfferingAmount = this.parseTotalOfferingAmount(offering);
        const existingTotalStr = await this.investmentRepo.sumInvestorCommitment(
          input.investor_id,
          input.offering_id,
          client,
        );
        const existingTotal = new Decimal(existingTotalStr);

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
      // Resolve the investor's display name so name-based rules (sanctions_screening,
      // geo_mismatch) receive a real name rather than a UUID.
      const investorName = await this.resolveInvestorName(investment.investor_id);

      const context: TransactionContext = {
        investment_id: investment.id,
        investor_id: investment.investor_id,
        offering_id: investment.offering_id,
        amount: investment.amount,
        asset: investment.asset,
        timestamp: investment.created_at,
        investor_name: investorName,
      };

      // Fire-and-forget: AML evaluation is non-blocking so that a rules-engine
      // hiccup never fails the investor's submission. All failures are surfaced
      // via structured logging and the aml_evaluation_failures_total counter so
      // they are visible in dashboards and alerts without silently swallowing them.
      this.amlService.evaluateTransaction(context).catch((error: unknown) => {
        globalLogger.error('AML evaluation failed', {
          investment_id: investment.id,
          investor_id: investment.investor_id,
          error: error instanceof Error ? error.message : String(error),
        });
        globalMetrics.incrementCounter(
          'aml_evaluation_failures_total',
          { reason: 'evaluation_error' },
          1,
          'Total number of AML evaluation failures on investment creation',
        );
      });
    }
  }

  /**
   * Resolve the investor's KYC tier
   */
  private async resolveInvestorTier(investorId: string, client?: PoolClient): Promise<KycRiskTier> {
    let tier: KycRiskTier = DEFAULT_KYC_RISK_TIER;
    if (this.userRepo) {
      const user = await this.userRepo.findById(investorId, client);
      if (user) {
        tier = parseKycRiskTier(user.kyc_risk_tier);
      }
    }
    return tier;
  }

  /**
   * Parse offering cap basis points
   */
  private parseOfferingCapBps(offering: { max_investor_share_bps?: number | string | null }): number | null {
    const cap = offering.max_investor_share_bps;
    if (cap == null) return null;
    const num = typeof cap === 'number' ? cap : Number(cap);
    return Number.isFinite(num) ? num : null;
  }

  /**
   * Parse total offering amount as Decimal
   */
  private parseTotalOfferingAmount(offering: { target_amount?: string | number; total_raised?: string | number }): Decimal {
    const raw = offering.target_amount ?? offering.total_raised ?? '0';
    return new Decimal(String(raw));
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
): InvestmentService {
  return new InvestmentService(
    new InvestmentRepository(db),
    new OfferingRepository(db),
    amlService,
    new UserRepository(db),
    db,
  );
}