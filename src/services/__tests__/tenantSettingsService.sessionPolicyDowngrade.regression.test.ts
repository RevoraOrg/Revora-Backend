/**
 * @file tenantSettingsService.sessionPolicyDowngrade.regression.test.ts
 *
 * Regression test suite for Issue #1260:
 * "security(tenant-settings): every sanctions/FX-quorum settings write silently resets session_policy from strict to lax"
 *
 * Vulnerability:
 * TenantSettingsRepository.upsertSettings(tenantId, settings, sessionPolicy = 'lax') defaulted sessionPolicy to 'lax'.
 * TenantSettingsService called upsertSettings without passing the existing session policy across all six write operations:
 *   1. proposeSanctionsThreshold
 *   2. approveSanctionsThreshold
 *   3. rejectSanctionsThreshold
 *   4. proposeFxQuorumConfig
 *   5. approveFxQuorumConfig
 *   6. rejectFxQuorumConfig
 *
 * As a result, any tenant with session_policy = 'strict' had their policy silently downgraded to 'lax' whenever
 * a compliance officer proposed, approved, or rejected sanctions or FX quorum changes.
 *
 * Fix:
 * Split repository API into updateSettings(tenantId, settings) and setSessionPolicy(tenantId, policy).
 * All six service write operations now invoke updateSettings, which updates only settings without touching session_policy.
 *
 * This test suite demonstrates that the vulnerable implementation fails (downgrading 'strict' to 'lax')
 * and the fixed implementation passes (preserving 'strict' across all 6 write paths).
 */

import { TenantSettingsService } from '../tenantSettingsService';
import { TenantSettingsRepository, TenantSettingsRow } from '../../db/repositories/tenantSettingsRepository';
import { SecurityAuditRepository } from '../../security/types';

/**
 * Repository double that models both the vulnerable master contract (upsertSettings with defaulted lax policy)
 * and the secure fixed contract (updateSettings preserving existing session policy).
 */
class RegressionTestRepoDouble {
  public rows = new Map<string, TenantSettingsRow>();
  public updateSettingsCalls: Array<{ tenantId: string; settings: Record<string, unknown> }> = [];
  public upsertSettingsCalls: Array<{ tenantId: string; settings: Record<string, unknown>; sessionPolicy: string }> = [];

  async findByTenantId(tenantId: string): Promise<TenantSettingsRow | null> {
    return this.rows.get(tenantId) ?? null;
  }

  /**
   * The vulnerable master implementation: defaults sessionPolicy to 'lax',
   * silently overwriting 'strict' if the caller does not explicitly provide the policy.
   */
  async upsertSettings(
    tenantId: string,
    settings: Record<string, unknown>,
    sessionPolicy: 'lax' | 'strict' = 'lax',
  ): Promise<TenantSettingsRow> {
    this.upsertSettingsCalls.push({ tenantId, settings, sessionPolicy });
    const existing = this.rows.get(tenantId);
    const row: TenantSettingsRow = {
      tenant_id: tenantId,
      settings,
      session_policy: sessionPolicy, // Vulnerability: defaults to 'lax'!
      created_at: existing?.created_at ?? new Date(),
      updated_at: new Date(),
    };
    this.rows.set(tenantId, row);
    return row;
  }

  /**
   * The secure fixed implementation: updates settings only, preserving session_policy.
   */
  async updateSettings(
    tenantId: string,
    settings: Record<string, unknown>,
  ): Promise<TenantSettingsRow> {
    this.updateSettingsCalls.push({ tenantId, settings });
    const existing = this.rows.get(tenantId);
    const row: TenantSettingsRow = {
      tenant_id: tenantId,
      settings,
      session_policy: existing?.session_policy ?? 'lax', // Preserves existing policy!
      created_at: existing?.created_at ?? new Date(),
      updated_at: new Date(),
    };
    this.rows.set(tenantId, row);
    return row;
  }

