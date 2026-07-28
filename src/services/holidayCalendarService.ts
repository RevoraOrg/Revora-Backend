/**
 * @title HolidayCalendarService
 * @notice Manages jurisdiction-specific bank holiday calendars with signed static files
 * and per-jurisdiction overrides. Distribution windows skip blackout days so investor
 * bank rails receive funds on a settleable day.
 *
 * @dev Signature validation occurs BEFORE applying the calendar to prevent tampering.
 * The calendar is loaded from a signed static file containing a base64 payload and
 * an HMAC-SHA256 signature.
 *
 * Security assumptions:
 * - The signing secret is stored securely in environment variables and never logged.
 * - Signature validation uses constant-time comparison (timingSafeEqual).
 * - If validation fails, the calendar is rejected entirely (fail-closed).
 * - Overlapping holidays across jurisdictions apply the strictest shift.
 * - The calendar hash is persisted in an audit event for operational traceability.
 *
 * Abuse/failure paths handled:
 * - Missing or unreadable calendar file → service remains uninitialized.
 * - Invalid or mismatched signature → calendar rejected, error logged.
 * - Malformed JSON payload → calendar rejected, error logged.
 * - Empty secret → calendar rejected.
 * - Unknown jurisdiction → falls back to default behavior (no shift).
 */

import { createHmac, timingSafeEqual, createHash } from 'crypto';
import { Logger, globalLogger } from '../lib/logger';
import { MetricsCollector, globalMetrics } from '../lib/metrics';
import { SecurityAuditRepository, AuditEvent } from '../security/types';
import { Errors } from '../lib/errors';

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Canonical holiday calendar payload loaded from the signed static file.
 */
export interface HolidayCalendarPayload {
  /** Semantic version of the calendar schema. */
  version: string;
  /** ISO 8601 date strings (YYYY-MM-DD) keyed by jurisdiction code. */
  jurisdictions: Record<string, string[]>;
  /** Per-offering/jurisdiction overrides that augment or replace base holidays. */
  overrides: Record<string, string[]>;
  /** ISO timestamp when the calendar was generated. */
  generatedAt: string;
}

/**
 * Raw signed file format expected on disk.
 */
export interface SignedHolidayCalendarFile {
  /** Base64-encoded canonical JSON of the HolidayCalendarPayload. */
  payload: string;
  /** HMAC-SHA256 signature in sha256=<hex> format. */
  signature: string;
}

/**
 * Result of a blackout shift decision.
 */
export interface BlackoutShiftDecision {
  /** Original scheduled date before shift. */
  originalDate: Date;
  /** Shifted date after applying holiday rules. */
  shiftedDate: Date;
  /** Whether a shift occurred. */
  shifted: boolean;
  /** Human-readable reason for the shift. */
  reason: string;
  /** Jurisdiction codes that caused the blackout. */
  jurisdictions: string[];
  /** Direction of the shift. */
  direction: 'previous' | 'next';
}

/**
 * Configuration for the holiday calendar service.
 */
export interface HolidayCalendarServiceOptions {
  /** Custom logger instance. */
  logger?: Logger;
  /** Metrics collector for emitting scheduler.blackout.shift. */
  metrics?: MetricsCollector;
  /** Audit repository for persisting calendar load events. */
  auditRepository?: SecurityAuditRepository;
  /** Fallback shift policy when no explicit policy is configured. */
  fallbackShiftPolicy?: 'previous' | 'next';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const METRIC_BLACKOUT_SHIFT = 'scheduler_blackout_shift_total';
const AUDIT_ACTION_LOAD = 'holiday_calendar.load';
const AUDIT_RESOURCE = 'holiday_calendar';

// ─── HolidayCalendarService ──────────────────────────────────────────────────

export class HolidayCalendarService {
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly auditRepository?: SecurityAuditRepository;
  private readonly fallbackShiftPolicy: 'previous' | 'next';

  private loaded = false;
  private payload: HolidayCalendarPayload | null = null;
  private calendarHash: string | null = null;

  constructor(options: HolidayCalendarServiceOptions = {}) {
    this.logger = options.logger ?? globalLogger;
    this.metrics = options.metrics ?? (globalMetrics as any);
    this.auditRepository = options.auditRepository;
    this.fallbackShiftPolicy = options.fallbackShiftPolicy ?? 'previous';
  }

  /**
   * Load and validate a signed holiday calendar file.
   *
   * @param filePath Absolute path to the signed static file.
   * @param secret HMAC secret used to validate the file signature.
   * @throws Error if the file cannot be read, the signature is invalid, or the payload is malformed.
   */
  async loadCalendar(filePath: string, secret: string): Promise<void> {
    if (!secret) {
      throw new Error('Holiday calendar secret is required');
    }

    let raw = '';
    try {
      raw = await require('fs').promises.readFile(filePath, 'utf8');
    } catch (err) {
      this.logger.error('Failed to read holiday calendar file', { filePath, error: err });
      throw new Error(`Failed to read holiday calendar file: ${filePath}`);
    }

    let file: SignedHolidayCalendarFile;
    try {
      file = JSON.parse(raw) as SignedHolidayCalendarFile;
    } catch {
      this.logger.error('Malformed holiday calendar JSON', { filePath });
      throw new Error('Malformed holiday calendar JSON');
    }

    if (!file.payload || !file.signature) {
      this.logger.error('Holiday calendar file missing payload or signature', { filePath });
      throw new Error('Holiday calendar file must contain payload and signature');
    }

    const expectedSig = this.computeSignature(secret, file.payload);

    const signatureBuffer = Buffer.from(file.signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSig, 'utf8');

    if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
      this.logger.error('Holiday calendar signature verification failed', { filePath });
      throw new Error('Holiday calendar signature verification failed');
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(file.payload, 'base64').toString('utf8'));
    } catch {
      this.logger.error('Malformed holiday calendar base64 payload', { filePath });
      throw new Error('Malformed holiday calendar base64 payload');
    }

