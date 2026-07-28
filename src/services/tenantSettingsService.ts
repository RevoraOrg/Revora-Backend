import { TenantSettingsRepository, TenantSettingsRow } from '../db/repositories/tenantSettingsRepository';
import { SecurityAuditRepository } from '../security/types';

export interface PendingThresholdChange {
  id: string;
  proposed_threshold: number;
  proposer_id: string;
  reason: string;
  created_at: string;
  status: 'pending' | 'approved' | 'rejected';
}

export class TenantSettingsService {
  constructor(
    private readonly tenantSettingsRepo: TenantSettingsRepository,
    private readonly auditRepo: SecurityAuditRepository
  ) {}

  /**
   * Gets the tenant's Jaro-Winkler sanctions threshold (defaulting to 0.85).
   */
  async getSanctionsThreshold(tenantId: string): Promise<number> {
    const row = await this.tenantSettingsRepo.findByTenantId(tenantId);
    if (!row || !row.settings) return 0.85;
    const threshold = row.settings.sanctions_threshold;
    return typeof threshold === 'number' ? threshold : 0.85;
  }

  /**
   * Proposes a new Jaro-Winkler sanctions threshold (Step 1 of dual control).
   */
  async proposeSanctionsThreshold(
    tenantId: string,
    proposedThreshold: number,
    proposerUserId: string,
    reason: string
  ): Promise<PendingThresholdChange> {
    if (proposedThreshold < 0 || proposedThreshold > 1) {
      throw new Error('Jaro-Winkler threshold must be between 0.0 and 1.0');
    }
    if (!reason || reason.trim().length === 0) {
      throw new Error('Change reason is required for dual-control approval');
    }

    const row = await this.tenantSettingsRepo.findByTenantId(tenantId);
    const currentSettings = row?.settings ?? {};

    const pendingChange: PendingThresholdChange = {
      id: `thresh_req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      proposed_threshold: proposedThreshold,
      proposer_id: proposerUserId,
      reason,
      created_at: new Date().toISOString(),
      status: 'pending',
    };

    const updatedSettings = {
      ...currentSettings,
      pending_threshold_change: pendingChange,
    };

    await this.tenantSettingsRepo.upsertSettings(tenantId, updatedSettings);

    await this.auditRepo.record({
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type: 'VALIDATION',
      userId: proposerUserId,
      action: 'sanctions_threshold_change_proposed',
      resource: `tenant_settings/${tenantId}`,
      outcome: 'SUCCESS',
      details: {
        tenant_id: tenantId,
        proposed_threshold: proposedThreshold,
        proposer_id: proposerUserId,
        reason,
        request_id: pendingChange.id,
      },
      securityContext: {
        requestId: `req_${Date.now()}`,
        ipAddress: 'system',
        userAgent: 'tenant-settings-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    });

    return pendingChange;
  }

  /**
   * Approves a pending sanctions threshold change (Step 2 of dual control).
   * Enforces that the approver is distinct from the proposer (collusion guard).
   */
  async approveSanctionsThreshold(
    tenantId: string,
    approverUserId: string
  ): Promise<TenantSettingsRow> {
    const row = await this.tenantSettingsRepo.findByTenantId(tenantId);
    if (!row || !row.settings?.pending_threshold_change) {
      throw new Error('No pending threshold change request found for tenant');
    }

    const pending = row.settings.pending_threshold_change as PendingThresholdChange;
    if (pending.status !== 'pending') {
      throw new Error(`Threshold change request is already ${pending.status}`);
    }

    // Dual-control check: Proposer cannot approve their own request!
    if (pending.proposer_id === approverUserId) {
      throw new Error('Dual-control security violation: Proposer cannot approve their own threshold change request');
    }

    const previousThreshold = typeof row.settings.sanctions_threshold === 'number' ? row.settings.sanctions_threshold : 0.85;
    const newThreshold = pending.proposed_threshold;

    const updatedSettings = {
      ...row.settings,
      sanctions_threshold: newThreshold,
      pending_threshold_change: null, // Clear pending proposal
    };

    const updatedRow = await this.tenantSettingsRepo.upsertSettings(tenantId, updatedSettings);

    await this.auditRepo.record({
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type: 'VALIDATION',
      userId: approverUserId,
      action: 'sanctions_threshold_change_approved',
      resource: `tenant_settings/${tenantId}`,
      outcome: 'SUCCESS',
      details: {
        tenant_id: tenantId,
        previous_threshold: previousThreshold,
        new_threshold: newThreshold,
        proposer_id: pending.proposer_id,
        approver_id: approverUserId,
        request_id: pending.id,
      },
      securityContext: {
        requestId: `req_${Date.now()}`,
        ipAddress: 'system',
        userAgent: 'tenant-settings-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    });

    return updatedRow;
  }

  /**
   * Rejects a pending sanctions threshold change request.
   */
  async rejectSanctionsThreshold(
    tenantId: string,
    rejecterUserId: string,
    reason: string
  ): Promise<TenantSettingsRow> {
    const row = await this.tenantSettingsRepo.findByTenantId(tenantId);
    if (!row || !row.settings?.pending_threshold_change) {
      throw new Error('No pending threshold change request found for tenant');
    }

    const pending = row.settings.pending_threshold_change as PendingThresholdChange;
    const updatedSettings = {
      ...row.settings,
      pending_threshold_change: null,
    };

    const updatedRow = await this.tenantSettingsRepo.upsertSettings(tenantId, updatedSettings);

    await this.auditRepo.record({
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type: 'VALIDATION',
      userId: rejecterUserId,
      action: 'sanctions_threshold_change_rejected',
      resource: `tenant_settings/${tenantId}`,
      outcome: 'SUCCESS',
      details: {
        tenant_id: tenantId,
        proposed_threshold: pending.proposed_threshold,
        proposer_id: pending.proposer_id,
        rejecter_id: rejecterUserId,
        rejection_reason: reason,
        request_id: pending.id,
      },
      securityContext: {
        requestId: `req_${Date.now()}`,
        ipAddress: 'system',
        userAgent: 'tenant-settings-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    });

    return updatedRow;
  }
}
