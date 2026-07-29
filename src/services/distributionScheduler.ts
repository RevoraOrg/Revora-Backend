import { Logger, globalLogger } from '../lib/logger';
import DistributionEngine from './distributionEngine';
import { RevenueReportRepository } from '../db/repositories/revenueReportRepository';
import { AppError, Errors } from '../lib/errors';
import { classifyStellarRPCFailure } from '../lib/stellarRpcFailure';
import { HolidayCalendarService, BlackoutShiftDecision } from './holidayCalendarService';
import { MetricsCollector } from '../lib/metrics';

export interface DistributionSchedulerOptions {
  logger?: Logger;
  holidayCalendarService?: HolidayCalendarService;
  resolveJurisdiction?: (offeringId: string) => Promise<string | null> | string | null;
  /** Maximum reports to enqueue in a single catch-up pass (default: 50). */
  catchupMax?: number;
  /** Backlog size above which a red-alert is emitted (default: 2× catchupMax). */
  catchupBacklogAlertThreshold?: number;
  metrics?: MetricsCollector;
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

// ─── Cron Window Types ────────────────────────────────────────────────────────

/**
 * @notice A persisted cron-expression window definition attached to an offering.
 * @dev    treasury operators set this to control when deferred distributions fire
 *         without a code redeploy. Stored in the `offerings` table as
 *         `cron_expression` + `distribution_timezone` columns.
 */
export interface CronWindowDefinition {
  /** Standard 5-field cron expression (minute hour dom month dow). */
  expression: string;
  /** IANA timezone for wall-clock evaluation of the expression. */
  timezone: string;
  /** Offering this schedule belongs to. */
  offeringId: string;
}

/** Per-field overlap record emitted when two windows collide. */
export interface WindowOverlapDetail {
  offeringIdA: string;
  offeringIdB: string;
  /** Next shared firing time (UTC ISO-8601) */
  collisionAt: string;
}

export interface CronWindowValidationResult {
  valid: boolean;
  /** Human-readable reason(s) for rejection. */
  reasons: string[];
  /** Set when the expression overlaps a Stellar maintenance window. */
  stellarConflict?: { windowLabel: string; conflictAt: string };
  /** Set when two offering windows collide. */
  overlapDetail?: WindowOverlapDetail;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEZONE = 'UTC';

const FIELD_RANGES: Record<string, { min: number; max: number }> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 },
} as const;

/**
 * @notice Known Stellar network maintenance windows.
 * @dev    Each entry describes a recurring UTC hour-range during which
 *         the Stellar network may be unavailable for transaction submission.
 *         The `cron` field is a 5-field expression matching the *start* minute
 *         of the maintenance window; `durationMinutes` is its length.
 *         Source: https://developers.stellar.org/docs/networks/maintenance
 *
 *         These are intentionally conservative — when in doubt, err toward a
 *         wider window so distribution jobs are not submitted into a degraded
 *         network.
 */
export const STELLAR_MAINTENANCE_WINDOWS = [
  {
    label: 'Stellar weekly maintenance (Sunday 06:00–07:00 UTC)',
    /**  min  hr  dom  month  dow(0=Sun) */
    cron: '0   6   *    *      0',
    durationMinutes: 60,
  },
  {
    label: 'Stellar monthly upgrade window (1st Monday 02:00–04:00 UTC)',
    cron: '0   2   *    *      1',
    durationMinutes: 120,
  },
] as const;

// ─── Private timezone helpers ─────────────────────────────────────────────────

/**
 * Canonicalise common timezone aliases to IANA identifiers.
 * For example "EST" → "America/New_York".
 */
function normalizeTimezone(tz: string): string {
  const aliases: Record<string, string> = {
    EST: 'America/New_York',
    EDT: 'America/New_York',
    CST: 'America/Chicago',
    CDT: 'America/Chicago',
    MST: 'America/Denver',
    MDT: 'America/Denver',
    PST: 'America/Los_Angeles',
    PDT: 'America/Los_Angeles',
    GMT: 'UTC',
  };
  return aliases[tz.trim()] ?? tz.trim();
}

