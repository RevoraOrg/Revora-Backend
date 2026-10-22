import { Pool, PoolClient } from 'pg';
import { InvestmentRepository, CreateInvestmentInput, Investment } from '../db/repositories/investmentRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { UserRepository } from '../db/repositories/userRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { Errors, AppError, ErrorCode } from '../lib/errors';
import { AMLService } from '../aml/amlService';
import { TransactionContext } from '../aml/types';
import { Decimal } from '../lib/decimal';
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
    const db = this.db;
    if (!db) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 500, 'Database pool not available for transaction');
    }

    // Validate input before starting transaction
    const amount = new Decimal(input.amount);
    if (!amount.isPositive()) {
      throw Errors.validationError('Invalid amount: must be a positive number');
    }

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

        const check = evaluateInvestmentAgainstCap({
          existingTotal,
          newAmount: amount,
          totalOfferingAmount,
          resolution,
        });

        if (!check.allowed) {
          await client.query('ROLLBACK');
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

      // 5. Create investment record (inside same transaction)
      const investmentInput: CreateInvestmentInput = {
        investor_id: input.investor_id,
        offering_id: input.offering_id,
        amount: input.amount,
        asset: input.asset,
        status: 'pending',
      };

      const investment = await this.investmentRepo.create(investmentInput, client);

      await client.query('COMMIT');

      // 6. Run AML transaction monitoring if service is available (outside transaction)
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
            console.error('AML evaluation failed:', error);
          });
        } catch (error) {
          console.error('AML evaluation setup failed:', error);
        }
      }

      return investment;
    } catch (error) {
      // Ensure rollback on any error
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback errors
      }
      throw error;
    } finally {
      client.release();
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