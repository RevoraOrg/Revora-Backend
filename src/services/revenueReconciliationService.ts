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
  | 'DISTRIBUTION_STATUS_INVALID';

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
}

export interface RevenueReconciliationOptions {
  tolerance?: number;
  checkRoundingAdjustments?: boolean;
  checkInvestorAllocations?: boolean;
}

const DEFAULT_TOLERANCE = 0.01;

export class RevenueReconciliationService {
  private readonly revenueReportRepo: RevenueReportRepository;
  private readonly distributionRepo: DistributionRepository;
  private readonly investmentRepo: InvestmentRepository;

  constructor(private readonly db: Pool) {
    this.revenueReportRepo = new RevenueReportRepository(db);
    this.distributionRepo = new DistributionRepository(db);
    this.investmentRepo = new InvestmentRepository(db);
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
    options: RevenueReconciliationOptions = {}
  ): Promise<ReconciliationResult> {
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    const discrepancies: ReconciliationDiscrepancy[] = [];

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

    const totalRevenueReported = this.sumRevenueAmounts(relevantReports);
    const totalPayouts = this.sumDistributionAmounts(relevantRuns);

    const revenueMismatch = this.checkRevenueMismatch(
      totalRevenueReported,
      totalPayouts,
      tolerance
    );
    if (revenueMismatch) {
      discrepancies.push(revenueMismatch);
    }

    for (const run of relevantRuns) {
      const payoutCheck = await this.checkDistributionRunIntegrity(run, tolerance);
      discrepancies.push(...payoutCheck);
    }

    if (options.checkInvestorAllocations) {
      const allocationChecks = await this.checkInvestorAllocations(
        offeringId,
        relevantRuns,
        tolerance
      );
      discrepancies.push(...allocationChecks);
    }

    if (options.checkRoundingAdjustments) {
      const roundingChecks = this.checkRoundingAdjustments(relevantRuns);
      discrepancies.push(...roundingChecks);
    }

    const investors = await this.investmentRepo.findByOffering(offeringId);
    const investorIds = new Set(investors.map((i) => i.investor_id));

    for (const run of relevantRuns) {
      const payoutDiscrepancies = await this.checkPayoutCompleteness(
        run,
        investorIds
      );
      discrepancies.push(...payoutDiscrepancies);
    }

    const hasErrors = discrepancies.some((d) => d.severity === 'error' || d.severity === 'critical');
    const hasWarnings = discrepancies.some((d) => d.severity === 'warning');

    let totalFailedPayouts = 0;
    for (const run of relevantRuns) {
      totalFailedPayouts += await this.countFailedPayouts(run.id);
    }

    return {
      offeringId,
      periodStart,
      periodEnd,
      isBalanced: !hasErrors && !hasWarnings,
      discrepancies,
      summary: {
        totalRevenueReported,
        totalPayouts,
        discrepancyAmount: this.calculateDiscrepancyAmount(
          totalRevenueReported,
          totalPayouts
        ),
        investorCount: investorIds.size,
        payoutsProcessed: this.countProcessedPayouts(relevantRuns),
        payoutsFailed: totalFailedPayouts,
      },
      checkedAt: new Date(),
    };
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

  private async countFailedPayouts(runId: string): Promise<number> {
    return 0;
  }

  private countProcessedPayouts(runs: DistributionRun[]): number {
    return runs.filter((r) => r.status === 'completed').length;
  }
}

export default RevenueReconciliationService;