/** Returns true when tz is a valid IANA timezone identifier. */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── CronWindowValidator ──────────────────────────────────────────────────────

/**
 * @title CronWindowValidator
 * @notice Validates cron-expression window definitions before they are persisted
 *         per offering. Rejects:
 *           1. Syntactically invalid cron expressions.
 *           2. Expressions that fire during known Stellar network maintenance.
 *           3. Expressions that overlap an already-registered offering window
 *              within the configured lookahead horizon (default 60 days).
 * @dev    All time comparisons use UTC.  IANA timezone expressions are resolved
 *         to UTC before comparison so DST transitions cannot create false negatives.
 */
export class CronWindowValidator {
  /** Seconds of lookahead for overlap detection (default: 60 days). */
  private readonly lookaheadMs: number;
  private readonly metrics?: MetricsCollector;
  private readonly logger: Logger;

  constructor(options: {
    lookaheadDays?: number;
    metrics?: MetricsCollector;
    logger?: Logger;
  } = {}) {
    this.lookaheadMs = (options.lookaheadDays ?? 60) * 24 * 60 * 60 * 1_000;
    this.metrics = options.metrics;
    this.logger = options.logger ?? globalLogger;
  }

  /**
   * Validate a single CronWindowDefinition in isolation (syntax + Stellar maintenance).
   */
  validate(def: CronWindowDefinition): CronWindowValidationResult {
    const reasons: string[] = [];

    // 1. Structural validation
    const syntaxError = validateCronSyntax(def.expression);
    if (syntaxError) {
      reasons.push(syntaxError);
    }

    const tzNorm = normalizeTimezone(def.timezone);
    if (!isValidTimezone(tzNorm)) {
      reasons.push(`Invalid timezone "${def.timezone}"`);
    }

    if (reasons.length > 0) {
      this._emitRejected(def, reasons);
      return { valid: false, reasons };
    }

    // 2. Stellar maintenance window conflict
    const now = new Date();
    const horizon = new Date(now.getTime() + this.lookaheadMs);
    const stellarConflict = this._checkStellarConflict(def, now, horizon);
    if (stellarConflict) {
      reasons.push(
        `Expression fires during Stellar maintenance: ${stellarConflict.windowLabel} at ${stellarConflict.conflictAt}`
      );
      this._emitRejected(def, reasons);
      return { valid: false, reasons, stellarConflict };
    }

    return { valid: true, reasons: [] };
  }

