import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import {
  RetentionLabel,
  RetentionLabelRepository,
} from '../db/repositories/retentionLabelRepository';
import { globalLogger } from '../lib/logger';

const PERIOD_ID_RE = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

export class RetentionLabelError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'INVALID_PERIOD'
      | 'ALREADY_ACTIVE'
      | 'NOT_ACTIVE'
      | 'PENDING_REQUIRED'
      | 'WRONG_PENDING'
      | 'DUAL_CONTROL'
      | 'NOT_FOUND',
  ) {
    super(message);
    this.name = 'RetentionLabelError';
  }
}

/**
 * Dual-controlled legal-hold labels for ledger/audit periods.
 *
 * Security assumptions:
 * - Propose and approve must be distinct admin identities (two-key rule).
 * - A released hold does not trigger an immediate purge; held rows re-enter
 *   eligibility only on the next scheduled purge cycle.
 */
export class RetentionLabelService {
  constructor(
    private readonly labels: RetentionLabelRepository,
    private readonly auditLogRepo?: AuditLogRepository,
  ) {}

  async get(periodId: string): Promise<RetentionLabel | null> {
    this.assertPeriodId(periodId);
    return this.labels.findByPeriodId(periodId);
  }

  async listActiveHolds(): Promise<RetentionLabel[]> {
    return this.labels.listActiveHolds();
  }

  async proposeLegalHold(input: {
    periodId: string;
    actorId: string;
    reason?: string;
  }): Promise<RetentionLabel> {
    this.assertPeriodId(input.periodId);
    const existing = await this.labels.findByPeriodId(input.periodId);
    if (existing?.legal_hold) {
      throw new RetentionLabelError(
        `Period ${input.periodId} already has an active legal hold`,
        'ALREADY_ACTIVE',
      );
    }

    const label = await this.labels.upsertProposeAdd({
      periodId: input.periodId,
      actorId: input.actorId,
      reason: input.reason,
    });

    await this.audit('RETENTION_LEGAL_HOLD_PROPOSED', input.actorId, input.periodId, {
      reason: input.reason ?? null,
    });

    return label;
  }

  async approveLegalHold(input: {
    periodId: string;
    actorId: string;
  }): Promise<RetentionLabel> {
    this.assertPeriodId(input.periodId);
    const existing = await this.labels.findByPeriodId(input.periodId);
    if (!existing) {
      throw new RetentionLabelError(`No retention label for period ${input.periodId}`, 'NOT_FOUND');
    }
    if (existing.pending_action !== 'add') {
      throw new RetentionLabelError(
        `Period ${input.periodId} has no pending legal-hold add to approve`,
        'WRONG_PENDING',
      );
    }
    if (!existing.pending_proposed_by) {
      throw new RetentionLabelError(
        `Period ${input.periodId} is missing propose metadata`,
        'PENDING_REQUIRED',
      );
    }
    if (existing.pending_proposed_by === input.actorId) {
      throw new RetentionLabelError(
        'Approver must differ from proposer (dual-control)',
        'DUAL_CONTROL',
      );
    }

    const label = await this.labels.approveAdd(input);
    await this.audit('RETENTION_LEGAL_HOLD_ACTIVATED', input.actorId, input.periodId, {
      proposed_by: existing.pending_proposed_by,
    });
    return label;
  }

  async proposeLegalHoldRelease(input: {
    periodId: string;
    actorId: string;
  }): Promise<RetentionLabel> {
    this.assertPeriodId(input.periodId);
    const existing = await this.labels.findByPeriodId(input.periodId);
    if (!existing) {
      throw new RetentionLabelError(`No retention label for period ${input.periodId}`, 'NOT_FOUND');
    }
    if (!existing.legal_hold) {
      throw new RetentionLabelError(
        `Period ${input.periodId} does not have an active legal hold`,
        'NOT_ACTIVE',
      );
    }

    const label = await this.labels.proposeRemove(input);
    await this.audit('RETENTION_LEGAL_HOLD_RELEASE_PROPOSED', input.actorId, input.periodId, {});
    return label;
  }

  async approveLegalHoldRelease(input: {
    periodId: string;
    actorId: string;
  }): Promise<RetentionLabel> {
    this.assertPeriodId(input.periodId);
    const existing = await this.labels.findByPeriodId(input.periodId);
    if (!existing) {
      throw new RetentionLabelError(`No retention label for period ${input.periodId}`, 'NOT_FOUND');
    }
    if (existing.pending_action !== 'remove') {
      throw new RetentionLabelError(
        `Period ${input.periodId} has no pending legal-hold release to approve`,
        'WRONG_PENDING',
      );
    }
    if (!existing.pending_proposed_by) {
      throw new RetentionLabelError(
        `Period ${input.periodId} is missing propose metadata`,
        'PENDING_REQUIRED',
      );
    }
    if (existing.pending_proposed_by === input.actorId) {
      throw new RetentionLabelError(
        'Approver must differ from proposer (dual-control)',
        'DUAL_CONTROL',
      );
    }

    const label = await this.labels.approveRemove(input);
    await this.audit('RETENTION_LEGAL_HOLD_RELEASED', input.actorId, input.periodId, {
      proposed_by: existing.pending_proposed_by,
      note: 'Rows re-enter purge eligibility on the next purge cycle only',
    });
    globalLogger.info('Legal hold released; purge eligibility deferred to next cycle', {
      periodId: input.periodId,
      actorId: input.actorId,
    });
    return label;
  }

  private assertPeriodId(periodId: string): void {
    if (!PERIOD_ID_RE.test(periodId)) {
      throw new RetentionLabelError(
        `Invalid period_id '${periodId}'; expected YYYY-MM`,
        'INVALID_PERIOD',
      );
    }
  }

  private async audit(
    action: string,
    actorId: string,
    periodId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditLogRepo) {
      return;
    }
    await this.auditLogRepo.createAuditLog({
      user_id: actorId,
      action,
      resource: `retention_label:${periodId}`,
      details: JSON.stringify(details),
    });
  }
}