  /**
   * Dedicated policy update method: modifies only session_policy without overwriting settings.
   */
  async setSessionPolicy(
    tenantId: string,
    policy: 'lax' | 'strict',
  ): Promise<TenantSettingsRow> {
    const existing = this.rows.get(tenantId);
    const row: TenantSettingsRow = {
      tenant_id: tenantId,
      settings: existing?.settings ?? {},
      session_policy: policy,
      created_at: existing?.created_at ?? new Date(),
      updated_at: new Date(),
    };
    this.rows.set(tenantId, row);
    return row;
  }
}

describe('Issue #1260 - Tenant Session Policy Downgrade Regression Tests', () => {
  const tenantId = 'tenant-strict-001';
  let repo: RegressionTestRepoDouble;
  let auditRepo: jest.Mocked<Pick<SecurityAuditRepository, 'record'>>;
  let service: TenantSettingsService;

  beforeEach(() => {
    repo = new RegressionTestRepoDouble();
    auditRepo = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    service = new TenantSettingsService(
      repo as unknown as TenantSettingsRepository,
      auditRepo as unknown as SecurityAuditRepository,
    );

    // Initial state: tenant explicitly configured with strict session policy
    repo.rows.set(tenantId, {
      tenant_id: tenantId,
      settings: {
        sanctions_threshold: 0.85,
        fx_quorum: { k: 2, tolerance: 0.005 },
      },
      session_policy: 'strict',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  describe('Sanctions Threshold Write Operations', () => {
    it('1. proposeSanctionsThreshold preserves existing strict session policy and calls updateSettings', async () => {
      await service.proposeSanctionsThreshold(tenantId, 0.90, 'proposer-1', 'Stricter threshold');

      const stored = await repo.findByTenantId(tenantId);
      expect(stored?.session_policy).toBe('strict');
      expect(stored?.settings.pending_threshold_change).toBeDefined();
      expect(repo.updateSettingsCalls.length).toBe(1);
      expect(repo.upsertSettingsCalls.length).toBe(0);
    });

    it('2. approveSanctionsThreshold preserves existing strict session policy and calls updateSettings', async () => {
      // Propose first
      await service.proposeSanctionsThreshold(tenantId, 0.90, 'proposer-1', 'Stricter threshold');
      expect(repo.updateSettingsCalls.length).toBe(1);

      // Approve with distinct user
      const updatedRow = await service.approveSanctionsThreshold(tenantId, 'approver-2');

      expect(updatedRow.session_policy).toBe('strict');
      const stored = await repo.findByTenantId(tenantId);
      expect(stored?.session_policy).toBe('strict');
      expect(stored?.settings.sanctions_threshold).toBe(0.90);
      expect(stored?.settings.pending_threshold_change).toBeNull();
      expect(repo.updateSettingsCalls.length).toBe(2);
      expect(repo.upsertSettingsCalls.length).toBe(0);
    });

    it('3. rejectSanctionsThreshold preserves existing strict session policy and calls updateSettings', async () => {
      // Propose first
      await service.proposeSanctionsThreshold(tenantId, 0.90, 'proposer-1', 'Stricter threshold');
      expect(repo.updateSettingsCalls.length).toBe(1);

      // Reject
      const updatedRow = await service.rejectSanctionsThreshold(tenantId, 'rejecter-3', 'Rejected by risk');

      expect(updatedRow.session_policy).toBe('strict');
      const stored = await repo.findByTenantId(tenantId);
      expect(stored?.session_policy).toBe('strict');
      expect(stored?.settings.pending_threshold_change).toBeNull();
      expect(repo.updateSettingsCalls.length).toBe(2);
      expect(repo.upsertSettingsCalls.length).toBe(0);
    });
  });

  describe('FX Quorum Write Operations', () => {
    it('4. proposeFxQuorumConfig preserves existing strict session policy and calls updateSettings', async () => {
      await service.proposeFxQuorumConfig(tenantId, 3, 0.01, 'proposer-1', 'Increase quorum size');

      const stored = await repo.findByTenantId(tenantId);
      expect(stored?.session_policy).toBe('strict');
      expect(stored?.settings.pending_fx_quorum_change).toBeDefined();
      expect(repo.updateSettingsCalls.length).toBe(1);
      expect(repo.upsertSettingsCalls.length).toBe(0);
    });

    it('5. approveFxQuorumConfig preserves existing strict session policy and calls updateSettings', async () => {
      // Propose first
      await service.proposeFxQuorumConfig(tenantId, 3, 0.01, 'proposer-1', 'Increase quorum size');
      expect(repo.updateSettingsCalls.length).toBe(1);

      // Approve with distinct user
      const updatedRow = await service.approveFxQuorumConfig(tenantId, 'approver-2');

      expect(updatedRow.session_policy).toBe('strict');
      const stored = await repo.findByTenantId(tenantId);
      expect(stored?.session_policy).toBe('strict');
      expect(stored?.settings.fx_quorum).toEqual({ k: 3, tolerance: 0.01, reference: undefined });
      expect(stored?.settings.pending_fx_quorum_change).toBeNull();
      expect(repo.updateSettingsCalls.length).toBe(2);
      expect(repo.upsertSettingsCalls.length).toBe(0);
    });

    it('6. rejectFxQuorumConfig preserves existing strict session policy and calls updateSettings', async () => {
      // Propose first
      await service.proposeFxQuorumConfig(tenantId, 3, 0.01, 'proposer-1', 'Increase quorum size');
      expect(repo.updateSettingsCalls.length).toBe(1);

      // Reject
      const updatedRow = await service.rejectFxQuorumConfig(tenantId, 'rejecter-3', 'Rejected by compliance');

      expect(updatedRow.session_policy).toBe('strict');
      const stored = await repo.findByTenantId(tenantId);
      expect(stored?.session_policy).toBe('strict');
      expect(stored?.settings.pending_fx_quorum_change).toBeNull();
      expect(repo.updateSettingsCalls.length).toBe(2);
      expect(repo.upsertSettingsCalls.length).toBe(0);
    });
  });

  describe('Full Dual-Control Lifecycle under Strict Session Policy', () => {
    it('maintains strict session policy across a complete series of interleaved compliance writes', async () => {
      // Step 1: Explicitly set policy to strict
      await repo.setSessionPolicy(tenantId, 'strict');
      expect((await repo.findByTenantId(tenantId))?.session_policy).toBe('strict');

      // Step 2: Propose sanctions threshold
      await service.proposeSanctionsThreshold(tenantId, 0.88, 'user-a', 'Adjusting threshold');
      expect((await repo.findByTenantId(tenantId))?.session_policy).toBe('strict');

      // Step 3: Approve sanctions threshold
      await service.approveSanctionsThreshold(tenantId, 'user-b');
      expect((await repo.findByTenantId(tenantId))?.session_policy).toBe('strict');

      // Step 4: Propose FX quorum config
      await service.proposeFxQuorumConfig(tenantId, 4, 0.02, 'user-a', 'Adjusting FX quorum');
      expect((await repo.findByTenantId(tenantId))?.session_policy).toBe('strict');

      // Step 5: Reject FX quorum config
      await service.rejectFxQuorumConfig(tenantId, 'user-c', 'Too permissive');
      expect((await repo.findByTenantId(tenantId))?.session_policy).toBe('strict');

      // Step 6: Propose sanctions threshold again
      await service.proposeSanctionsThreshold(tenantId, 0.70, 'user-a', 'Lowering threshold');
      expect((await repo.findByTenantId(tenantId))?.session_policy).toBe('strict');

      // Step 7: Reject sanctions threshold
      await service.rejectSanctionsThreshold(tenantId, 'user-c', 'Unacceptable risk');
      expect((await repo.findByTenantId(tenantId))?.session_policy).toBe('strict');

      // All 6 service writes used updateSettings and none used upsertSettings
      expect(repo.updateSettingsCalls.length).toBe(6);
      expect(repo.upsertSettingsCalls.length).toBe(0);
    });
  });
});
