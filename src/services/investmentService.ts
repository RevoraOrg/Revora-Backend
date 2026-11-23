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
import { Decimal } from '../lib/decimal';
import { globalLogger } from '../lib/logger';
import { globalMetrics } from '../lib/metrics';

/** Relative path to the OFAC dual-control review queue for compliance staff. */
const OFAC_REVIEWS_ROUTE = '/api/v1/aml/ofac-reviews';
import {
  DEFAULT_KYC_RISK_TIER,
  evaluateInvestmentAgainstCap,
  parseKycRiskTier,
  resolveEffectiveCap,
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
    private screeningService?: SanctionsScreeningService,
    private auditLogRepo?: AuditLogRepository,
  ) {}

  /**
   * Create a new investment
   * @param input Investment data
   * @returns Created investment
   * @throws Error if offering not found, invalid, sanctions-blocked or KYC-tier cap exceeded
   */
  async createInvestment(input: CreateInvestmentRequest): Promise<Investment> {
    // Reject coercion-abuse inputs before database access or persistence.
    if (typeof input.amount !== 'string' || !isPositiveDecimalAmount(input.amount)) {
      throw Errors.validationError('Invalid amount: must be a positive decimal string');
    }
    const amount = new Decimal(input.amount);

    if (!input.asset || input.asset.trim() === '') {
      throw Errors.validationError('Asset is required');
    }

    // Without a pool (lightweight / legacy wiring) run the same checks without
    // the serialising transaction.
    if (!this.db) {
      const investment = await this.validateAndPersist(input, amount);
      await this.runAmlMonitoring(investment);
      return investment;
    }

    // Run the cap check + insert in a single transaction guarded by an advisory
    // lock so concurrent submissions cannot jointly exceed the cap.
    const client = await this.db.connect();
    let investment: Investment;
    try {
      await client.query('BEGIN');
      await this.investmentRepo.acquireInvestorOfferingLock(client, input.investor_id, input.offering_id);
      investment = await this.validateAndPersist(input, amount, client);
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors
      }
      throw error;
    } finally {
      client.release();
    }

    // Run AML transaction monitoring outside the transaction.
    await this.runAmlMonitoring(investment);
    return investment;
  }

  /**
   * Validate the offering, enforce the KYC-tier cap, run sanctions screening and
   * persist the investment (using `client` when inside a transaction).
   */
  private async validateAndPersist(
    input: CreateInvestmentRequest,
    amount: Decimal,
    client?: PoolClient,
  ): Promise<Investment> {
    // 1. Validate offering exists and is active
    const offering = await this.offeringRepo.findById(input.offering_id, client);
    if (!offering) {
      throw Errors.notFound(`Offering ${input.offering_id} not found`);
    }

    const activeStatuses = ['active', 'open'];
    if (!offering.status || !activeStatuses.includes(offering.status)) {
      throw Errors.validationError(`Offering is not active. Current status: ${offering.status}`);
    }

    // 2. KYC risk-tier dynamic cap
    const tier = await this.resolveInvestorTier(input.investor_id, client);
    const offeringCapBps = this.parseOfferingCapBps(offering);
    const resolution = resolveEffectiveCap(offeringCapBps, tier);

    if (resolution.effectiveCapBps != null) {
      const totalOfferingAmount = this.parseTotalOfferingAmount(offering);
      const existingTotalStr = await this.investmentRepo.sumInvestorCommitment(
        input.investor_id,
        input.offering_id,
        client,
      );
      const existingTotal = new Decimal(existingTotalStr);

      const check = evaluateInvestmentAgainstCap({
        existingTotal,
        newAmount: amount,
        totalOfferingAmount,
        resolution,
      });

      if (!check.allowed) {
        throw new AppError(ErrorCode.FORBIDDEN, 403, check.reason, {
          kyc_risk_tier: resolution.tier,
          effective_cap_bps: resolution.effectiveCapBps,
          offering_cap_bps: resolution.offeringCapBps,
          existing_total: check.existingTotal.toString(),
          attempted_amount: check.newAmount.toString(),
          cap_amount: check.capAmount.toString(),
        });
      }
    }

    // 3. OFAC / EU / UK sanctions screening (blocking, fail-closed) before persistence
    const screening = await this.screenInvestment(input);
    if (screening && !screening.complete) {
      // Missing legal name (or unavailable list) means screening cannot complete.
      // Fail closed: never screen an identifier in place of a name.
      await this.recordScreenBlocked(input, screening, false);
      throw Errors.serviceUnavailable(
        'Investment blocked: sanctions screening could not complete (missing investor name or list unavailable; fail-closed).',
        this.screeningDetails(screening),
      );
    }
    if (screening && !screening.cleared) {
      // Failure to obtain a verified list, or a confirmed hit -> reject.
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

    // 4. Create investment record
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

    return this.investmentRepo.create(investmentInput, client);
  }

  /**
   * Fire-and-forget AML evaluation: a rules-engine hiccup never fails the
   * investor's submission. Failures are surfaced via structured logging and the
   * aml_evaluation_failures_total counter.
   */
  private async runAmlMonitoring(investment: Investment): Promise<void> {
    const amlService = this.amlService;
    if (!amlService) return;

    const recordFailure = (error: unknown): void => {
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
    };

    // Resolve the investor's display name so name-based rules (sanctions_screening,
    // geo_mismatch) receive a real name rather than a UUID.
    let investorName = investment.investor_id;
    try {
      investorName = await this.resolveInvestorName(investment.investor_id);
    } catch {
      // Fall back to the investor id; monitoring must never block the submission.
    }

    const context: TransactionContext = {
      investment_id: investment.id,
      investor_id: investment.investor_id,
      offering_id: investment.offering_id,
      amount: investment.amount,
      asset: investment.asset,
      timestamp: investment.created_at,
      investor_name: investorName,
    };

    try {
      amlService.evaluateTransaction(context).catch(recordFailure);
    } catch (error) {
      recordFailure(error);
    }
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
    const beneficialOwners = (input.beneficial_owners ?? [])
      .filter((n) => typeof n === 'string' && n.trim().length > 0);

    // A missing legal name means the primary identity cannot be screened.
    // Fail closed rather than screening an identifier (e.g. the UUID).
    if (!name) {
      return {
        complete: false,
        cleared: false,
        matches: [],
        versions: {},
      };
    }

    const identityNames = [name, ...beneficialOwners];

    return this.screeningService.screen(identityNames);
  }

  /**
   * Resolve the investor's display name via the user repository (if available).
   * Returns null when no legal name is on file — callers must fail closed.
   */
  private async resolveInvestorName(investorId: string): Promise<string | null> {
    if (this.userRepo) {
      const user = await this.userRepo.findById(investorId);
      if (user?.name && user.name.trim().length > 0) return user.name;
    }
    return null;
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
    screeningService,
    auditLogRepo,
  );
}