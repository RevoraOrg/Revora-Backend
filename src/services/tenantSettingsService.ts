import { TenantSettingsRepository, TenantSettingsRow } from '../db/repositories/tenantSettingsRepository';
import { SecurityAuditRepository } from '../security/types';
import {
  FxQuorumConfig,
  FxQuorumTenantConfig,
} from './fxQuorumEvaluator';

export interface PendingThresholdChange {
  id: string;
  proposed_threshold: number;
  proposer_id: string;
  reason: string;
  created_at: string;
  status: 'pending' | 'approved' | 'rejected';
}

/**
 * Pending FX quorum threshold change (dual-control, mirrors
 * `PendingThresholdChange`). Carries the proposed `k`, `tolerance` and
 * optional `reference` together so the approver sees the full proposal.
 */
export interface PendingFxQuorumChange {
  id: string;
  proposed_k: number;
  proposed_tolerance: number;
  proposed_reference?: 'median' | 'mean';
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
  // ─── FX Quorum threshold configuration (dual-control, audited) ──────────────

  /**
   * Reads the tenant's stored FX quorum override, or null if none is configured.
   */
  async getRawFxQuorumConfig(tenantId: string): Promise<FxQuorumTenantConfig | null> {
    const row = await this.tenantSettingsRepo.findByTenantId(tenantId);
    const q = row?.settings?.fx_quorum as FxQuorumTenantConfig | undefined;
    if (!q || typeof q.k !== 'number' || typeof q.tolerance !== 'number') return null;
    return { k: q.k, tolerance: q.tolerance, reference: q.reference };
  }

