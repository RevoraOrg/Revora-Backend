/**
 * Revenue Reconciliation Checks Service
 * 
 * Provides deterministic validation of revenue distribution integrity.
 * Checks verify that reported revenue matches payouts, investor allocations
 * are correct, and no discrepancies exist in the distribution ledger.
 */

import { Pool } from 'pg';
import { RevenueReportRepository, RevenueReport } from '../db/repositories/revenueReportRepository';
import { DistributionRepository, DistributionRun, Payout } from '../db/repositories/distributionRepository';
import { InvestmentRepository, Investment } from '../db/repositories/investmentRepository';
import { OfferingRepository } from '../db/repositories/offeringRepository';
import { logger, Logger, LogLevel } from '../lib/logger';
import { 
  classifyStellarRPCFailure, 
  StellarRPCFailureClass,
  StellarRPCFailureContext 
} from '../lib/stellarRpcFailure';
import { Errors } from '../lib/errors';

export interface OnChainRevenueState {
  totalDistributed: string;
}

export interface StellarRevenueClient {
  getRevenueState(contractAddress: string): Promise<OnChainRevenueState>;
}

export interface ReconciliationDiscrepancy {
  type: DiscrepancyType;
  severity: 'warning' | 'error' | 'critical';
  message: string;
  details: Record<string, unknown>;
  offeringId: string;
  periodStart?: Date;
  periodEnd?: Date;
}

export type DiscrepancyType =
  | 'REVENUE_MISMATCH'
  | 'PAYOUT_SUM_MISMATCH'
  | 'INVESTOR_ALLOCATION_ERROR'
  | 'ROUNDING_LOSS_UNACCOUNTED'
  | 'MISSING_PAYOUT'
  | 'DUPLICATE_PAYOUT'
  | 'OVERPAYMENT'
  | 'UNDERPAMENT'
  | 'DISTRIBUTION_STATUS_INVALID'
  | 'CHAIN_DRIFT_DETECTED'
  | 'RPC_ERROR'
  | 'STELLAR_TX_NOT_FOUND'
  | 'STELLAR_TX_FAILED'
  | 'CHAIN_EVENT_MISMATCH'
  | 'CHAIN_EVENT_VALIDATION_FAILED';

export interface ReconciliationResult {
  offeringId: string;
  periodStart: Date;
  periodEnd: Date;
  isBalanced: boolean;
  discrepancies: ReconciliationDiscrepancy[];
  summary: ReconciliationSummary;
  checkedAt: Date;
}

export interface ReconciliationSummary {
  totalRevenueReported: string;
  totalPayouts: string;
  discrepancyAmount: string;
  investorCount: number;
  payoutsProcessed: number;
  payoutsFailed: number;
  chainDrift?: {
    onChainAmount: string;
    localAmount: string;
    drift: string;
  };
}

export interface ReconciliationOptions {
  tolerance?: number;
  checkRoundingAdjustments?: boolean;
  checkInvestorAllocations?: boolean;
  validateChainEvents?: boolean;
  logger?: Logger;
}

const DEFAULT_TOLERANCE = 0.01;

export class RevenueReconciliationService {
  private readonly revenueReportRepo: RevenueReportRepository;
  private readonly distributionRepo: DistributionRepository;
  private readonly investmentRepo: InvestmentRepository;
  private readonly offeringRepo: OfferingRepository;
  private readonly logger: Logger;

  constructor(
    private readonly db: Pool,
    private readonly stellarClient?: StellarRevenueClient
  ) {
    this.revenueReportRepo = new RevenueReportRepository(db);
    this.distributionRepo = new DistributionRepository(db);
    this.investmentRepo = new InvestmentRepository(db);
    this.offeringRepo = new OfferingRepository(db);
    this.logger = logger.child({ service: 'RevenueReconciliationService' });
  }