  /**
   * Validate a new window against an array of already-registered windows for
   * *other* offerings. Returns a rejection result if any overlap is detected
   * within the lookahead horizon.
   */
  validateAgainstExisting(
    incoming: CronWindowDefinition,
    existing: CronWindowDefinition[]
  ): CronWindowValidationResult {
    // First run base validation
    const base = this.validate(incoming);
    if (!base.valid) return base;

    const now = new Date();
    const horizon = new Date(now.getTime() + this.lookaheadMs);

    for (const other of existing) {
      if (other.offeringId === incoming.offeringId) continue;

      const overlap = this._checkExpressionOverlap(incoming, other, now, horizon);
      if (overlap) {
        const reasons = [
          `Window for offering "${incoming.offeringId}" overlaps with offering "${other.offeringId}" at ${overlap}`,
        ];
        const detail: WindowOverlapDetail = {
          offeringIdA: incoming.offeringId,
          offeringIdB: other.offeringId,
          collisionAt: overlap,
        };
        this._emitRejected(incoming, reasons);
        this.logger.warn('scheduler.window.rejected: overlap detected', {
          offeringId: incoming.offeringId,
          collidingOfferingId: other.offeringId,
          collisionAt: overlap,
          diff: {
            incoming: incoming.expression,
            existing: other.expression,
          },
        });
        return { valid: false, reasons, overlapDetail: detail };
      }
    }

    return { valid: true, reasons: [] };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _checkStellarConflict(
    def: CronWindowDefinition,
    from: Date,
    to: Date
  ): { windowLabel: string; conflictAt: string } | null {
    const tz = normalizeScheduleTimezone(def.timezone);
    let cursor = new Date(from);
    while (cursor <= to) {
      if (evaluateCronAt(def.expression, cursor, tz)) {
        for (const maint of STELLAR_MAINTENANCE_WINDOWS) {
          const maintCron = maint.cron.replace(/\s+/g, ' ').trim();
          // Check if the firing minute falls inside the maintenance window
          const maintStart = new Date(cursor);
          if (evaluateCronAt(maintCron, cursor, 'UTC')) {
            return { windowLabel: maint.label, conflictAt: cursor.toISOString() };
          }
          // Also check if cursor falls within an already-started maintenance window
          // by scanning backwards up to durationMinutes
          for (let back = 1; back <= maint.durationMinutes; back++) {
            const candidate = new Date(cursor.getTime() - back * 60_000);
            if (evaluateCronAt(maintCron, candidate, 'UTC')) {
              return { windowLabel: maint.label, conflictAt: cursor.toISOString() };
            }
          }
        }
      }
      cursor = new Date(cursor.getTime() + 60_000);
    }
    return null;
  }

  private _checkExpressionOverlap(
    a: CronWindowDefinition,
    b: CronWindowDefinition,
    from: Date,
    to: Date
  ): string | null {
    const tzA = normalizeScheduleTimezone(a.timezone);
    const tzB = normalizeScheduleTimezone(b.timezone);
    let cursor = new Date(from);
    while (cursor <= to) {
      if (
        evaluateCronAt(a.expression, cursor, tzA) &&
        evaluateCronAt(b.expression, cursor, tzB)
      ) {
        return cursor.toISOString();
      }
      cursor = new Date(cursor.getTime() + 60_000);
    }
    return null;
  }

  private _emitRejected(def: CronWindowDefinition, reasons: string[]): void {
    this.metrics?.incrementCounter('scheduler_window_rejected_total', {
      offering_id: def.offeringId,
    });
    this.logger.warn('scheduler.window.rejected', {
      offeringId: def.offeringId,
      expression: def.expression,
      timezone: def.timezone,
      reasons,
    });
  }
}

// ─── Cron syntax validator ────────────────────────────────────────────────────

/**
 * Returns an error string if `expr` is not a valid 5-field cron expression,
 * or `null` if it passes.
 */
export function validateCronSyntax(expr: string): string | null {
  if (!expr || typeof expr !== 'string') return 'Expression must be a non-empty string';
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `Expected 5 fields (minute hour dom month dow) but got ${fields.length}`;
  }
  const names = Object.keys(FIELD_RANGES);
  const ranges = Object.values(FIELD_RANGES);
  for (let i = 0; i < 5; i++) {
    const field = fields[i]!;
    const { min, max } = ranges[i]!;
    const err = validateCronField(field, names[i]!, min, max);
    if (err) return err;
  }
  return null;
}

