import { Logger, globalLogger } from '../lib/logger';
import DistributionEngine from './distributionEngine';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { AppError, Errors } from '../lib/errors';
import { classifyStellarRPCFailure } from '../lib/stellarRpcFailure';
import { MetricsCollector } from '../lib/metrics';

export interface DistributionSchedulerOptions {
  logger?: Logger;
  metrics?: MetricsCollector;
  /**
   * Maximum number of missed distribution windows to enqueue during startup
   * catch-up. Overrides the SCHEDULER_CATCHUP_MAX env var when set.
   */
  catchupMax?: number;
  /**
   * Backlog count beyond which a red-alert is emitted. Defaults to 2x catchupMax.
   */
  catchupBacklogAlertThreshold?: number;
}

export interface CatchUpResult {
  totalMissed: number;
  enqueued: number;
  skipped: number;
  errors: Array<{ reportId: string; error: string }>;
  backlogExceededCeiling: boolean;
  [key: string]: unknown;
}

/**
 * @title DistributionScheduler
 * @notice Automates the execution of distributions based on approved revenue reports.
 * @dev This service scans for approved revenue reports that haven't been successfully distributed
 * and triggers the DistributionEngine for each.
 *
 * Catch-up mode:
 * On startup, catchUpMissedWindows() computes missed distribution windows by scanning
 * approved reports without a successful distribution, emits a scheduler.catchup.backlog
 * gauge, enqueues up to catchupMax windows via the existing claim-flow for concurrency
 * safety, and emits a red-alert if the backlog exceeds the configured ceiling.
 */
export class DistributionScheduler {
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector | undefined;
  private readonly catchupMax: number;
  private readonly catchupBacklogAlertThreshold: number;

  private static ENV_CATCHUP_MAX = 'SCHEDULER_CATCHUP_MAX';

  constructor(
    private readonly distributionEngine: DistributionEngine,
    private readonly revenueReportRepo: RevenueReportRepository,
    options: DistributionSchedulerOptions = {}
  ) {
    this.logger = options.logger ?? globalLogger;
    this.metrics = options.metrics;
    this.catchupMax = this.resolveCatchupMax(options.catchupMax);
    this.catchupBacklogAlertThreshold =
      options.catchupBacklogAlertThreshold ?? this.catchupMax * 2;
  }

  /**
   * Resolve and validate catchupMax from options or env var.
   * Fail-fast: throws on missing or invalid value.
   */
  private resolveCatchupMax(explicit?: number): number {
    if (explicit !== undefined) {
      if (!Number.isInteger(explicit) || explicit < 1) {
        throw Errors.badRequest(
          `catchupMax must be a positive integer, got ${explicit}`
        );
      }
      return explicit;
    }

    const envRaw = process.env[DistributionScheduler.ENV_CATCHUP_MAX];
    if (envRaw !== undefined && envRaw !== '') {
      const parsed = Number(envRaw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw Errors.badRequest(
          `${DistributionScheduler.ENV_CATCHUP_MAX} must be a positive integer, got "${envRaw}"`
        );
      }
      return parsed;
    }

    return 50;
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

        await this.distributionEngine.distribute(
          claim.offering_id,
          {
            id: claim.id,
            start: claim.period_start,
            end: claim.period_end,
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

  /**
   * Startup catch-up: compute missed distribution windows, emit a backlog gauge,
   * and enqueue up to catchupMax reports via the existing claim flow.
   *
   * Concurrency safety:
   *   claimApprovedReportForDistribution uses an UPDATE ... WHERE with status
   *   guards, so concurrent restarts cannot double-enqueue the same report.
   *
   * Pagination:
   *   Only the first catchupMax reports are processed per call. Callers may
   *   invoke this method repeatedly to paginate through a large backlog.
   *
   * Backlog alert:
   *   If totalMissed exceeds catchupBacklogAlertThreshold, a red-alert is
   *   emitted via logger.error.
   */
  async catchUpMissedWindows(): Promise<CatchUpResult> {
    this.logger.info('Starting catch-up for missed distribution windows');

    const pendingReports = await this.revenueReportRepo.findApprovedWithoutDistribution();

    const totalMissed = pendingReports.length;
    this.logger.info(`Found ${totalMissed} missed distribution window(s)`);

    if (this.metrics) {
      this.metrics.setGauge(
        'scheduler_catchup_backlog',
        totalMissed,
        undefined,
        'Number of missed distribution windows awaiting catch-up'
      );
    }

    const backlogExceededCeiling = totalMissed > this.catchupBacklogAlertThreshold;
    if (backlogExceededCeiling) {
      this.logger.error(
        `[RED-ALERT] Catch-up backlog ${totalMissed} exceeds ceiling ${this.catchupBacklogAlertThreshold}`
      );
    }

    const toProcess = pendingReports.slice(0, this.catchupMax);
    const skipped = Math.max(0, totalMissed - this.catchupMax);
    const errors: CatchUpResult['errors'] = [];
    let enqueued = 0;

    for (const report of toProcess) {
      try {
        const claimed = await this.revenueReportRepo.claimApprovedReportForDistribution(report.id);
        if (claimed) {
          enqueued++;
          this.logger.info('Enqueued missed window for distribution', {
            reportId: report.id,
            offeringId: report.offering_id,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('Failed to enqueue missed window', {
          reportId: report.id,
          error: message,
        });
        errors.push({ reportId: report.id, error: message });
      }
    }

    const result: CatchUpResult = {
      totalMissed,
      enqueued,
      skipped,
      errors,
      backlogExceededCeiling,
    };

    this.logger.info('Catch-up complete', result);
    return result;
  }
}
