/**
 * Tests for the tenant-configurable FX quorum thresholds (dual-control +
 * audited) added to TenantSettingsService.
 *
 * Coverage:
 * - getRawFxQuorumConfig returns null when unset, and the stored override otherwise
 * - proposeFxQuorumConfig validates input, persists a pending change, audits it
 * - approveFxQuorumConfig enforces the collusion guard, applies the change, audits it
 * - rejectFxQuorumConfig clears the pending change and audits the rejection
 * - resolveFxQuorumConfig merges the tenant override on top of platform defaults
 */

import {
  TenantSettingsService,
  DEFAULT_FX_QUORUM_CONFIG,
  resolveFxQuorumConfig,
} from './tenantSettingsService';
import { SecurityAuditRepository, TenantSettingsRow } from '../security/types';

class FakeRepo {
  private rows = new Map<string, TenantSettingsRow>();

  async findByTenantId(tenantId: string): Promise<TenantSettingsRow | null> {
    return this.rows.get(tenantId) ?? null;
  }

  async upsertSettings(tenantId: string, settings: Record<string, unknown>): Promise<TenantSettingsRow> {
    const existing = this.rows.get(tenantId);
    const row: TenantSettingsRow = {
      tenant_id: tenantId,
      settings,
      created_at: existing?.created_at ?? new Date(),
      updated_at: new Date(),
    };
    this.rows.set(tenantId, row);
    return row;
  }
}

class FakeAudit implements SecurityAuditRepository {
  public records: any[] = [];
  async record(event: any): Promise<void> {
    this.records.push(event);
  }
  async findByUserId() { return []; }
  async findBySessionId() { return []; }
  async findSecurityViolations() { return []; }
}

function makeService(initialSettings?: Record<string, unknown>): { svc: TenantSettingsService; repo: FakeRepo; audit: FakeAudit } {
  const repo = new FakeRepo();
  const audit = new FakeAudit();
  if (initialSettings) {
    repo.rows.set('tenant-1', {
      tenant_id: 'tenant-1',
      settings: initialSettings,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
  const svc = new TenantSettingsService(repo as any, audit as any);
  return { svc, repo, audit };
}

describe('TenantSettingsService FX quorum config', () => {
  it('getRawFxQuorumConfig returns null when nothing is configured', async () => {
    const { svc } = makeService();
    expect(await svc.getRawFxQuorumConfig('tenant-1')).toBeNull();
  });

  it('getRawFxQuorumConfig returns the stored override', async () => {
    const { svc } = makeService({ fx_quorum: { k: 3, tolerance: 0.01, reference: 'mean' } });
    const cfg = await svc.getRawFxQuorumConfig('tenant-1');
    expect(cfg).toEqual({ k: 3, tolerance: 0.01, reference: 'mean' });
  });

  it('proposeFxQuorumConfig persists a pending change and audits it', async () => {
    const { svc, audit } = makeService();
    const pending = await svc.proposeFxQuorumConfig('tenant-1', 3, 0.01, 'alice', 'tighten guard');
    expect(pending.status).toBe('pending');
    expect(pending.proposed_k).toBe(3);
    expect(pending.proposed_tolerance).toBe(0.01);
    expect(pending.proposer_id).toBe('alice');

    const row = await (svc as any).tenantSettingsRepo.findByTenantId('tenant-1');
    expect(row.settings.pending_fx_quorum_change).toBeDefined();

    const proposed = audit.records.find((r) => r.action === 'fx_quorum_config_change_proposed');
    expect(proposed).toBeDefined();
    expect(proposed.outcome).toBe('SUCCESS');
    expect(proposed.details.tenant_id).toBe('tenant-1');
  });

  it('proposeFxQuorumConfig rejects invalid k and tolerance', async () => {
    const { svc } = makeService();
    await expect(svc.proposeFxQuorumConfig('tenant-1', 0, 0.01, 'alice', 'x')).rejects.toThrow();
    await expect(svc.proposeFxQuorumConfig('tenant-1', 2, -1, 'alice', 'x')).rejects.toThrow();
    await expect(svc.proposeFxQuorumConfig('tenant-1', 2, 0.01, 'alice', '')).rejects.toThrow(/reason is required/);
  });

  it('approveFxQuorumConfig applies the change, clears pending, and audits (with collusion guard)', async () => {
    const { svc, audit } = makeService();
    await svc.proposeFxQuorumConfig('tenant-1', 4, 0.02, 'alice', 'widen guard');

    // Same person cannot approve their own proposal.
    await expect(svc.approveFxQuorumConfig('tenant-1', 'alice')).rejects.toThrow(/cannot approve their own/);

    // A different approver can.
    const row = await svc.approveFxQuorumConfig('tenant-1', 'bob');
    expect(row.settings.fx_quorum).toEqual({ k: 4, tolerance: 0.02, reference: undefined });
    expect(row.settings.pending_fx_quorum_change).toBeNull();

    const approved = audit.records.find((r) => r.action === 'fx_quorum_config_change_approved');
    expect(approved).toBeDefined();
    expect(approved.details.approver_id).toBe('bob');
    expect(approved.details.proposer_id).toBe('alice');
  });

  it('approveFxQuorumConfig throws when there is no pending change', async () => {
    const { svc } = makeService();
    await expect(svc.approveFxQuorumConfig('tenant-1', 'bob')).rejects.toThrow(/No pending/);
  });

  it('rejectFxQuorumConfig clears the pending change and audits the rejection', async () => {
    const { svc, audit } = makeService();
    await svc.proposeFxQuorumConfig('tenant-1', 4, 0.02, 'alice', 'widen guard');
    const row = await svc.rejectFxQuorumConfig('tenant-1', 'bob', 'not needed');
    expect(row.settings.pending_fx_quorum_change).toBeNull();

    const rejected = audit.records.find((r) => r.action === 'fx_quorum_config_change_rejected');
    expect(rejected).toBeDefined();
    expect(rejected.details.rejection_reason).toBe('not needed');
  });

  it('resolveFxQuorumConfig merges tenant override over platform defaults', async () => {
    const { svc } = makeService({ fx_quorum: { k: 5, tolerance: 0.002 } });
    const resolved = await resolveFxQuorumConfig(svc, 'tenant-1');
    expect(resolved.k).toBe(5);
    expect(resolved.tolerance).toBe(0.002);
    // platform defaults preserved for fields not overridden by the tenant
    expect(resolved.reference).toBe(DEFAULT_FX_QUORUM_CONFIG.reference);
    expect(resolved.minValidProviders).toBe(DEFAULT_FX_QUORUM_CONFIG.minValidProviders);
  });

  it('resolveFxQuorumConfig falls back to platform defaults when no override exists', async () => {
    const { svc } = makeService();
    const resolved = await resolveFxQuorumConfig(svc, 'tenant-1');
    expect(resolved).toEqual(DEFAULT_FX_QUORUM_CONFIG);
  });
});
