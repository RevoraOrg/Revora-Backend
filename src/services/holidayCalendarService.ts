/**
 * @title HolidayCalendarService
 * @notice Jurisdiction-aware bank-holiday blackout calendar for the distribution
 *         scheduler, loaded from a signed static file with per-jurisdiction
 *         overrides and a fallback shift policy.
 *
 * @dev The service answers two questions for the scheduler:
 *        1. `isBlackout(date, jurisdictions)` – is this a blackout day?
 *        2. `getShiftedDate(date, jurisdictions)` – which settleable day should
 *           a distribution window scheduled for `date` actually run on?
 *
 *      Shift semantics (issue #664):
 *        - A blackout day is shifted to the previous or next business day per
 *          the configured fallback policy.
 *        - The shifted date must itself be a *settleable* day: it must not fall
 *          on a weekend AND must not be a blackout for ANY of the jurisdictions
 *          that caused the original shift (overlapping holidays across
 *          jurisdictions apply the strictest shift — we keep shifting until the
 *          candidate day is clear for all affected jurisdictions).
 *        - Per-jurisdiction overrides extend the base holiday set so regional
 *          calendars (e.g. `US-NY`) can be layered on top of country calendars.
 *
 *      The calendar is distributed as a signed static file so updates are
 *      auditable: `loadCalendar()` validates the HMAC-SHA256 signature with a
 *      constant-time comparison BEFORE the payload is applied (fail-closed),
 *      computes a SHA-256 hash of the canonical payload, and persists the hash
 *      in a `holiday_calendar.load` audit event.
 *
 * Security assumptions:
 *  - The signing secret lives in the environment (`HOLIDAY_CALENDAR_SECRET`)
 *    and is never logged.
 *  - Signature comparison uses `crypto.timingSafeEqual` on same-length buffers.
 *  - A missing file, bad signature, malformed payload, or empty secret rejects
 *    the whole calendar — the service stays uninitialised and the scheduler
 *    falls back to its current behaviour (no shifting).
 *  - Unknown jurisdictions are ignored (no shift) so calendar roll-outs do not
 *    break schedulers for unlisted regions.
 *
 * @see ../../docs/holiday-calendar-blackouts.md
 */

import { createHmac, timingSafeEqual, createHash } from 'crypto';
import { Logger, globalLogger } from '../lib/logger';
import { MetricsCollector, globalMetrics } from '../lib/metrics';
import { SecurityAuditRepository, AuditEvent } from '../security/types';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface HolidayCalendarPayload {
  /** Semantic version of the calendar schema. */
  version: string;
  /** ISO date strings (YYYY-MM-DD) keyed by jurisdiction code. */
  jurisdictions: Record<string, string[]>;
  /** Per-jurisdiction overrides that augment the base holiday set. */
  overrides: Record<string, string[]>;
  /** ISO timestamp when the calendar was generated. */
  generatedAt: string;
}

export interface SignedHolidayCalendarFile {
  /** Base64-encoded canonical JSON of the HolidayCalendarPayload. */
  payload: string;
  /** HMAC-SHA256 signature in `sha256=<hex>` format. */
  signature: string;
}

export type ShiftDirection = 'previous' | 'next';

export interface BlackoutShiftDecision {
  /** Originally scheduled date before any shift. */
  originalDate: Date;
  /** Settleable date after applying blackout rules. */
  shiftedDate: Date;
  /** Whether a shift occurred. */
  shifted: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Jurisdiction codes that caused the blackout. */
  jurisdictions: string[];
  /** Direction the shift moved in. */
  direction: ShiftDirection;
}

export interface HolidayCalendarServiceOptions {
  logger?: Logger;
  metrics?: MetricsCollector;
  auditRepository?: SecurityAuditRepository;
  /** Fallback shift policy when no explicit policy is configured. */
  fallbackShiftPolicy?: ShiftDirection;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const METRIC_BLACKOUT_SHIFT = 'scheduler.blackout.shift';
const AUDIT_ACTION_LOAD = 'holiday_calendar.load';
const AUDIT_RESOURCE = 'holiday_calendar';
const MAX_SHIFT_ITERATIONS = 366;

// ─── Service ─────────────────────────────────────────────────────────────────

export class HolidayCalendarService {
  private readonly logger: Logger;
  private readonly metrics?: MetricsCollector;
  private readonly auditRepository?: SecurityAuditRepository;
  private readonly fallbackShiftPolicy: ShiftDirection;

  private loaded = false;
  private payload: HolidayCalendarPayload | null = null;
  private calendarHash: string | null = null;

  constructor(options: HolidayCalendarServiceOptions = {}) {
    this.logger = options.logger ?? globalLogger;
    this.metrics = options.metrics ?? globalMetrics;
    this.auditRepository = options.auditRepository;
    this.fallbackShiftPolicy = options.fallbackShiftPolicy ?? 'previous';
  }