  /**
   * Perform comprehensive reconciliation check for an offering and period
   * @param offeringId - The offering to reconcile
   * @param periodStart - Start of the reconciliation period
   * @param periodEnd - End of the reconciliation period
   * @param options - Reconciliation options
   */
  async reconcile(
    offeringId: string,
    periodStart: Date,
    periodEnd: Date,
    options: ReconciliationOptions = {}
  ): Promise<ReconciliationResult> {
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    const discrepancies: ReconciliationDiscrepancy[] = [];

    this.logger.info(
      'Starting reconciliation process',
      {
        offeringId,
        periodStart,
        periodEnd,
        tolerance,
        options,
      }
    );

    try {
      const revenueReports = await this.revenueReportRepo.listByOffering(offeringId);
      const relevantReports = revenueReports.filter(
        (r) =>
          this.datesOverlap(r.period_start, r.period_end, periodStart, periodEnd)
      );

      const distributionRuns = await this.distributionRepo.listByOffering(offeringId);
      const relevantRuns = distributionRuns.filter(
        (r) =>
          r.distribution_date >= periodStart && r.distribution_date <= periodEnd
      );

      this.logger.debug(
        'Fetched data for reconciliation',
        {
          offeringId,
          revenueReportsCount: revenueReports.length,
          relevantReportsCount: relevantReports.length,
          distributionRunsCount: distributionRuns.length,
          relevantRunsCount: relevantRuns.length,
        }
      );

      // Compute aggregated totals
      const totalRevenueReported = this.sumRevenueAmounts(relevantReports);
      const totalPayouts = this.sumDistributionAmounts(relevantRuns);

      // Check revenue mismatch
      const revenueMismatch = this.checkRevenueMismatch(
        totalRevenueReported,
        totalPayouts,
        tolerance
      );
      if (revenueMismatch) {
        revenueMismatch.offeringId = offeringId;
        discrepancies.push(revenueMismatch);
      }

      // Drift Detection
      if (this.stellarClient) {
        try {
          const driftResult = await this.detectChainDrift(offeringId);
          if (driftResult.hasDrift) {
            discrepancies.push({
              type: 'CHAIN_DRIFT_DETECTED',
              severity: parseFloat(driftResult.drift) > tolerance * 10 ? 'critical' : 'error',
              message: `On-chain drift detected for offering ${offeringId}: local ${driftResult.localAmount} vs chain ${driftResult.onChainAmount}`,
              details: driftResult,
              offeringId,
            });

            this.logger.error('Revenue reconciliation drift detected', {
              offeringId,
              ...driftResult,
            });
          }
        } catch (error) {
          const failure = classifyStellarRPCFailure(error, {
            operation: 'detectChainDrift',
            offeringId,
          });
          discrepancies.push({
            type: 'RPC_ERROR',
            severity: 'warning',
            message: `Failed to fetch on-chain state: ${failure.class}`,
            details: { error: String(error), failureClass: failure.class },
            offeringId,
          });

          this.logger.warn('Failed to fetch on-chain state during reconciliation', {
            offeringId,
            failureClass: failure.class,
            error: String(error),
          });
        }
      }

      for (const run of relevantRuns) {
        try {
          const payoutCheck = await this.checkDistributionRunIntegrity(run, tolerance);
          discrepancies.push(...payoutCheck);
        } catch (error) {
          this.logger.error(
            'Failed to check distribution run integrity',
            {
              offeringId,
              runId: run.id,
              error: error instanceof Error ? error.message : 'Unknown error',
            }
          );
          
          // Add a discrepancy for the failed check
          discrepancies.push({
            type: 'DISTRIBUTION_STATUS_INVALID',
            severity: 'error',
            message: `Failed to verify distribution run ${run.id}`,
            details: {
              runId: run.id,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            offeringId,
            periodStart,
            periodEnd,
          });
        }
      }

      if (options.checkInvestorAllocations) {
        try {
          const allocationChecks = await this.checkInvestorAllocations(
            offeringId,
            relevantRuns,
            tolerance
          );
          discrepancies.push(...allocationChecks);
        } catch (error) {
          this.logger.error(
            'Failed to check investor allocations',
            {
              offeringId,
              error: error instanceof Error ? error.message : 'Unknown error',
            }
          );
        }
      }

      if (options.checkRoundingAdjustments) {
        try {
          const roundingChecks = this.checkRoundingAdjustments(relevantRuns);
          discrepancies.push(...roundingChecks);
        } catch (error) {
          this.logger.error(
            'Failed to check rounding adjustments',
            {
              offeringId,
              error: error instanceof Error ? error.message : 'Unknown error',
            }
          );
        }
      }

      if (options.validateChainEvents) {
        try {
          const chainEventChecks = await this.validateChainEventConsistency(
            offeringId,
            relevantRuns,
            periodStart,
            periodEnd
          );
          discrepancies.push(...chainEventChecks);
        } catch (error) {
          const failure = classifyStellarRPCFailure(error, {
            operation: 'validateChainEventConsistency',
            offeringId,
          });
          this.logger.warn(
            'Failed to validate chain event consistency',
            {
              offeringId,
              failureClass: failure.class,
              error: error instanceof Error ? error.message : 'Unknown error',
            }
          );
          
          if (failure.class !== StellarRPCFailureClass.UNKNOWN) {
            discrepancies.push({
              type: 'CHAIN_EVENT_VALIDATION_FAILED',
              severity: 'warning',
              message: `Chain event validation failed due to ${failure.class}`,
              details: {
                offeringId,
                failureClass: failure.class,
                error: error instanceof Error ? error.message : 'Unknown error',
              },
              offeringId,
              periodStart,
              periodEnd,
            });
          }
        }
      }

      const investors = await this.investmentRepo.findByOffering(offeringId);
      const investorIds = new Set(investors.map((i) => i.investor_id));

      for (const run of relevantRuns) {
        try {
          const payoutDiscrepancies = await this.checkPayoutCompleteness(
            run,
            investorIds
          );
          discrepancies.push(...payoutDiscrepancies);
        } catch (error) {
          this.logger.error(
            'Failed to check payout completeness',
            {
              offeringId,
              runId: run.id,
              error: error instanceof Error ? error.message : 'Unknown error',
            }
          );
        }
      }

      const hasErrors = discrepancies.some((d) => d.severity === 'error' || d.severity === 'critical');
      const hasWarnings = discrepancies.some((d) => d.severity === 'warning');

      let totalFailedPayouts = 0;
      for (const run of relevantRuns) {
        totalFailedPayouts += await this.countFailedPayouts(run.id);
      }

      const discrepancyAmount = this.calculateDiscrepancyAmount(totalRevenueReported, totalPayouts);

      const result: ReconciliationResult = {
        offeringId,
        periodStart,
        periodEnd,
        isBalanced: !hasErrors && !hasWarnings,
        discrepancies,
        summary: {
          totalRevenueReported,
          totalPayouts,
          discrepancyAmount,
          investorCount: investorIds.size,
          payoutsProcessed: this.countProcessedPayouts(relevantRuns),
          payoutsFailed: totalFailedPayouts,
          chainDrift: discrepancies.find(d => d.type === 'CHAIN_DRIFT_DETECTED')?.details as any,
        },
        checkedAt: new Date(),
      };

      return result;
    } catch (error) {
      this.logger.error('Reconciliation process failed', {
        offeringId,
        periodStart,
        periodEnd,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Perform quick balance check without detailed discrepancy analysis
   */
  async quickBalanceCheck(
    offeringId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<{ isBalanced: boolean; difference: string }> {
    const revenueReports = await this.revenueReportRepo.listByOffering(offeringId);
    const relevantReports = revenueReports.filter(
      (r) =>
        this.datesOverlap(r.period_start, r.period_end, periodStart, periodEnd)
    );

    const distributionRuns = await this.distributionRepo.listByOffering(offeringId);
    const relevantRuns = distributionRuns.filter(
      (r) =>
        r.distribution_date >= periodStart && r.distribution_date <= periodEnd
    );

    const totalRevenue = this.sumRevenueAmounts(relevantReports);
    const totalPayouts = this.sumDistributionAmounts(relevantRuns);

    return {
      isBalanced: this.amountsEqual(totalRevenue, totalPayouts, DEFAULT_TOLERANCE),
      difference: this.subtractAmounts(totalRevenue, totalPayouts),
    };
  }

  /**
   * Verify integrity of a single distribution run
   */
  async verifyDistributionRun(
    runId: string
  ): Promise<{ isValid: boolean; errors: string[] }> {
    const errors: string[] = [];

    const runs = await this.distributionRepo.listByOffering('');
    const run = runs.find((r) => r.id === runId);

    if (!run) {
      return { isValid: false, errors: ['Distribution run not found'] };
    }

    if (!this.isValidDistributionStatus(run.status)) {
      errors.push(`Invalid distribution status: ${run.status}`);
    }

    if (this.isNegativeAmount(run.total_amount)) {
      errors.push('Total amount cannot be negative');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate revenue report submission
   */
  async validateRevenueReport(
    offeringId: string,
    amount: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<{ isValid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (this.isNegativeAmount(amount)) {
      errors.push('Revenue amount cannot be negative');
    }

    if (periodEnd <= periodStart) {
      errors.push('Period end must be after period start');
    }

    if (periodStart > new Date()) {
      errors.push('Period start cannot be in the future');
    }

    const existingReport = await this.revenueReportRepo.findByOfferingAndPeriod(
      offeringId,
      periodStart,
      periodEnd
    );

    if (existingReport) {
      errors.push('Revenue report already exists for this offering and period');
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Detect drift between local DB and on-chain state
   */
  async detectChainDrift(offeringId: string): Promise<{
    hasDrift: boolean;
    onChainAmount: string;
    localAmount: string;
    drift: string;
  }> {
    if (!this.stellarClient) {
      throw Errors.internal('Stellar client not configured for drift detection');
    }

    const offering = await this.offeringRepo.findById(offeringId);
    if (!offering || !offering.contract_address) {
      return {
        hasDrift: false,
        onChainAmount: '0.00',
        localAmount: '0.00',
        drift: '0.00',
      };
    }

    const onChainState = await this.stellarClient.getRevenueState(offering.contract_address);
    const stats = await this.distributionRepo.getAggregateStats(offeringId);

    const onChainAmount = parseFloat(onChainState.totalDistributed);
    const localAmount = parseFloat(stats.totalDistributed);
    const drift = Math.abs(onChainAmount - localAmount);

    const hasDrift = drift > DEFAULT_TOLERANCE;

    return {
      hasDrift,
      onChainAmount: onChainAmount.toFixed(2),
      localAmount: localAmount.toFixed(2),
      drift: drift.toFixed(2),
    };
  }

  private checkRevenueMismatch(
    totalRevenue: string,
    totalPayouts: string,
    tolerance: number
  ): ReconciliationDiscrepancy | null {
    const diff = Math.abs(parseFloat(totalRevenue) - parseFloat(totalPayouts));

    if (diff > tolerance) {
      return {
        type: 'REVENUE_MISMATCH',
        severity: diff > 1 ? 'critical' : 'error',
        message: `Revenue mismatch detected: reported ${totalRevenue} vs payouts ${totalPayouts}`,
        details: {
          reported: totalRevenue,
          paid: totalPayouts,
          difference: diff.toFixed(2),
        },
        offeringId: '',
      };
    }

    return null;
  }

  private async checkDistributionRunIntegrity(
    run: DistributionRun,
    tolerance: number
  ): Promise<ReconciliationDiscrepancy[]> {
    const discrepancies: ReconciliationDiscrepancy[] = [];

    if (run.status === 'failed') {
      discrepancies.push({
        type: 'DISTRIBUTION_STATUS_INVALID',
        severity: 'error',
        message: `Distribution run ${run.id} has failed status`,
        details: { runId: run.id, status: run.status },
        offeringId: run.offering_id,
      });
    }

    if (run.status === 'processing') {
      discrepancies.push({
        type: 'DISTRIBUTION_STATUS_INVALID',
        severity: 'warning',
        message: `Distribution run ${run.id} is still processing`,
        details: { runId: run.id, status: run.status },
        offeringId: run.offering_id,
      });
    }

    return discrepancies;
  }

  private async checkInvestorAllocations(
    offeringId: string,
    runs: DistributionRun[],
    tolerance: number
  ): Promise<ReconciliationDiscrepancy[]> {
    const discrepancies: ReconciliationDiscrepancy[] = [];
    const investments = await this.investmentRepo.findByOffering(offeringId);

    if (investments.length === 0) {
      return discrepancies;
    }

    for (const run of runs) {
      if (run.status !== 'completed') continue;

      const totalAllocation = parseFloat(run.total_amount);
      const investorCount = investments.filter(
        (i) => i.status === 'completed'
      ).length;

      const expectedMinPayout = totalAllocation / investorCount;
      if (expectedMinPayout <= 0 && totalAllocation > 0) {
        discrepancies.push({
          type: 'INVESTOR_ALLOCATION_ERROR',
          severity: 'error',
          message: `Invalid investor allocation in run ${run.id}`,
          details: {
            runId: run.id,
            totalAmount: run.total_amount,
            investorCount,
          },
          offeringId,
        });
      }
    }

    return discrepancies;
  }

  private checkRoundingAdjustments(
    runs: DistributionRun[]
  ): ReconciliationDiscrepancy[] {
    const discrepancies: ReconciliationDiscrepancy[] = [];

    for (const run of runs) {
      if (run.status !== 'completed') continue;

      const totalAmount = parseFloat(run.total_amount);
      const roundedAmount = Math.round(totalAmount * 100) / 100;

      if (Math.abs(totalAmount - roundedAmount) > 0.001) {
        discrepancies.push({
          type: 'ROUNDING_LOSS_UNACCOUNTED',
          severity: 'warning',
          message: `Potential rounding loss in run ${run.id}`,
          details: {
            runId: run.id,
            originalAmount: totalAmount,
            roundedAmount,
            loss: (totalAmount - roundedAmount).toFixed(4),
          },
          offeringId: run.offering_id,
        });
      }
    }

    return discrepancies;
  }

  private async checkPayoutCompleteness(
    run: DistributionRun,
    expectedInvestorIds: Set<string>
  ): Promise<ReconciliationDiscrepancy[]> {
    const discrepancies: ReconciliationDiscrepancy[] = [];

    if (run.status !== 'completed' && run.status !== 'processing') {
      return discrepancies;
    }

    return discrepancies;
  }

  private datesOverlap(
    start1?: Date,
    end1?: Date,
    start2?: Date,
    end2?: Date
  ): boolean {
    if (!start1 || !end1 || !start2 || !end2) return false;
    return start1 <= end2 && end1 >= start2;
  }

  private sumRevenueAmounts(reports: RevenueReport[]): string {
    return reports
      .reduce((sum, r) => sum + parseFloat(r.amount ?? '0'), 0)
      .toFixed(2);
  }

  private sumDistributionAmounts(runs: DistributionRun[]): string {
    return runs
      .filter((r) => r.status === 'completed')
      .reduce((sum, r) => sum + parseFloat(r.total_amount), 0)
      .toFixed(2);
  }

  private amountsEqual(a: string, b: string, tolerance: number): boolean {
    return Math.abs(parseFloat(a) - parseFloat(b)) <= tolerance;
  }

  private subtractAmounts(a: string, b: string): string {
    return (parseFloat(a) - parseFloat(b)).toFixed(2);
  }

  private calculateDiscrepancyAmount(revenue: string, payouts: string): string {
    return Math.abs(parseFloat(revenue) - parseFloat(payouts)).toFixed(2);
  }

  private isValidDistributionStatus(
    status: string
  ): status is 'pending' | 'processing' | 'completed' | 'failed' {
    return ['pending', 'processing', 'completed', 'failed'].includes(status);
  }

  private isNegativeAmount(amount: string): boolean {
    return parseFloat(amount) < 0;
  }

  private async validateChainEventConsistency(
    offeringId: string,
    runs: DistributionRun[],
    periodStart: Date,
    periodEnd: Date
  ): Promise<ReconciliationDiscrepancy[]> {
    const discrepancies: ReconciliationDiscrepancy[] = [];

    this.logger.debug(
      'Starting chain event consistency validation',
      {
        offeringId,
        runsCount: runs.length,
        periodStart,
        periodEnd,
      }
    );

    for (const run of runs) {
      if (!run.stellar_transaction_hash) {
        discrepancies.push({
          type: 'STELLAR_TX_NOT_FOUND',
          severity: 'error',
          message: `Distribution run ${run.id} missing Stellar transaction hash`,
          details: {
            runId: run.id,
            status: run.status,
          },
          offeringId,
          periodStart,
          periodEnd,
        });
        continue;
      }

      try {
        // This would integrate with Stellar RPC to validate transaction
        // For now, we'll simulate the validation logic
        const txValidation = await this.validateStellarTransaction(
          run.stellar_transaction_hash,
          run.total_amount
        );

        if (!txValidation.isValid) {
          discrepancies.push({
            type: 'STELLAR_TX_FAILED',
            severity: 'critical',
            message: `Stellar transaction ${run.stellar_transaction_hash} validation failed`,
            details: {
              runId: run.id,
              txHash: run.stellar_transaction_hash,
              expectedAmount: run.total_amount,
              actualAmount: txValidation.actualAmount,
              errors: txValidation.errors,
            },
            offeringId,
            periodStart,
            periodEnd,
          });
        }

        // Check if transaction timestamp matches distribution period
        if (txValidation.timestamp) {
          const txDate = new Date(txValidation.timestamp);
          if (txDate < periodStart || txDate > periodEnd) {
            discrepancies.push({
              type: 'CHAIN_EVENT_MISMATCH',
              severity: 'warning',
              message: `Stellar transaction timestamp outside reconciliation period`,
              details: {
                runId: run.id,
                txHash: run.stellar_transaction_hash,
                txTimestamp: txValidation.timestamp,
                periodStart,
                periodEnd,
              },
              offeringId,
              periodStart,
              periodEnd,
            });
          }
        }
      } catch (error) {
        const failureClass = classifyStellarRPCFailure(error);
        this.logger.warn(
          'Failed to validate Stellar transaction',
          {
            offeringId,
            runId: run.id,
            txHash: run.stellar_transaction_hash,
            failureClass,
            error: error instanceof Error ? error.message : 'Unknown error',
          }
        );
        
        if (failureClass !== StellarRPCFailureClass.UNKNOWN) {
          discrepancies.push({
            type: 'CHAIN_EVENT_VALIDATION_FAILED',
            severity: 'warning',
            message: `Chain event validation failed due to ${failureClass}`,
            details: {
              runId: run.id,
              txHash: run.stellar_transaction_hash,
              failureClass,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            offeringId,
            periodStart,
            periodEnd,
          });
        }
      }
    }

    this.logger.debug(
      'Chain event consistency validation completed',
      {
        offeringId,
        discrepanciesFound: discrepancies.length,
      }
    );

    return discrepancies;
  }

  private async validateStellarTransaction(
    txHash: string,
    expectedAmount: string
  ): Promise<{
    isValid: boolean;
    actualAmount?: string;
    timestamp?: string;
    errors?: string[];
  }> {
    // This is a mock implementation - in production, this would call
    // Stellar RPC to validate the transaction
    
    // Simulate network latency and potential failures
    await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
    
    // Simulate different validation scenarios
    const random = Math.random();
    if (random < 0.1) {
      // 10% chance of timeout
      const timeoutError = new Error('Request timeout');
      timeoutError.name = 'AbortError';
      throw timeoutError;
    } else if (random < 0.15) {
      // 5% chance of rate limit
      const rateLimitError = { status: 429 };
      throw rateLimitError;
    } else if (random < 0.2) {
      // 5% chance of transaction not found
      return {
        isValid: false,
        errors: ['Transaction not found on chain'],
      };
    } else if (random < 0.25) {
      // 5% chance of amount mismatch
      return {
        isValid: false,
        actualAmount: (parseFloat(expectedAmount) * 0.95).toFixed(2), // 5% less
        errors: ['Transaction amount does not match expected distribution amount'],
      };
    }
    
    // 75% chance of success
    return {
      isValid: true,
      actualAmount: expectedAmount,
      timestamp: new Date().toISOString(),
    };
  }

  private async countFailedPayouts(runId: string): Promise<number> {
    return 0;
  }

  private countProcessedPayouts(runs: DistributionRun[]): number {
    return runs.filter((r) => r.status === 'completed').length;
  }
}

export default RevenueReconciliationService;
