import { TenantSettingsService } from '../tenantSettingsService';
import { TenantSettingsRepository, TenantSettingsRow } from '../../db/repositories/tenantSettingsRepository';
import { SecurityAuditRepository, AuditEvent } from '../../security/types';

class MockTenantSettingsRepository {
  private store = new Map<string, TenantSettingsRow>();

  async findByTenantId(tenantId: string): Promise<TenantSettingsRow | null> {
    return this.store.get(tenantId) ?? null;
  }

  async upsertSettings(tenantId: string, settings: Record<string, unknown>): Promise<TenantSettingsRow> {
    const row: TenantSettingsRow = {
      tenant_id: tenantId,
      settings,
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.store.set(tenantId, row);
    return row;
  }
}

describe('TenantSettingsService - Dual-Control Sanctions Threshold Tuning', () => {
  let service: TenantSettingsService;
  let mockRepo: MockTenantSettingsRepository;
  let mockAuditRepo: jest.Mocked<Pick<SecurityAuditRepository, 'record'>>;

  beforeEach(() => {
    mockRepo = new MockTenantSettingsRepository();
    mockAuditRepo = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    service = new TenantSettingsService(mockRepo as unknown as TenantSettingsRepository, mockAuditRepo as unknown as SecurityAuditRepository);
  });

  it('returns default threshold 0.85 when no custom setting is present', async () => {
    const threshold = await service.getSanctionsThreshold('tenant_abc');
    expect(threshold).toBe(0.85);
  });

  it('allows proposing a valid threshold and records audit event', async () => {
    const proposal = await service.proposeSanctionsThreshold(
      'tenant_abc',
      0.80,
      'user_proposer',
      'Tune threshold for transliteration accuracy'
    );

    expect(proposal.proposed_threshold).toBe(0.80);
    expect(proposal.proposer_id).toBe('user_proposer');
    expect(proposal.status).toBe('pending');

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sanctions_threshold_change_proposed',
        userId: 'user_proposer',
        details: expect.objectContaining({
          tenant_id: 'tenant_abc',
          proposed_threshold: 0.80,
        }),
      })
    );
  });

  it('validates threshold boundaries and reason', async () => {
    await expect(
      service.proposeSanctionsThreshold('tenant_abc', 1.5, 'user_1', 'reason')
    ).rejects.toThrow('between 0.0 and 1.0');

    await expect(
      service.proposeSanctionsThreshold('tenant_abc', -0.1, 'user_1', 'reason')
    ).rejects.toThrow('between 0.0 and 1.0');

    await expect(
      service.proposeSanctionsThreshold('tenant_abc', 0.80, 'user_1', '')
    ).rejects.toThrow('reason is required');
  });

  it('blocks self-approval by the proposer (dual-control collusion guard)', async () => {
    await service.proposeSanctionsThreshold('tenant_abc', 0.80, 'user_proposer', 'Tuning');

    await expect(
      service.approveSanctionsThreshold('tenant_abc', 'user_proposer')
    ).rejects.toThrow(/Dual-control security violation/i);
  });

  it('applies new threshold when approved by a distinct second user', async () => {
    await service.proposeSanctionsThreshold('tenant_abc', 0.80, 'user_proposer', 'Tuning');

    const updatedRow = await service.approveSanctionsThreshold('tenant_abc', 'user_approver');

    expect(updatedRow.settings.sanctions_threshold).toBe(0.80);
    expect(updatedRow.settings.pending_threshold_change).toBeNull();

    const currentThreshold = await service.getSanctionsThreshold('tenant_abc');
    expect(currentThreshold).toBe(0.80);

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sanctions_threshold_change_approved',
        userId: 'user_approver',
        details: expect.objectContaining({
          tenant_id: 'tenant_abc',
          new_threshold: 0.80,
          proposer_id: 'user_proposer',
          approver_id: 'user_approver',
        }),
      })
    );
  });

  it('allows rejecting a pending threshold proposal', async () => {
    await service.proposeSanctionsThreshold('tenant_abc', 0.80, 'user_proposer', 'Tuning');

    const updatedRow = await service.rejectSanctionsThreshold('tenant_abc', 'user_rejecter', 'Threshold too low');

    expect(updatedRow.settings.pending_threshold_change).toBeNull();
    const currentThreshold = await service.getSanctionsThreshold('tenant_abc');
    expect(currentThreshold).toBe(0.85);

    expect(mockAuditRepo.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sanctions_threshold_change_rejected',
        userId: 'user_rejecter',
        details: expect.objectContaining({
          tenant_id: 'tenant_abc',
          rejecter_id: 'user_rejecter',
          rejection_reason: 'Threshold too low',
        }),
      })
    );
  });
});