  /**
   * @notice Load and validate a signed holiday calendar file.
   *
   * @dev Signature validation occurs BEFORE the payload is applied.  On any
   *      validation failure the calendar is rejected in its entirety and the
   *      service remains uninitialised (fail-closed).
   *
   * @param filePath Absolute path to the signed static calendar file.
   * @param secret   HMAC secret used to sign the file.
   * @throws         If the file is unreadable, unsigned, tampered, or malformed.
   */
  async loadCalendar(filePath: string, secret: string): Promise<void> {
    if (!secret) {
      throw new Error('Holiday calendar secret is required');
    }

    const raw = await this.readFile(filePath);
    let file: SignedHolidayCalendarFile;
    try {
      file = JSON.parse(raw) as SignedHolidayCalendarFile;
    } catch {
      this.logger.error('Malformed holiday calendar JSON', { filePath });
      throw new Error('Malformed holiday calendar JSON');
    }

    if (!file.payload || typeof file.payload !== 'string' || !file.signature) {
      this.logger.error('Holiday calendar file missing payload or signature', { filePath });
      throw new Error('Holiday calendar file must contain payload and signature');
    }

    const expectedSig = this.computeSignature(secret, file.payload);
    const receivedBuf = Buffer.from(file.signature, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    if (receivedBuf.length !== expectedBuf.length || !timingSafeEqual(receivedBuf, expectedBuf)) {
      this.logger.error('Holiday calendar signature verification failed', { filePath });
      throw new Error('Holiday calendar signature verification failed');
    }

    const decoded = this.decodePayload(file.payload);
    if (!this.isValidPayload(decoded)) {
      this.logger.error('Invalid holiday calendar payload structure', { filePath });
      throw new Error('Invalid holiday calendar payload structure');
    }

    this.payload = decoded;
    this.calendarHash = this.computePayloadHash(file.payload);
    this.loaded = true;

    await this.recordAuditEvent('SUCCESS', {
      filePath,
      hash: this.calendarHash,
      version: this.payload.version,
    });

    this.logger.info('Holiday calendar loaded and validated', {
      filePath,
      hash: this.calendarHash,
      version: this.payload.version,
      jurisdictionCount: Object.keys(this.payload.jurisdictions).length,
    });
  }

  /**
   * @notice Check whether `date` is a blackout day in any of the jurisdictions.
   */
  isBlackout(date: Date, jurisdictions: string[]): boolean {
    this.ensureLoaded();
    const dateStr = this.toDateString(date);
    if (!dateStr) return false;

    return jurisdictions.some((jurisdiction) =>
      this.getHolidaysForJurisdiction(jurisdiction).has(dateStr),
    );
  }

  /**
   * @notice Compute the settleable shifted date for a scheduled distribution day.
   *
   * @dev If `date` is not a blackout day the original date is returned
   *      unchanged.  Otherwise the date is shifted in the `fallbackShiftPolicy`
   *      direction until a day that is neither a weekend nor a blackout for any
   *      of the jurisdictions that caused the shift is found.  Overlapping
   *      holidays across jurisdictions therefore apply the strictest shift —
   *      the scheduler only ever lands on a day that settles for every affected
   *      jurisdiction.
   *
   * @param date          Scheduled distribution date.
   * @param jurisdictions Jurisdiction codes that govern the distribution.
   */
  getShiftedDate(date: Date, jurisdictions: string[]): BlackoutShiftDecision {
    this.ensureLoaded();
    const originalDate = new Date(date);
    const dateStr = this.toDateString(date);

    if (!dateStr) {
      return {
        originalDate,
        shiftedDate: originalDate,
        shifted: false,
        reason: 'Invalid date',
        jurisdictions: [],
        direction: this.fallbackShiftPolicy,
      };
    }

    const blackoutJurisdictions = jurisdictions.filter((jurisdiction) =>
      this.getHolidaysForJurisdiction(jurisdiction).has(dateStr),
    );

    if (blackoutJurisdictions.length === 0) {
      return {
        originalDate,
        shiftedDate: originalDate,
        shifted: false,
        reason: 'No blackout',
        jurisdictions: [],
        direction: this.fallbackShiftPolicy,
      };
    }

    const direction = this.fallbackShiftPolicy;
    // Strictest shift: the settleable day must be clear for EVERY jurisdiction
    // in the distribution (not only the ones that blacked out the original day).
    const shiftedDate = this.findSettleableDay(originalDate, direction, jurisdictions);

    const reason =
      blackoutJurisdictions.length === 1
        ? `Blackout in jurisdiction ${blackoutJurisdictions[0]}`
        : `Blackout across ${blackoutJurisdictions.length} jurisdictions: ${blackoutJurisdictions.join(', ')}`;

    const decision: BlackoutShiftDecision = {
      originalDate,
      shiftedDate,
      shifted: true,
      reason,
      jurisdictions: blackoutJurisdictions,
      direction,
    };

    this.emitBlackoutMetric(decision);
    return decision;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** SHA-256 hash of the canonical payload, or null before first load. */
  getCalendarHash(): string | null {
    return this.calendarHash;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async readFile(filePath: string): Promise<string> {
    try {
      const fs = await import('fs');
      return await fs.promises.readFile(filePath, 'utf8');
    } catch (err) {
      this.logger.error('Failed to read holiday calendar file', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(`Failed to read holiday calendar file: ${filePath}`);
    }
  }

  private decodePayload(base64Payload: string): unknown {
    try {
      return JSON.parse(Buffer.from(base64Payload, 'base64').toString('utf8'));
    } catch {
      this.logger.error('Malformed holiday calendar base64 payload');
      throw new Error('Malformed holiday calendar base64 payload');
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded || !this.payload) {
      throw new Error('Holiday calendar has not been loaded. Call loadCalendar() first.');
    }
  }

  private toDateString(date: Date): string | null {
    if (Number.isNaN(date.getTime())) return null;
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /** Base holidays plus any per-jurisdiction override dates. */
  private getHolidaysForJurisdiction(jurisdiction: string): Set<string> {
    if (!this.payload) return new Set();
    const base = this.payload.jurisdictions[jurisdiction] ?? [];
    const override = this.payload.overrides[jurisdiction] ?? [];
    return new Set<string>([...base, ...override]);
  }

  /**
   * Walk from `startDate` in `direction` until a day that is a weekday and not
   * a blackout for any of the distribution's jurisdictions is found.  This is
   * the "strictest shift" rule: overlapping holidays keep the scheduler moving
   * until every jurisdiction in the distribution can settle on the same day.
   */
  private findSettleableDay(
    startDate: Date,
    direction: ShiftDirection,
    affectedJurisdictions: string[],
  ): Date {
    const step = direction === 'previous' ? -1 : 1;
    const cursor = new Date(startDate);

    for (let i = 0; i < MAX_SHIFT_ITERATIONS; i++) {
      cursor.setUTCDate(cursor.getUTCDate() + step);
      const dayOfWeek = cursor.getUTCDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) continue;

      const candidate = this.toDateString(cursor);
      const stillBlackout = affectedJurisdictions.some((jurisdiction) => {
        if (!candidate) return false;
        return this.getHolidaysForJurisdiction(jurisdiction).has(candidate);
      });
      if (stillBlackout) continue;

      return new Date(cursor);
    }

    throw new Error('Unable to find a settleable day within the shift horizon');
  }

  private computeSignature(secret: string, base64Payload: string): string {
    const hmac = createHmac('sha256', secret);
    hmac.update(base64Payload);
    return `sha256=${hmac.digest('hex')}`;
  }

  private computePayloadHash(base64Payload: string): string {
    return createHash('sha256').update(base64Payload).digest('hex');
  }

  private isValidPayload(obj: unknown): obj is HolidayCalendarPayload {
    if (!obj || typeof obj !== 'object') return false;
    const record = obj as Record<string, unknown>;
    if (typeof record.version !== 'string') return false;
    if (typeof record.generatedAt !== 'string') return false;
    if (typeof record.jurisdictions !== 'object' || record.jurisdictions === null) return false;
    if (typeof record.overrides !== 'object' || record.overrides === null) return false;

    const jurisdictions = record.jurisdictions as Record<string, unknown>;
    const overrides = record.overrides as Record<string, unknown>;
    return (
      Object.values(jurisdictions).every((v) => Array.isArray(v) && v.every((d) => typeof d === 'string')) &&
      Object.values(overrides).every((v) => Array.isArray(v) && v.every((d) => typeof d === 'string'))
    );
  }

  private emitBlackoutMetric(decision: BlackoutShiftDecision): void {
    try {
      this.metrics?.incrementCounter(
        METRIC_BLACKOUT_SHIFT,
        {
          direction: decision.direction,
          jurisdiction_count: String(decision.jurisdictions.length),
        },
        1,
        'Total number of distribution blackout shifts due to jurisdiction holidays',
      );
    } catch {
      // Metric emission must never break the scheduling decision.
    }
  }

  private async recordAuditEvent(
    outcome: 'SUCCESS' | 'FAILURE',
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditRepository) return;

    const event: AuditEvent = {
      id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'VALIDATION',
      action: AUDIT_ACTION_LOAD,
      resource: AUDIT_RESOURCE,
      outcome,
      details: { ...details, calendarHash: this.calendarHash },
      securityContext: {
        requestId: `holiday-calendar-${Date.now()}`,
        ipAddress: 'system',
        userAgent: 'holiday-calendar-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    };

    try {
      await this.auditRepository.record(event);
    } catch (err) {
      this.logger.warn('Failed to record holiday calendar audit event', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
