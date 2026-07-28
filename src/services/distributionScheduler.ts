import { Logger, globalLogger } from '../lib/logger';
import DistributionEngine from './distributionEngine';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { AppError, Errors } from '../lib/errors';
import { classifyStellarRPCFailure } from '../lib/stellarRpcFailure';
import { HolidayCalendarService, BlackoutShiftDecision } from './holidayCalendarService';

export interface DistributionSchedulerOptions {
  logger?: Logger;
  holidayCalendarService?: HolidayCalendarService;
  resolveJurisdiction?: (offeringId: string) => Promise<string | null> | string | null;
}

/**
 * @title DistributionScheduler
 * @notice Automates the execution of distributions based on approved revenue reports.
 * @dev This service scans for approved revenue reports that haven't been successfully distributed
 * and triggers the DistributionEngine for each.
 */
export class DistributionScheduler {
  private readonly logger: Logger;
  private readonly holidayCalendarService?: HolidayCalendarService;
  private readonly resolveJurisdiction?: (offeringId: string) => Promise<string | null> | string | null;

  constructor(
    private readonly distributionEngine: DistributionEngine,
    private readonly revenueReportRepo: RevenueReportRepository,
    options: DistributionSchedulerOptions = {}
  ) {
    this.logger = options.logger ?? globalLogger;
    this.holidayCalendarService = options.holidayCalendarService;
    this.resolveJurisdiction = options.resolveJurisdiction;
  }

  /**
   * Scans for pending distributions and processes them.
   * @returns A summary of the processing run.
   */
  async processPendingDistributions(): Promise<{
    processed: number;
    successful: number;
    failed: number;
    errors: Array<{ reportId: string; error: string }>;
  }> {
    this.logger.info('Starting automated distribution processing');
    
    const pendingReports = await this.revenueReportRepo.findApprovedWithoutDistribution();
    
    this.logger.info(`Found ${pendingReports.length} pending reports for distribution`);

    const summary = {
      processed: pendingReports.length,
      successful: 0,
      failed: 0,
      errors: [] as Array<{ reportId: string; error: string }>,
    };

    for (const report of pendingReports) {
      let claim: typeof report | null = null;

      try {
        claim = await this.revenueReportRepo.claimApprovedReportForDistribution(report.id);

        if (!claim) {
          this.logger.info('Skipping report already claimed by another scheduler', {
            reportId: report.id,
          });
          continue;
        }

        if (!claim.period_start || !claim.period_end || !claim.amount) {
          throw Errors.badRequest(`Report ${claim.id} is missing critical data (period or amount)`);
        }

        this.logger.info('Processing automated distribution', {
          reportId: claim.id,
          offeringId: claim.offering_id,
          amount: claim.amount,
        });

        let periodEnd = claim.period_end;
        const jurisdiction = await this.resolveOfferingJurisdiction(claim.offering_id);

        if (this.holidayCalendarService && jurisdiction) {
          const shiftDecision = this.holidayCalendarService.getShiftedDate(claim.period_end, [jurisdiction]);

          if (shiftDecision.shifted) {
            periodEnd = shiftDecision.shiftedDate;
            this.logger.info('Distribution window shifted due to blackout', {
              reportId: claim.id,
              offeringId: claim.offering_id,
              originalDate: shiftDecision.originalDate.toISOString(),
              shiftedDate: shiftDecision.shiftedDate.toISOString(),
              direction: shiftDecision.direction,
              jurisdictions: shiftDecision.jurisdictions,
              reason: shiftDecision.reason,
            });
          }
        }

        await this.distributionEngine.distribute(
          claim.offering_id,
          {
            id: claim.id,
            start: claim.period_start,
            end: periodEnd,
          },
          Number(claim.amount)
        );

        await this.revenueReportRepo.markReportDistributionCompleted(claim.id);

        summary.successful++;
        this.logger.info('Automated distribution successful', {
          reportId: claim.id,
          offeringId: claim.offering_id,
        });
      } catch (err) {
        if (claim) {
          try {
            await this.revenueReportRepo.markReportDistributionFailed(claim.id);
          } catch (markErr) {
            this.logger.error('Failed to update report distribution status after failure', {
              reportId: claim.id,
              error: markErr instanceof Error ? markErr.message : String(markErr),
            });
          }
        }

        if (!claim) {
          continue;
        }

        summary.failed++;
        
        const failure = classifyStellarRPCFailure(err, {
          operation: 'automatedDistribution',
          offeringId: claim.offering_id,
          periodId: claim.id,
        });

        // Use a safe error message for the summary
        const safeError = `Distribution failed: ${failure.class}`;
          
        summary.errors.push({ reportId: claim.id, error: safeError });
        
        this.logger.error('Automated distribution failed', {
          reportId: claim.id,
          offeringId: claim.offering_id,
          error: err instanceof Error ? err.message : String(err),
          failureClass: failure.class,
          isAppError: err instanceof AppError,
        });
      }
    }

    this.logger.info('Automated distribution processing complete', summary);
    return summary;
  }

  private async resolveOfferingJurisdiction(offeringId: string): Promise<string | null> {
    if (!this.resolveJurisdiction) return null;
    try {
      const result = this.resolveJurisdiction(offeringId);
      return result instanceof Promise ? await result : result;
    } catch {
      return null;
    }
  }
}
