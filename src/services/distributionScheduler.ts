/**
 * DistributionScheduler — claims approved revenue reports and runs them
 * through the DistributionEngine. See architecture map for the full sequence.
 *
 * @see ../../docs/architecture/distribution-reconciliation.md
 * @see ../docs/distribution-scheduler-idempotency.md
 * @see ../docs/holiday-calendar-service.md
 * @see ../docs/distribution-advisory-lock.md
 */
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
    /** When true, only the first weekday occurrence of the month matches (DOM 1–7). */
    firstWeekdayOfMonth: false,
  },
  {
    label: 'Stellar monthly upgrade window (1st Monday 02:00–04:00 UTC)',
    /** Monday 02:00 UTC — constrained to DOM 1–7 via firstWeekdayOfMonth. */
    cron: '0   2   *    *      1',
    durationMinutes: 120,
    firstWeekdayOfMonth: true,
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
    'Etc/UTC': 'UTC',
    'Etc/GMT': 'UTC',
    Z: 'UTC',
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
    const stepMs = cronScanStepMs(def.expression, tz);
    let cursor = new Date(from);
    // Align to minute boundary
    cursor.setUTCSeconds(0, 0);
    while (cursor <= to) {
      const fireAt = snapCronCandidate(def.expression, cursor, tz) ?? cursor;
      if (fireAt >= from && fireAt <= to && evaluateCronAt(def.expression, fireAt, tz)) {
        for (const maint of STELLAR_MAINTENANCE_WINDOWS) {
          const maintCron = maint.cron.replace(/\s+/g, ' ').trim();
          if (matchesMaintenanceAt(maintCron, fireAt, maint)) {
            return { windowLabel: maint.label, conflictAt: fireAt.toISOString() };
          }
          for (let back = 1; back <= maint.durationMinutes; back++) {
            const candidate = new Date(fireAt.getTime() - back * 60_000);
            if (matchesMaintenanceAt(maintCron, candidate, maint)) {
              return { windowLabel: maint.label, conflictAt: fireAt.toISOString() };
            }
          }
        }
      }
      cursor = new Date((snapCronCandidate(def.expression, cursor, tz) ?? cursor).getTime() + stepMs);
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
    const stepMs = Math.min(cronScanStepMs(a.expression, tzA), cronScanStepMs(b.expression, tzB));
    let cursor = new Date(from);
    cursor.setUTCSeconds(0, 0);
    while (cursor <= to) {
      const candidate =
        snapCronCandidate(a.expression, cursor, tzA) ??
        snapCronCandidate(b.expression, cursor, tzB) ??
        cursor;
      if (
        candidate >= from &&
        candidate <= to &&
        evaluateCronAt(a.expression, candidate, tzA) &&
        evaluateCronAt(b.expression, candidate, tzB)
      ) {
        return candidate.toISOString();
      }
      cursor = new Date((snapCronCandidate(a.expression, cursor, tzA) ?? cursor).getTime() + stepMs);
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

/**
 * Choose a scan step for cron horizon walks.
 * - Concrete minute+hour in UTC → 1 day
 * - Concrete minute (any tz) → 1 hour (caller should snap to :MM)
 * - Otherwise → 1 minute
 */
function cronScanStepMs(expression: string, tz: string): number {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return 60_000;
  const concreteMin = /^\d+$/.test(fields[0]!);
  const concreteHour = /^\d+$/.test(fields[1]!);
  if (tz === 'UTC' && concreteMin && concreteHour) return 24 * 60 * 60 * 1000;
  if (concreteMin) return 60 * 60 * 1000;
  return 60_000;
}

/**
 * Snap `cursor` toward the next plausible fire candidate for concrete fields.
 * UTC + concrete HH:MM → that UTC instant on the cursor's day.
 * Concrete minute only → same hour with that minute.
 */
function snapCronCandidate(expression: string, cursor: Date, tz: string): Date | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minConcrete = /^\d+$/.test(fields[0]!) ? parseInt(fields[0]!, 10) : null;
  const hourConcrete = /^\d+$/.test(fields[1]!) ? parseInt(fields[1]!, 10) : null;

  if (tz === 'UTC' && minConcrete !== null && hourConcrete !== null) {
    return new Date(Date.UTC(
      cursor.getUTCFullYear(),
      cursor.getUTCMonth(),
      cursor.getUTCDate(),
      hourConcrete,
      minConcrete,
      0,
      0
    ));
  }

  if (minConcrete !== null) {
    const snapped = new Date(cursor);
    snapped.setUTCSeconds(0, 0);
    snapped.setUTCMinutes(minConcrete);
    return snapped;
  }

  return null;
}

/**
 * Returns true when `date` (UTC) falls on a maintenance start matching `maintCron`,
 * honouring the optional first-weekday-of-month constraint.
 */
function matchesMaintenanceAt(
  maintCron: string,
  date: Date,
  maint: { firstWeekdayOfMonth?: boolean }
): boolean {
  if (!evaluateCronAt(maintCron, date, 'UTC')) return false;
  if (maint.firstWeekdayOfMonth && date.getUTCDate() > 7) return false;
  return true;
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

export function deduplicateWindowKey(window: TimezoneWindow, offeringId?: string): string {
  return `${offeringId ?? ''}:${window.utcStart.getTime()}:${window.utcEnd.getTime()}`;
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

/**
 * Find the next wall-clock fire of a cron schedule after `afterDate`.
 *
 * @param schedule Cron expression + IANA timezone
 * @param afterDate Exclusive lower bound (search starts at the next minute)
 * @param lookaheadDays How far ahead to scan (default 60; use ≥366 for annual exprs)
 * @returns Window start/end or null when the expression never fires in the horizon
 *
 * @dev When minute + hour are concrete integers the scan advances one day at a
 *      time (checking the candidate HH:MM), which keeps year-skip lookups O(days)
 *      instead of O(minutes).
 */
export function findNextCronWindow(
  schedule: CronSchedule,
  afterDate: Date,
  lookaheadDays = 60
): { start: Date; end: Date } | null {
  const tz = normalizeScheduleTimezone(schedule.timezone);
  const days = Number.isFinite(lookaheadDays) && lookaheadDays > 0 ? lookaheadDays : 60;
  const lookaheadMs = days * 24 * 60 * 60 * 1000;
  const horizon = new Date(afterDate.getTime() + lookaheadMs);

  const fields = schedule.expression.trim().split(/\s+/);
  const concreteMin = fields.length === 5 && /^\d+$/.test(fields[0]!) ? parseInt(fields[0]!, 10) : null;
  const concreteHour = fields.length === 5 && /^\d+$/.test(fields[1]!) ? parseInt(fields[1]!, 10) : null;
  // Daily snap is only safe for UTC (local HH:MM == UTC HH:MM). Other zones
  // keep the minute scan so DST offsets are handled by evaluateCronAt.
  const dailyFastPath =
    tz === 'UTC' && concreteMin !== null && concreteHour !== null;

  let cursor: Date;
  if (dailyFastPath) {
    cursor = new Date(afterDate.getTime());
    cursor.setUTCSeconds(0, 0);
  } else {
    cursor = new Date(afterDate.getTime());
    cursor.setUTCSeconds(0, 0);
  }

  while (cursor <= horizon) {
    if (dailyFastPath) {
      // Snap to concrete HH:MM on the current UTC day, then step days.
      const candidate = new Date(Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
        concreteHour!,
        concreteMin!,
        0,
        0
      ));
      if (candidate >= afterDate && candidate <= horizon && evaluateCronAt(schedule.expression, candidate, tz)) {
        return { start: candidate, end: new Date(candidate.getTime() + 24 * 60 * 60 * 1000) };
      }
      // Advance to next day after the candidate (or cursor if candidate is before afterDate)
      const base = candidate < afterDate ? afterDate : candidate;
      cursor = new Date(Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate() + 1,
        concreteHour!,
        concreteMin!,
        0,
        0
      ));
      continue;
    }

    if (evaluateCronAt(schedule.expression, cursor, tz)) {
      return { start: cursor, end: new Date(cursor.getTime() + 24 * 60 * 60 * 1000) };
    }
    cursor = new Date(cursor.getTime() + 60_000);
  }

  // Only warn for long-horizon searches (year-skip / annual expressions). Short
  // lookbacks used as deferred-gate probes are expected to miss frequently.
  if (days >= 60) {
    globalLogger.warn('findNextCronWindow: expression never fires within lookahead', {
      expression: schedule.expression,
      timezone: tz,
      afterDate: afterDate.toISOString(),
      lookaheadDays: days,
    });
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
        const timezone = this.resolveOfferingTimezone(
          (report.distribution_timezone as string | undefined) ??
            (report.offering_timezone as string | undefined)
        );
        const cronExpression = report.cron_expression as string | undefined | null;

        // Deferred cron gate (pre-claim): skip until a fire window is open.
        // Uses a 24h lookback so a delayed scheduler tick still processes the day-of fire.
        if (cronExpression) {
          const schedule: CronSchedule = { expression: cronExpression, timezone };
          const now = new Date();
          const lookback = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          const openWindow = findNextCronWindow(schedule, lookback, 2);
          if (!openWindow || now < openWindow.start) {
            this.logger.info('Deferring distribution until cron window opens', {
              reportId: report.id,
              offeringId: report.offering_id,
              nextFireAt: openWindow?.start.toISOString() ?? null,
              expression: cronExpression,
              timezone,
            });
            continue;
          }
        }

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

        const { window, dstTransition } = computeTimezoneWindow(
          claim.offering_id,
          claim.period_start,
          claim.period_end,
          timezone
        );

        if (this.isWindowAlreadyCompleted(window, claim.offering_id)) {
          this.logger.info('Skipping already-completed timezone window', {
            reportId: claim.id,
            offeringId: claim.offering_id,
            windowKey: deduplicateWindowKey(window, claim.offering_id),
          });
          continue;
        }

        this.logger.info('Processing automated distribution', {
          reportId: claim.id,
          offeringId: claim.offering_id,
          amount: claim.amount,
          dstTransition,
          window: formatWindowForAudit(window),
          cronExpression: cronExpression ?? null,
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
        this.markWindowCompleted(window, claim.offering_id);

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

  /** @notice Returns true when this UTC window was already processed in-process. */
  isWindowAlreadyCompleted(window: TimezoneWindow, offeringId?: string): boolean {
    return this.completedWindows.has(deduplicateWindowKey(window, offeringId));
  }

  /** @notice Mark a UTC window as completed so fall-back DST ticks are idempotent. */
  markWindowCompleted(window: TimezoneWindow, offeringId?: string): void {
    this.completedWindows.add(deduplicateWindowKey(window, offeringId));
  }

  // ── Timezone / cron helpers ────────────────────────────────────────────────

  /** @notice Resolve an offering timezone, falling back to UTC for invalid values. */
  resolveOfferingTimezone(tz: string | undefined): string {
    return normalizeScheduleTimezone(tz);
  }

  /**
   * @notice Evaluate whether `expression` matches `date` in `timezone`.
   * @dev Returns false for syntactically invalid expressions (never throws).
   */
  evaluateCron(expression: string, date: Date, timezone: string): boolean {
    if (validateCronSyntax(expression)) return false;
    return evaluateCronAt(expression, date, normalizeScheduleTimezone(timezone));
  }
}

// ─── DistributionStateManager ─────────────────────────────────────────────────

export type DistributionState = 'active' | 'paused' | 'resumed';

export interface DistributionPauseRecord {
  state: DistributionState;
  reason: string;
  pausedAt: Date;
  pausedBy: string;
  resumedAt?: Date;
  resumedBy?: string;
}

/**
 * @title DistributionStateManager
 * @notice Tracks pause/resume state for scheduled distributions.
 * @dev In-memory state map.  When persistence is needed, swap the Map for a
 *      repository-backed implementation.  The interface remains the same.
 */
export class DistributionStateManager {
  private readonly states = new Map<string, DistributionPauseRecord>();
  private readonly metrics?: MetricsCollector;
  private readonly logger: Logger;

  constructor(options?: { metrics?: MetricsCollector; logger?: Logger }) {
    this.metrics = options?.metrics;
    this.logger = options?.logger ?? globalLogger;
  }

  pause(distributionId: string, reason: string, actor: string): void {
    if (!reason || reason.trim().length === 0) {
      throw Errors.badRequest('Reason is required to pause a distribution');
    }
    const existing = this.states.get(distributionId);
    if (existing && existing.state === 'paused') {
      throw Errors.conflict(`Distribution ${distributionId} is already paused`);
    }
    this.states.set(distributionId, {
      state: 'paused',
      reason,
      pausedAt: new Date(),
      pausedBy: actor,
    });
    this.logger.info('Distribution paused', { distributionId, reason, actor });
  }

  resume(distributionId: string, actor: string): DistributionPauseRecord | undefined {
    const record = this.states.get(distributionId);
    if (!record || record.state !== 'paused') {
      return undefined;
    }
    const pausedMs = Date.now() - record.pausedAt.getTime();
    try {
      this.metrics?.recordHistogram('distribution.paused_seconds', pausedMs / 1000, {
        distribution_id: distributionId,
      });
    } catch (metricsErr) {
      this.logger.warn('Failed to emit distribution.paused_seconds metric', {
        distributionId,
        error: metricsErr instanceof Error ? metricsErr.message : String(metricsErr),
      });
    }
    record.state = 'resumed';
    record.resumedAt = new Date();
    record.resumedBy = actor;
    this.logger.info('Distribution resumed', {
      distributionId,
      pausedMs,
      actor,
    });
    return record;
  }

  getState(distributionId: string): DistributionPauseRecord | undefined {
    return this.states.get(distributionId);
  }

  isPaused(distributionId: string): boolean {
    const record = this.states.get(distributionId);
    return record?.state === 'paused';
  }
}