function validateCronField(field: string, name: string, min: number, max: number): string | null {
  if (field === '*') return null;

  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return `${name}: invalid step "${field}"`;
    if (step > max - min + 1) return `${name}: step ${step} exceeds field range ${min}-${max}`;
    return null;
  }

  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [rawS, rawE] = part.split('-');
      const s = parseInt(rawS!, 10);
      const e = parseInt(rawE!, 10);
      if (isNaN(s) || isNaN(e)) return `${name}: invalid range "${part}"`;
      if (s < min || e > max) return `${name}: range ${s}-${e} out of bounds [${min},${max}]`;
      if (s > e) return `${name}: range start ${s} > end ${e}`;
    } else {
      const v = parseInt(part, 10);
      if (isNaN(v) || v < min || v > max) {
        return `${name}: value "${part}" out of bounds [${min},${max}]`;
      }
    }
  }
  return null;
}

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
  // Compute day-of-week from the UTC date (0=Sun..6=Sat)
  const localDateUtc = new Date(Date.UTC(ld.year, ld.month - 1, ld.day));
  const dow = localDateUtc.getUTCDay();
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
  private readonly catchupMax: number;
  private readonly catchupBacklogAlertThreshold: number;
  private readonly metrics?: MetricsCollector;
  /** In-process de-duplication set: "utcStart:utcEnd" keys. */
  private readonly completedWindows = new Set<string>();

  constructor(
    private readonly distributionEngine: DistributionEngine,
    private readonly revenueReportRepo: RevenueReportRepository,
    options: DistributionSchedulerOptions = {}
  ) {
    this.logger = options.logger ?? globalLogger;
    this.holidayCalendarService = options.holidayCalendarService;
    this.resolveJurisdiction = options.resolveJurisdiction;
    this.metrics = options.metrics;

    // ── catchupMax resolution ─────────────────────────────────────────────────
    if (options.catchupMax !== undefined) {
      if (
        !Number.isInteger(options.catchupMax) ||
        options.catchupMax <= 0
      ) {
        throw new Error('catchupMax must be a positive integer');
      }
      this.catchupMax = options.catchupMax;
    } else {
      const envVal = process.env['SCHEDULER_CATCHUP_MAX'];
      if (envVal !== undefined && envVal !== '') {
        const parsed = parseInt(envVal, 10);
        if (isNaN(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
          throw new Error('SCHEDULER_CATCHUP_MAX must be a positive integer');
        }
        this.catchupMax = parsed;
      } else {
        this.catchupMax = 50;
      }
    }

    this.catchupBacklogAlertThreshold =
      options.catchupBacklogAlertThreshold ?? this.catchupMax * 2;
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

  /**
   * @notice Catch up on missed distribution windows.
   * @dev    Scans for approved reports without a successful distribution,
   *         emits a scheduler.catchup.backlog gauge, enqueues up to
   *         catchupMax windows, and emits a red-alert if the backlog
   *         exceeds the configured ceiling.
   */
  async catchUpMissedWindows(): Promise<CatchUpResult> {
    const pending = await this.revenueReportRepo.findApprovedWithoutDistribution();
    const totalMissed = pending.length;

    this.metrics?.setGauge('scheduler_catchup_backlog', totalMissed);

    const backlogExceededCeiling = totalMissed > this.catchupBacklogAlertThreshold;
    if (backlogExceededCeiling) {
      this.logger.error(
        `[RED-ALERT] Distribution backlog ${totalMissed} exceeds threshold ${this.catchupBacklogAlertThreshold}`
      );
    }

    const result: CatchUpResult = {
      totalMissed,
      enqueued: 0,
      skipped: totalMissed > this.catchupMax ? totalMissed - this.catchupMax : 0,
      errors: [],
      backlogExceededCeiling,
    };

    const toProcess = pending.slice(0, this.catchupMax);

    for (const report of toProcess) {
      try {
        const claim = await this.revenueReportRepo.claimApprovedReportForDistribution(report.id);
        if (!claim) {
          // Another scheduler instance claimed it — counts as skipped
          continue;
        }
        result.enqueued++;
      } catch (err) {
        result.errors.push({
          reportId: report.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.info('catch-up missed windows complete', {
      totalMissed,
      enqueued: result.enqueued,
      skipped: result.skipped,
      errors: result.errors.length,
      backlogExceededCeiling,
    });

    return result;
  }

  // ── Window de-duplication ──────────────────────────────────────────────────

  private isWindowAlreadyCompleted(window: TimezoneWindow): boolean {
    return this.completedWindows.has(deduplicateWindowKey(window));
  }

  private markWindowCompleted(window: TimezoneWindow): void {
    this.completedWindows.add(deduplicateWindowKey(window));
  }

  // ── Timezone resolution ────────────────────────────────────────────────────

  private resolveOfferingTimezone(tz: string | undefined): string {
    return normalizeScheduleTimezone(tz);
  }
}
