import { Pool } from 'pg';
import { DisputeSLARepository, DisputeSLARecord, SLABurnReportRow } from '../db/repositories/disputeSLARepository';
import { NotificationRepository } from '../db/repositories/notificationRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import {
  getSLADuration,
  getJurisdictionSLAConfig,
  isTerminalState,
  isAutoEscalateEnabled,
} from '../config/disputeSLAConfig';
import { Logger, globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';
import * as crypto from 'crypto';

/**
 * Dispute SLA Service
 *
 * Manages SLA timers for dispute states, including:
 * - Starting new SLA timers on state transitions
 * - Pausing/resuming SLA timers (paused time is excluded)
 * - Automatic escalation when SLA is breached
 * - SLA burn report generation (CSV export)
 *
 * Security assumptions:
 * - SLA calculations are deterministic and auditable
 * - Paused time is accurately tracked and immutable once recorded
 * - Escalation notifications are only created for unresolved disputes
 * - Report data is sanitized to prevent CSV injection
 */

export interface DisputeSLAServiceDeps {
  db: Pool;
  notificationRepo?: NotificationRepository;
  auditLogRepo?: AuditLogRepository;
  logger?: Logger;
}

export interface StartSLATimerInput {
  disputeId: string;
  jurisdiction: string;
  state: string;
  assignedUserId?: string | null;
}

export interface TransitionSLATimerInput {
  disputeId: string;
  newState: string;
  newJurisdiction?: string;
}

export interface SLABurnReportInput {
  startDate: Date;
  endDate: Date;
  jurisdiction?: string;
}

export interface SLABurnReportCSV {
  csv: string;
  filename: string;
  rowCount: number;
}

export class DisputeSLAService {
  private slaRepo: DisputeSLARepository;
  private notificationRepo: NotificationRepository | null;
  private auditLogRepo: AuditLogRepository | null;
  private logger: Logger;

  constructor(deps: DisputeSLAServiceDeps) {
    this.slaRepo = new DisputeSLARepository(deps.db);
    this.notificationRepo = deps.notificationRepo ?? null;
    this.auditLogRepo = deps.auditLogRepo ?? null;
    this.logger = deps.logger ?? globalLogger;
  }

  /**
   * Start a new SLA timer for a dispute.
   * Automatically resolves any previously active SLA timer.
   */
  async startTimer(input: StartSLATimerInput): Promise<DisputeSLARecord> {
    const { disputeId, jurisdiction, state, assignedUserId } = input;

    // Reject terminal states at the service level
    if (isTerminalState(state)) {
      throw Errors.badRequest(
        `Cannot start SLA timer for terminal state: ${state}. Use transitionState instead.`,
      );
    }

    // Resolve any active timer first
    const existing = await this.slaRepo.findActiveByDisputeId(disputeId);
    if (existing) {
      const elapsed = this.calculateElapsedMs(existing);
      const breached = elapsed > existing.sla_duration_hours * 3600 * 1000;

      await this.slaRepo.update(existing.id, {
        resolved_at: new Date(),
        escalated: breached,
        escalated_at: breached ? new Date() : null,
      });

      this.logger.info('Resolved previous SLA timer', {
        disputeId,
        previousState: existing.state,
        elapsedMs: elapsed,
        breached,
      });
    }

    const slaDurationHours = getSLADuration(jurisdiction, state);

    const record = await this.slaRepo.create({
      dispute_id: disputeId,
      jurisdiction,
      state,
      sla_duration_hours: slaDurationHours,
      assigned_user_id: assignedUserId ?? null,
    });

    this.logger.info('SLA timer started', {
      disputeId,
      jurisdiction,
      state,
      slaDurationHours,
    });

    await this.createAuditLog({
      userId: assignedUserId ?? undefined,
      action: 'dispute_sla_timer_started',
      resource: `dispute:${disputeId}`,
      details: JSON.stringify({ jurisdiction, state, slaDurationHours }),
    });

    // Check if SLA is already breached (e.g., overdue transfer)
    if (slaDurationHours <= 0 && !isTerminalState(state)) {
      await this.escalate(record);
    }

    return record;
  }

  /**
   * Transition a dispute to a new state, creating a new SLA timer.
   * If the new state is terminal (resolved/closed), the SLA is completed.
   */
  async transitionState(input: TransitionSLATimerInput): Promise<DisputeSLARecord | null> {
    const { disputeId, newState, newJurisdiction } = input;

    const existing = await this.slaRepo.findActiveByDisputeId(disputeId);

    if (!existing) {
      this.logger.warn('No active SLA timer found for transition', {
        disputeId,
        newState,
      });
      return null;
    }

    // If transitioning to the same state, no-op
    if (existing.state === newState && !newJurisdiction) {
      return existing;
    }

    const jurisdiction = newJurisdiction ?? existing.jurisdiction;

    if (isTerminalState(newState)) {
      // Resolve the timer
      const record = await this.slaRepo.update(existing.id, {
        resolved_at: new Date(),
        state: newState,
      });

      this.logger.info('SLA timer completed', {
        disputeId,
        finalState: newState,
        elapsedMs: this.calculateElapsedMs(record),
      });

      await this.createAuditLog({
        userId: existing.assigned_user_id ?? undefined,
        action: 'dispute_sla_timer_resolved',
        resource: `dispute:${disputeId}`,
        details: JSON.stringify({ newState, jurisdiction }),
      });

      return record;
    }

    // Resolve current timer
    const elapsed = this.calculateElapsedMs(existing);
    const breached = elapsed > existing.sla_duration_hours * 3600 * 1000;

    await this.slaRepo.update(existing.id, {
      resolved_at: new Date(),
      escalated: breached,
      escalated_at: breached ? new Date() : null,
    });

    if (breached) {
      this.logger.warn('SLA breached during transition', {
        disputeId,
        state: existing.state,
        elapsedMs: elapsed,
        slaDurationMs: existing.sla_duration_hours * 3600 * 1000,
      });
    }

    // Start new timer for new state
    const slaDurationHours = getSLADuration(jurisdiction, newState);

    const record = await this.slaRepo.create({
      dispute_id: disputeId,
      jurisdiction,
      state: newState,
      sla_duration_hours: slaDurationHours,
      assigned_user_id: existing.assigned_user_id,
    });

    this.logger.info('SLA timer transitioned', {
      disputeId,
      fromState: existing.state,
      toState: newState,
      jurisdiction,
      slaDurationHours,
    });

    await this.createAuditLog({
      userId: existing.assigned_user_id ?? undefined,
      action: 'dispute_sla_timer_transitioned',
      resource: `dispute:${disputeId}`,
      details: JSON.stringify({
        fromState: existing.state,
        toState: newState,
        jurisdiction,
        slaDurationHours,
      }),
    });

    return record;
  }

  /**
   * Pause an SLA timer for a dispute.
   * Paused disputes do not consume SLA time.
   */
  async pauseTimer(disputeId: string): Promise<DisputeSLARecord> {
    const existing = await this.slaRepo.findActiveByDisputeId(disputeId);

    if (!existing) {
      throw Errors.badRequest(`No active SLA timer found for dispute: ${disputeId}`);
    }

    if (existing.paused_at) {
      throw Errors.badRequest(`SLA timer is already paused for dispute: ${disputeId}`);
    }

    const record = await this.slaRepo.update(existing.id, {
      paused_at: new Date(),
    });

    this.logger.info('SLA timer paused', { disputeId, state: record.state });

    await this.createAuditLog({
      userId: existing.assigned_user_id ?? undefined,
      action: 'dispute_sla_timer_paused',
      resource: `dispute:${disputeId}`,
      details: JSON.stringify({ state: record.state }),
    });

    return record;
  }

  /**
   * Resume a paused SLA timer.
   * Accumulates the paused duration so it is excluded from SLA calculations.
   */
  async resumeTimer(disputeId: string): Promise<DisputeSLARecord> {
    const existing = await this.slaRepo.findActiveByDisputeId(disputeId);

    if (!existing) {
      throw Errors.badRequest(`No active SLA timer found for dispute: ${disputeId}`);
    }

    if (!existing.paused_at) {
      throw Errors.badRequest(`SLA timer is not paused for dispute: ${disputeId}`);
    }

    const pausedDurationMs = Date.now() - existing.paused_at.getTime();
    const newTotalPausedMs = existing.total_paused_ms + pausedDurationMs;

    const record = await this.slaRepo.update(existing.id, {
      paused_at: null,
      total_paused_ms: newTotalPausedMs,
    });

    this.logger.info('SLA timer resumed', {
      disputeId,
      state: record.state,
      pausedDurationMs,
      totalPausedMs: newTotalPausedMs,
    });

    await this.createAuditLog({
      userId: existing.assigned_user_id ?? undefined,
      action: 'dispute_sla_timer_resumed',
      resource: `dispute:${disputeId}`,
      details: JSON.stringify({
        state: record.state,
        pausedDurationMs,
        totalPausedMs: newTotalPausedMs,
      }),
    });

    // Check if the timer is now overdue after resume
    await this.checkAndEscalate(record);

    return record;
  }

  /**
   * Check all overdue SLA timers and escalate them.
   * This can be called by a cron job or scheduled task.
   */
  async escalateOverdue(): Promise<DisputeSLARecord[]> {
    const overdue = await this.slaRepo.findOverdueNonEscalated();
    const escalated: DisputeSLARecord[] = [];

    for (const record of overdue) {
      if (isAutoEscalateEnabled(record.jurisdiction)) {
        const escalatedRecord = await this.escalate(record);
        escalated.push(escalatedRecord);
      }
    }

    return escalated;
  }

  /**
   * Escalate a specific SLA record.
   * Creates a notification and audit log entry.
   */
  async escalate(record: DisputeSLARecord): Promise<DisputeSLARecord> {
    if (record.escalated) {
      return record;
    }

    const updated = await this.slaRepo.update(record.id, {
      escalated: true,
      escalated_at: new Date(),
    });

    // Create notification for the assigned user
    if (this.notificationRepo && record.assigned_user_id) {
      try {
        await this.notificationRepo.create({
          user_id: record.assigned_user_id,
          type: 'dispute_sla_breach',
          title: 'Dispute SLA Breach',
          body: `Dispute ${record.dispute_id} has breached the SLA for state "${record.state}" (${record.jurisdiction} jurisdiction). ` +
            `SLA duration: ${record.sla_duration_hours}h. Please take immediate action.`,
        });
      } catch (error) {
        this.logger.error('Failed to create SLA breach notification', {
          disputeId: record.dispute_id,
          error,
        });
      }
    }

    await this.createAuditLog({
      userId: record.assigned_user_id ?? undefined,
      action: 'dispute_sla_breach_escalated',
      resource: `dispute:${record.dispute_id}`,
      details: JSON.stringify({
        jurisdiction: record.jurisdiction,
        state: record.state,
        slaDurationHours: record.sla_duration_hours,
        elapsedMs: this.calculateElapsedMs(updated),
      }),
    });

    this.logger.warn('SLA escalated', {
      disputeId: record.dispute_id,
      jurisdiction: record.jurisdiction,
      state: record.state,
    });

    return updated;
  }

  /**
   * Check if a record is overdue and escalate if auto-escalation is enabled.
   */
  private async checkAndEscalate(record: DisputeSLARecord): Promise<void> {
    if (record.escalated || record.resolved_at) return;
    if (isTerminalState(record.state)) return;

    const elapsed = this.calculateElapsedMs(record);
    const slaDurationMs = record.sla_duration_hours * 3600 * 1000;

    if (elapsed > slaDurationMs && isAutoEscalateEnabled(record.jurisdiction)) {
      await this.escalate(record);
    }
  }

  /**
   * Calculate elapsed time in milliseconds, excluding paused time.
   */
  calculateElapsedMs(record: DisputeSLARecord): number {
    const now = record.paused_at
      ? record.paused_at.getTime()
      : record.resolved_at
        ? record.resolved_at.getTime()
        : Date.now();

    const grossElapsed = now - record.started_at.getTime();
    return Math.max(0, grossElapsed - record.total_paused_ms);
  }

  /**
   * Generate SLA burn report for a date range.
   */
  async generateBurnReport(input: SLABurnReportInput): Promise<SLABurnReportRow[]> {
    return this.slaRepo.getSLABurnReport(
      input.startDate,
      input.endDate,
      input.jurisdiction,
    );
  }

  /**
   * Export SLA burn report as signed CSV.
   * Includes CSV injection prevention and an HMAC-SHA256 signature for integrity verification.
   */
  async exportBurnReportCSV(input: SLABurnReportInput): Promise<SLABurnReportCSV> {
    const rows = await this.generateBurnReport(input);

    const headers = [
      'Dispute ID',
      'Jurisdiction',
      'State',
      'SLA Duration (Hours)',
      'Elapsed (Hours)',
      'Remaining (Hours)',
      'Breached',
      'Escalated',
      'Paused',
      'Started At',
      'Resolved At',
      'Assigned User ID',
    ];

    const csvRows = rows.map((row) => {
      const cells = [
        row.dispute_id,
        row.jurisdiction,
        row.state,
        String(row.sla_duration_hours),
        String(row.elapsed_hours),
        String(row.remaining_hours),
        String(row.is_breached),
        String(row.escalated),
        String(row.paused),
        row.started_at.toISOString(),
        row.resolved_at ? row.resolved_at.toISOString() : '',
        row.assigned_user_id ?? '',
      ];

      return cells.map(sanitizeCSVCell).join(',');
    });

    const dataSection = [headers.join(','), ...csvRows].join('\n');

    // Sign the report body with HMAC-SHA256 for integrity verification
    const signingSecret = process.env.SLA_REPORT_SIGNING_SECRET ?? 'revora-sla-default-secret';
    const signature = crypto
      .createHmac('sha256', signingSecret)
      .update(dataSection)
      .digest('hex');

    // Prepend signature as a comment line for verification
    const csv = `# HMAC-SHA256:${signature}\n${dataSection}`;

    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `sla-burn-report-${dateStr}.csv`;

    return { csv, filename, rowCount: rows.length };
  }

  /**
   * Create an audit log entry.
   */
  private async createAuditLog(input: {
    userId?: string;
    action: string;
    resource: string;
    details: string;
  }): Promise<void> {
    if (!this.auditLogRepo) return;

    try {
      await this.auditLogRepo.createAuditLog({
        user_id: input.userId ?? null,
        action: input.action,
        resource: input.resource,
        details: input.details,
      });
    } catch (error) {
      this.logger.error('Failed to create audit log', {
        action: input.action,
        error,
      });
    }
  }
}

/**
 * Sanitize a CSV cell value to prevent CSV injection (formula injection).
 * Cells starting with =, +, -, or @ are prefixed with a single quote.
 */
export function sanitizeCSVCell(value: string): string {
  if (value === '' || value === undefined || value === null) return '';

  // Always wrap in double quotes for safety
  let escaped = value.replace(/"/g, '""');

  // Prevent CSV formula injection
  if (/^[=+\-@]/.test(escaped)) {
    escaped = `'${escaped}`;
  }

  return `"${escaped}"`;
}