  /**
   * Proposes a new FX quorum configuration (Step 1 of dual control).
   * Persists a pending change and writes an audit event. The proposer may not
   * approve their own change later (collusion guard, enforced on approval).
   */
  async proposeFxQuorumConfig(
    tenantId: string,
    k: number,
    tolerance: number,
    proposerUserId: string,
    reason: string,
    reference?: 'median' | 'mean',
  ): Promise<PendingFxQuorumChange> {
    validateFxQuorumProposal(k, tolerance);
    if (!reason || reason.trim().length === 0) {
      throw new Error('Change reason is required for dual-control approval');
    }

    const row = await this.tenantSettingsRepo.findByTenantId(tenantId);
    const currentSettings = (row?.settings ?? {}) as Record<string, unknown>;

    const pending: PendingFxQuorumChange = {
      id: `fxq_req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      proposed_k: k,
      proposed_tolerance: tolerance,
      proposed_reference: reference,
      proposer_id: proposerUserId,
      reason,
      created_at: new Date().toISOString(),
      status: 'pending',
    };

    const updatedSettings = {
      ...currentSettings,
      pending_fx_quorum_change: pending,
    };

    await this.tenantSettingsRepo.upsertSettings(tenantId, updatedSettings);

    await this.auditRepo.record({
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type: 'VALIDATION',
      userId: proposerUserId,
      action: 'fx_quorum_config_change_proposed',
      resource: `tenant_settings/${tenantId}`,
      outcome: 'SUCCESS',
      details: {
        tenant_id: tenantId,
        proposed_k: k,
        proposed_tolerance: tolerance,
        proposed_reference: reference,
        proposer_id: proposerUserId,
        reason,
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

    return pending;
  }

  /**
   * Approves a pending FX quorum change (Step 2 of dual control).
   * Enforces the collusion guard (proposer != approver) and writes an audit
   * event capturing before/after values.
   */
  async approveFxQuorumConfig(
    tenantId: string,
    approverUserId: string,
  ): Promise<TenantSettingsRow> {
    const row = await this.tenantSettingsRepo.findByTenantId(tenantId);
    const pending = row?.settings?.pending_fx_quorum_change as PendingFxQuorumChange | undefined;
    if (!pending || pending.status !== 'pending') {
      throw new Error('No pending FX quorum change request found for tenant');
    }

    if (pending.proposer_id === approverUserId) {
      throw new Error('Dual-control security violation: proposer cannot approve their own FX quorum change');
    }

    const previous = await this.getRawFxQuorumConfig(tenantId);
    const previousK = previous?.k ?? DEFAULT_FX_QUORUM_CONFIG.k;
    const previousTolerance = previous?.tolerance ?? DEFAULT_FX_QUORUM_CONFIG.tolerance;

    const updatedSettings = {
      ...row.settings,
      fx_quorum: {
        k: pending.proposed_k,
        tolerance: pending.proposed_tolerance,
        reference: pending.proposed_reference,
      },
      pending_fx_quorum_change: null,
    };

    const updatedRow = await this.tenantSettingsRepo.upsertSettings(tenantId, updatedSettings);

    await this.auditRepo.record({
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type: 'VALIDATION',
      userId: approverUserId,
      action: 'fx_quorum_config_change_approved',
      resource: `tenant_settings/${tenantId}`,
      outcome: 'SUCCESS',
      details: {
        tenant_id: tenantId,
        previous_k: previousK,
        previous_tolerance: previousTolerance,
        new_k: pending.proposed_k,
        new_tolerance: pending.proposed_tolerance,
        new_reference: pending.proposed_reference,
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
   * Rejects a pending FX quorum change request.
   */
  async rejectFxQuorumConfig(
    tenantId: string,
    rejecterUserId: string,
    reason: string,
  ): Promise<TenantSettingsRow> {
    const row = await this.tenantSettingsRepo.findByTenantId(tenantId);
    const pending = row?.settings?.pending_fx_quorum_change as PendingFxQuorumChange | undefined;
    if (!pending || pending.status !== 'pending') {
      throw new Error('No pending FX quorum change request found for tenant');
    }

    const updatedSettings = {
      ...row.settings,
      pending_fx_quorum_change: null,
    };

    const updatedRow = await this.tenantSettingsRepo.upsertSettings(tenantId, updatedSettings);

    await this.auditRepo.record({
      id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type: 'VALIDATION',
      userId: rejecterUserId,
      action: 'fx_quorum_config_change_rejected',
      resource: `tenant_settings/${tenantId}`,
      outcome: 'SUCCESS',
      details: {
        tenant_id: tenantId,
        proposed_k: pending.proposed_k,
        proposed_tolerance: pending.proposed_tolerance,
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

// ─── FX Quorum threshold configuration (dual-control, audited) ────────────────

/**
 * Platform-wide default quorum configuration. Tenants may override `k`,
 * `tolerance` and `reference` via dual-control proposal/approval; the remaining
 * fields are enforced by the platform.
 */
export const DEFAULT_FX_QUORUM_CONFIG: FxQuorumConfig = {
  k: 2,
  tolerance: 0.005, // 0.5 %
  reference: 'median',
  minValidProviders: 2,
  allowReducedQuorum: true,
};

/** Maximum `k` a tenant may request (defensive upper bound against misconfiguration). */
const FX_QUORUM_MAX_K = 20;

/** Maximum `tolerance` a tenant may request (100 %). */
const FX_QUORUM_MAX_TOLERANCE = 1;

function validateFxQuorumProposal(k: number, tolerance: number): void {
  if (!Number.isInteger(k) || k < 1 || k > FX_QUORUM_MAX_K) {
    throw new Error(`FX quorum k must be an integer between 1 and ${FX_QUORUM_MAX_K}`);
  }
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) ||
      tolerance < 0 || tolerance > FX_QUORUM_MAX_TOLERANCE) {
    throw new Error(`FX quorum tolerance must be a number between 0 and ${FX_QUORUM_MAX_TOLERANCE}`);
  }
}

/**
 * Resolves a tenant's effective FX quorum configuration, merging any tenant
 * override on top of the platform defaults. Returns an {@link FxQuorumConfig}
 * ready to construct an {@link FxQuorumEvaluator}.
 */
export async function resolveFxQuorumConfig(
  service: TenantSettingsService,
  tenantId: string,
  defaults: FxQuorumConfig = DEFAULT_FX_QUORUM_CONFIG,
): Promise<FxQuorumConfig> {
  const tenant = await service.getRawFxQuorumConfig(tenantId);
  if (!tenant) return { ...defaults };
  return {
    ...defaults,
    k: tenant.k,
    tolerance: tenant.tolerance,
    reference: tenant.reference ?? defaults.reference,
  };
}
