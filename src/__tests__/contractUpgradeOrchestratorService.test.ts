import { ContractUpgradeOrchestratorService } from '../services/contractUpgradeOrchestratorService';

const mockPool = {
  query: jest.fn(),
} as any;

const mockAuditLogRepo = {
  createAuditLog: jest.fn().mockResolvedValue(undefined),
} as any;

const mockTenantSettingsRepo = {
  findByTenantId: jest.fn(),
} as any;

describe('ContractUpgradeOrchestratorService', () => {
  let service: ContractUpgradeOrchestratorService;
  const mockKeypair = {
    publicKey: jest.fn().mockReturnValue('G-FAKE-KEY'),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ContractUpgradeOrchestratorService(
      mockPool,
      mockAuditLogRepo,
      mockTenantSettingsRepo,
      mockKeypair,
    );
  });

  it('creates an upgrade when the attestation is valid and builder identity is authorized', async () => {
    mockTenantSettingsRepo.findByTenantId.mockResolvedValue({
      tenant_id: 'tenant-1',
      settings: {
        builder_identities: ['builder-1'],
      },
    });

    const returnedRow = {
      id: 'upgrade-1',
      tenant_id: 'tenant-1',
      contract_id: 'contract-1',
      target_code_id: 'deadbeef',
      status: 'pending',
      proposed_by: 'user-1',
      approved_by: null,
      simulate_result: null,
      simulate_ok: null,
      transaction_hash: null,
      failure_reason: null,
      created_at: new Date().toISOString(),
      approved_at: null,
      applied_at: null,
      updated_at: new Date().toISOString(),
    };

    mockPool.query.mockResolvedValue({ rows: [returnedRow] });

    const result = await service.createUpgrade({
      tenant_id: 'tenant-1',
      contract_id: 'contract-1',
      target_code_id: 'deadbeef',
      proposed_by: 'user-1',
      attestation: {
        builder: { id: 'builder-1' },
        predicateType: 'https://slsa.dev/provenance/v0.2',
        subject: [{ digest: { sha256: 'deadbeef' } }],
      },
    });

    expect(result.id).toBe('upgrade-1');
    expect(mockTenantSettingsRepo.findByTenantId).toHaveBeenCalledWith('tenant-1');
    expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'upgrade.attestation.verified' }));
    expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'CONTRACT_UPGRADE_PROPOSED' }));
  });

  it('throws not found when tenant settings are missing', async () => {
    mockTenantSettingsRepo.findByTenantId.mockResolvedValue(null);

    await expect(
      service.createUpgrade({
        tenant_id: 'tenant-x',
        contract_id: 'contract-1',
        target_code_id: 'deadbeef',
        proposed_by: 'user-1',
        attestation: { builder: { id: 'builder-1' }, subject: [{ digest: { sha256: 'deadbeef' } }] },
      }),
    ).rejects.toThrow("Tenant settings for 'tenant-x' not found");
  });

  it('rejects attestation from unauthorized builder identities', async () => {
    mockTenantSettingsRepo.findByTenantId.mockResolvedValue({
      tenant_id: 'tenant-1',
      settings: {
        builder_identities: ['builder-1'],
      },
    });

    await expect(
      service.createUpgrade({
        tenant_id: 'tenant-1',
        contract_id: 'contract-1',
        target_code_id: 'deadbeef',
        proposed_by: 'user-1',
        attestation: { builder: { id: 'bad-builder' }, subject: [{ digest: { sha256: 'deadbeef' } }] },
      }),
    ).rejects.toThrow('Attestation builder identity is not authorized for tenant');
  });

  it('rejects when tenant has no builder_identities configured', async () => {
    mockTenantSettingsRepo.findByTenantId.mockResolvedValue({
      tenant_id: 'tenant-1',
      settings: {},
    });

    await expect(
      service.createUpgrade({
        tenant_id: 'tenant-1',
        contract_id: 'contract-1',
        target_code_id: 'deadbeef',
        proposed_by: 'user-1',
        attestation: { builder: { id: 'builder-1' }, subject: [{ digest: { sha256: 'deadbeef' } }] },
      }),
    ).rejects.toThrow("Tenant 'tenant-1' has no configured builder identities");
  });
});