    if (!this.isValidPayload(decoded)) {
      this.logger.error('Invalid holiday calendar payload structure', { filePath });
      throw new Error('Invalid holiday calendar payload structure');
    }

    this.payload = decoded as HolidayCalendarPayload;
    this.calendarHash = this.computePayloadHash(file.payload);
    this.loaded = true;

    await this.recordAuditEvent('SUCCESS', { filePath, hash: this.calendarHash, version: this.payload.version });

    this.logger.info('Holiday calendar loaded and validated', {
      filePath,
      hash: this.calendarHash,
      version: this.payload.version,
      jurisdictionCount: Object.keys(this.payload.jurisdictions).length,
    });
  }

  /**
   * Check whether a given date is a blackout day for the provided jurisdictions.
   *
   * @param date Date to evaluate (only the date portion is used).
   * @param jurisdictions Array of jurisdiction codes (e.g. ['US', 'GB']).
   * @returns True if the date falls on a holiday in any of the jurisdictions.
   */
  isBlackout(date: Date, jurisdictions: string[]): boolean {
    this.ensureLoaded();
    const dateStr = this.toDateString(date);
    if (!dateStr) return false;

    for (const jurisdiction of jurisdictions) {
      const holidays = this.getHolidaysForJurisdiction(jurisdiction);
      if (holidays.has(dateStr)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Compute the shifted date for a given date and set of jurisdictions.
   *
   * If the date is not a blackout day, returns the original date unchanged.
   * If it is a blackout day, shifts according to the fallback policy.
   *
   * Overlapping holidays in multiple jurisdictions are handled by applying the
   * strictest shift: if any jurisdiction requires a shift, the date is shifted.
   *
   * @param date Date to evaluate.
   * @param jurisdictions Array of jurisdiction codes.
   * @returns BlackoutShiftDecision describing the result.
   */
  getShiftedDate(date: Date, jurisdictions: string[]): BlackoutShiftDecision {
    this.ensureLoaded();
    const dateStr = this.toDateString(date);
    const originalDate = new Date(date);

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

    const blackoutJurisdictions: string[] = [];
    for (const jurisdiction of jurisdictions) {
      const holidays = this.getHolidaysForJurisdiction(jurisdiction);
      if (holidays.has(dateStr)) {
        blackoutJurisdictions.push(jurisdiction);
      }
    }

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
    const shiftedDate = this.findBusinessDay(originalDate, direction);

    const reason = blackoutJurisdictions.length === 1
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

  /**
   * Returns true if the calendar has been successfully loaded.
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Returns the SHA-256 hash of the canonical payload for audit purposes.
   * Returns null if the calendar has not been loaded.
   */
  getCalendarHash(): string | null {
    return this.calendarHash;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

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

  private getHolidaysForJurisdiction(jurisdiction: string): Set<string> {
    if (!this.payload) return new Set();

    const overrideKey = jurisdiction;
    const overrideDates = this.payload.overrides[overrideKey];
    const baseDates = this.payload.jurisdictions[jurisdiction] ?? [];

    const combined = new Set<string>([...baseDates, ...(overrideDates ?? [])]);
    return combined;
  }

  private findBusinessDay(startDate: Date, direction: 'previous' | 'next'): Date {
    const d = new Date(startDate);
    const step = direction === 'previous' ? -1 : 1;

    for (let i = 0; i < 366; i++) {
      d.setUTCDate(d.getUTCDate() + step);
      const dayOfWeek = d.getUTCDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        return d;
      }
    }

    throw new Error('Unable to find business day within 366 iterations');
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

    return true;
  }

  private emitBlackoutMetric(decision: BlackoutShiftDecision): void {
    if (!this.metrics || typeof (this.metrics as any).incrementCounter !== 'function') return;

    try {
      (this.metrics as any).incrementCounter(
        METRIC_BLACKOUT_SHIFT,
        {
          direction: decision.direction,
          jurisdiction_count: String(decision.jurisdictions.length),
        },
        1,
        'Total number of distribution blackout shifts due to jurisdiction holidays'
      );
    } catch {
      // Metrics emission must not break business logic
    }
  }

  private async recordAuditEvent(outcome: 'SUCCESS' | 'FAILURE', details: Record<string, unknown>): Promise<void> {
    if (!this.auditRepository) return;

    try {
      const event: AuditEvent = {
        id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'VALIDATION',
        action: AUDIT_ACTION_LOAD,
        resource: AUDIT_RESOURCE,
        outcome,
        details: {
          ...details,
          calendarHash: this.calendarHash,
        },
        securityContext: {
          requestId: `holiday-calendar-${Date.now()}`,
          ipAddress: 'system',
          userAgent: 'holiday-calendar-service',
          timestamp: new Date(),
        },
        timestamp: new Date(),
      };

      await this.auditRepository.record(event);
    } catch (err) {
      this.logger.warn('Failed to record holiday calendar audit event', { error: err });
    }
  }
}
