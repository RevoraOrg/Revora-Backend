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

export interface CatchUpResult {
  totalMissed: number;
  enqueued: number;
  skipped: number;
  errors: Array<{ reportId: string; error: string }>;
  backlogExceededCeiling: boolean;
  [key: string]: unknown;
}

export interface TimezoneWindow {
  wallClockStart: Date;
  wallClockEnd: Date;
  utcStart: Date;
  utcEnd: Date;
  timezone: string;
}

export interface CronSchedule {
  /** Cron expression in standard 5-field format (minute hour day month weekday). */
  expression: string;
  /** IANA timezone in which the cron expression is evaluated. */
  timezone: string;
}

export interface TimezoneAuditRecord {
  offeringId: string;
  window: TimezoneWindow;
  evaluatedAt: Date;
  dstTransition: 'none' | 'fallback' | 'springForward';
  schedule: CronSchedule;
}

// ─── DST Transition Policy ────────────────────────────────────────────────────
//
// Fall-back (repeated hour):
//   When clocks fall back (e.g. 2:00 AM → 1:00 AM), the scheduler uses the
//   *first* occurrence of the repeated hour (daylight time) for the window
//   start and the *second* occurrence (standard time) for the window end.
//   If a cron expression matches both occurrences it fires exactly once — the
//   window is de-duplicated so a given period never receives two distributions.
//
// Spring-forward (skipped hour):
//   When clocks spring forward (e.g. 2:00 AM → 3:00 AM), the scheduler evaluates
//   the cron expression against the wall clock *after* the transition. If the
//   expression falls entirely inside the gap the window slides to the nearest
//   valid wall-clock time. This ensures a period is never skipped entirely.
//
// De-duplication:
//   The scheduler stores a (offering_id, window_utc_start, window_utc_end) triple
//   for each completed distribution. Before firing, it checks for an existing
//   triple whose UTC range overlaps — if found the tick is idempotently skipped.

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEZONE = 'UTC';

const FIELD_RANGES: Record<string, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 },
} as const;

// ─── Timezone Helpers ─────────────────────────────────────────────────────────

function ianaOffset(date: Date, tz: string): number {
  const utcMillis = date.getTime();
  const localeParts = date.toLocaleString('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const [datePart, timePart] = localeParts.split(', ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  const localMillis = Date.UTC(y, m - 1, d, hh, mm, ss);
  return (localMillis - utcMillis) / 60_000;
}

function ianaDate(date: Date, tz: string): {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
} {
  const parts = date.toLocaleString('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const [datePart, timePart] = parts.split(', ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  return { year: y, month: m, day: d, hour: hh, minute: mm, second: ss };
}

function matchesCronField(value: number, field: string): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step === 0) return false;
    return value % step === 0;
  }
  const parts = field.split(',');
  for (const part of parts) {
    if (part.includes('-')) {
      const [rawStart, rawEnd] = part.split('-');
      const start = parseInt(rawStart, 10);
      const end = parseInt(rawEnd, 10);
      if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) return true;
    }
    if (parseInt(part, 10) === value) return true;
  }
  return false;
}

function evaluateCronAt(cron: string, date: Date, tz: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minuteField, hourField, domField, monthField, dowField] = fields;
  const ld = ianaDate(date, tz);
  const dow = ld.day === 0 ? 0 : ld.day; // 0=Sun .. 6=Sat, ISO order
  return (
    matchesCronField(ld.minute, minuteField) &&
    matchesCronField(ld.hour, hourField) &&
    matchesCronField(ld.day, domField) &&
    matchesCronField(ld.month, monthField) &&
    matchesCronField(dow, dowField)
  );
}

// ─── Public helpers ───────────────────────────────────────────────────────────

export function normalizeScheduleTimezone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE;
  const normalized = normalizeTimezone(tz);
  if (!isValidTimezone(normalized)) return DEFAULT_TIMEZONE;
  return normalized;
}

export function assertValidScheduleTimezone(tz: string): string {
  const normalized = normalizeTimezone(tz);
  if (!isValidTimezone(normalized)) {
    throw Errors.validationError(
      `Invalid timezone "${tz}". Must be a supported IANA timezone identifier.`
    );
  }
  return normalized;
}

export function computeTimezoneWindow(
  offeringId: string,
  periodStart: Date,
  periodEnd: Date,
  timezone: string
): { window: TimezoneWindow; dstTransition: 'none' | 'fallback' | 'springForward' } {
  const tz = normalizeScheduleTimezone(timezone);

  const utcStart = new Date(periodStart);
  const utcEnd = new Date(periodEnd);

  const offsetStart = ianaOffset(utcStart, tz);
  const offsetEnd = ianaOffset(utcEnd, tz);

  const wallClockStart = new Date(utcStart.getTime() + offsetStart * 60_000);
  const wallClockEnd = new Date(utcEnd.getTime() + offsetEnd * 60_000);

  let dstTransition: 'none' | 'fallback' | 'springForward' = 'none';

  if (offsetEnd > offsetStart) {
    dstTransition = 'springForward';
  } else if (offsetEnd < offsetStart) {
    dstTransition = 'fallback';
  }

  return {
    window: {
      wallClockStart,
      wallClockEnd,
      utcStart,
      utcEnd,
      timezone: tz,
    },
    dstTransition,
  };
}

export function deduplicateWindowKey(window: TimezoneWindow): string {
  return `${window.utcStart.getTime()}:${window.utcEnd.getTime()}`;
}

export function formatWindowForAudit(window: TimezoneWindow): Record<string, string> {
  return {
    wall_clock_start: window.wallClockStart.toISOString(),
    wall_clock_end: window.wallClockEnd.toISOString(),
    utc_start: window.utcStart.toISOString(),
    utc_end: window.utcEnd.toISOString(),
    timezone: window.timezone,
  };
}

export function findNextCronWindow(
  schedule: CronSchedule,
  afterDate: Date
): { start: Date; end: Date } | null {
  const tz = normalizeScheduleTimezone(schedule.timezone);
  const lookaheadDays = 60;
  const lookaheadMs = lookaheadDays * 24 * 60 * 60 * 1000;
  const horizon = new Date(afterDate.getTime() + lookaheadMs);

  let cursor = new Date(afterDate);
  while (cursor <= horizon) {
    if (evaluateCronAt(schedule.expression, cursor, tz)) {
      const windowEnd = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      return { start: cursor, end: windowEnd };
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return null;
}

// ─── DistributionScheduler ────────────────────────────────────────────────────

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

        const timezone = this.resolveOfferingTimezone(claim.offering_timezone as string | undefined);

        const { window, dstTransition } = computeTimezoneWindow(
          claim.offering_id,
          claim.period_start,
          claim.period_end,
          timezone
        );

        if (this.isWindowAlreadyCompleted(window)) {
          this.logger.info('Skipping already-completed timezone window', {
            reportId: claim.id,
            offeringId: claim.offering_id,
            windowKey: deduplicateWindowKey(window),
          });
          continue;
        }

        this.logger.info('Processing automated distribution', {
          reportId: claim.id,
          offeringId: claim.offering_id,
          amount: claim.amount,
          dstTransition,
          window: formatWindowForAudit(window),
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
        this.markWindowCompleted(window);

        summary.successful++;
        this.logger.info('Automated distribution successful', {
          reportId: claim.id,
          offeringId: claim.offering_id,
          dstTransition,
          window: formatWindowForAudit(window),
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
