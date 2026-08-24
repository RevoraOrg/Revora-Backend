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

  it('triggers an auto-rollback when health signals regress beyond thresholds and the rollback plan is approved', async () => {
    mockPool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'upgrade-2',
          tenant_id: 'tenant-1',
          contract_id: 'contract-1',
          target_code_id: 'deadbeef',
          status: 'applied',
          proposed_by: 'user-1',
          approved_by: 'approver-1',
          simulate_result: null,
          simulate_ok: true,
          transaction_hash: 'tx-hash',
          failure_reason: null,
          created_at: new Date().toISOString(),
          approved_at: new Date().toISOString(),
          applied_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const triggered = await service.monitorPostUpgradeHealth(
      'upgrade-2',
      'operator-1',
      { revert_rate: 0.18, failed_reconciliations: 12 },
      { id: 'rollback-plan-1', approved: true },
    );

    expect(triggered).toBe(true);
    expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'upgrade.autorollback.triggered',
    }));
  });

  it('does not trigger rollback when the rollback plan is not approved', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'upgrade-3',
        tenant_id: 'tenant-1',
        contract_id: 'contract-1',
        target_code_id: 'deadbeef',
        status: 'applied',
        proposed_by: 'user-1',
        approved_by: 'approver-1',
        simulate_result: null,
        simulate_ok: true,
        transaction_hash: 'tx-hash',
        failure_reason: null,
        created_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
        applied_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    });

    const triggered = await service.monitorPostUpgradeHealth(
      'upgrade-3',
      'operator-1',
      { revert_rate: 0.18, failed_reconciliations: 12 },
      { id: 'rollback-plan-2', approved: false },
    );

    expect(triggered).toBe(false);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('does not oscillate rollback when the upgrade is already marked failed', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'upgrade-4',
        tenant_id: 'tenant-1',
        contract_id: 'contract-1',
        target_code_id: 'deadbeef',
        status: 'failed',
        proposed_by: 'user-1',
        approved_by: 'approver-1',
        simulate_result: null,
        simulate_ok: true,
        transaction_hash: 'tx-hash',
        failure_reason: 'Auto-rollback triggered',
        created_at: new Date().toISOString(),
        approved_at: new Date().toISOString(),
        applied_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
    });

    const triggered = await service.monitorPostUpgradeHealth(
      'upgrade-4',
      'operator-1',
      { revert_rate: 0.18, failed_reconciliations: 12 },
      { id: 'rollback-plan-3', approved: true },
    );

    expect(triggered).toBe(false);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });
});

// ── Canary phase tests ────────────────────────────────────────────────────────

const approvedRow = {
  id: 'upgrade-canary-1',
  tenant_id: 'tenant-1',
  contract_id: 'contract-1',
  target_code_id: 'deadbeef',
  status: 'approved',
  proposed_by: 'user-1',
  approved_by: 'approver-1',
  simulate_result: null,
  simulate_ok: true,
  transaction_hash: null,
  failure_reason: null,
  canary_offering_id: null,
  canary_started_at: null,
  hold_period_seconds: 300,
  hold_started_at: null,
  canary_metrics: null,
  canary_passed_at: null,
  rolled_back_at: null,
  created_at: new Date().toISOString(),
  approved_at: new Date().toISOString(),
  applied_at: null,
  updated_at: new Date().toISOString(),
};

const canaryActiveRow = {
  ...approvedRow,
  status: 'canary_active',
  canary_offering_id: 'offering-shadow-1',
  canary_started_at: new Date().toISOString(),
};

const holdPeriodRow = {
  ...canaryActiveRow,
  status: 'hold_period',
  hold_started_at: new Date(Date.now() - 400_000).toISOString(), // 400 s ago > 300 s
  canary_metrics: {
    error_rate: 0.001,
    p99_latency_ms: 120,
    failed_tx_count: 0,
  },
};

describe('ContractUpgradeOrchestratorService — startCanary', () => {
  let service: ContractUpgradeOrchestratorService;
  const mockKeypair = { publicKey: jest.fn().mockReturnValue('G-FAKE-KEY') } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ContractUpgradeOrchestratorService(
      mockPool, mockAuditLogRepo, mockTenantSettingsRepo, mockKeypair,
    );
  });

  it('transitions approved+simulate_ok upgrade to canary_active', async () => {
    const returnedRow = { ...approvedRow, status: 'canary_active', canary_offering_id: 'offering-shadow-1' };
    mockPool.query
      .mockResolvedValueOnce({ rows: [approvedRow] })   // getUpgrade
      .mockResolvedValueOnce({ rows: [returnedRow] });  // UPDATE

    const result = await service.startCanary('upgrade-canary-1', {
      canary_offering_id: 'offering-shadow-1',
      actor_id: 'operator-1',
      hold_period_seconds: 300,
    });

    expect(result.status).toBe('canary_active');
    expect(result.canary_offering_id).toBe('offering-shadow-1');
    expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CONTRACT_UPGRADE_CANARY_STARTED' }),
    );
  });

  it('rejects when upgrade is not approved', async () => {
    const pendingRow = { ...approvedRow, status: 'pending', simulate_ok: null };
    mockPool.query.mockResolvedValueOnce({ rows: [pendingRow] });

    await expect(
      service.startCanary('upgrade-canary-1', { canary_offering_id: 'offering-shadow-1', actor_id: 'op' }),
    ).rejects.toThrow(/Cannot start canary.*pending/);
  });

  it('rejects when simulate_ok is false', async () => {
    const notSimulated = { ...approvedRow, simulate_ok: false };
    mockPool.query.mockResolvedValueOnce({ rows: [notSimulated] });

    await expect(
      service.startCanary('upgrade-canary-1', { canary_offering_id: 'offering-shadow-1', actor_id: 'op' }),
    ).rejects.toThrow(/dry-run simulation/);
  });

  it('rejects when no canary offering is configured or supplied', async () => {
    await expect(
      service.startCanary('upgrade-canary-1', { actor_id: 'op' }),
    ).rejects.toThrow(/No canary offering is configured/);
  });

  it('rejects negative hold_period_seconds', async () => {
    await expect(
      service.startCanary('upgrade-canary-1', {
        canary_offering_id: 'offering-shadow-1',
        actor_id: 'op',
        hold_period_seconds: -1,
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it('defaults hold_period_seconds to 300 when not provided', async () => {
    const returnedRow = { ...approvedRow, status: 'canary_active', canary_offering_id: 'offering-shadow-1', hold_period_seconds: 300 };
    mockPool.query
      .mockResolvedValueOnce({ rows: [approvedRow] })
      .mockResolvedValueOnce({ rows: [returnedRow] });

    const result = await service.startCanary('upgrade-canary-1', {
      canary_offering_id: 'offering-shadow-1',
      actor_id: 'op',
    });
    expect(result.hold_period_seconds).toBe(300);
  });
});

describe('ContractUpgradeOrchestratorService — recordCanaryMetrics', () => {
  let service: ContractUpgradeOrchestratorService;
  const mockKeypair = { publicKey: jest.fn().mockReturnValue('G-FAKE-KEY') } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ContractUpgradeOrchestratorService(
      mockPool, mockAuditLogRepo, mockTenantSettingsRepo, mockKeypair,
    );
  });

  const cleanMetrics = { error_rate: 0.001, p99_latency_ms: 120, failed_tx_count: 0 };

  it('transitions canary_active to hold_period on first clean metrics recording', async () => {
    const holdRow = { ...canaryActiveRow, status: 'hold_period', hold_started_at: new Date().toISOString(), canary_metrics: cleanMetrics };
    mockPool.query
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })
      .mockResolvedValueOnce({ rows: [holdRow] });

    const result = await service.recordCanaryMetrics('upgrade-canary-1', cleanMetrics, 'op');

    expect(result.status).toBe('hold_period');
    expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CONTRACT_UPGRADE_CANARY_METRICS_RECORDED' }),
    );
  });

  it('updates metrics in place when already in hold_period', async () => {
    const updatedHoldRow = { ...holdPeriodRow, canary_metrics: cleanMetrics };
    mockPool.query
      .mockResolvedValueOnce({ rows: [holdPeriodRow] })
      .mockResolvedValueOnce({ rows: [updatedHoldRow] });

    const result = await service.recordCanaryMetrics('upgrade-canary-1', cleanMetrics, 'op');
    expect(result.status).toBe('hold_period');
  });

  it('auto-rollbacks on error_rate threshold breach', async () => {
    const badMetrics = { error_rate: 0.05, p99_latency_ms: 120, failed_tx_count: 0 };
    const rolledBackRow = { ...canaryActiveRow, status: 'rolled_back', failure_reason: 'Canary metric threshold breached: error_rate 0.05 exceeds threshold 0.01', rolled_back_at: new Date().toISOString() };
    mockPool.query
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })   // recordCanaryMetrics -> getUpgrade
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })   // rollbackCanary -> getUpgrade
      .mockResolvedValueOnce({ rows: [rolledBackRow] });    // rollbackCanary -> UPDATE

    const result = await service.recordCanaryMetrics('upgrade-canary-1', badMetrics, 'op');

    expect(result.status).toBe('rolled_back');
    expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CONTRACT_UPGRADE_CANARY_ROLLED_BACK' }),
    );
  });

  it('auto-rollbacks on p99_latency_ms threshold breach', async () => {
    const badMetrics = { error_rate: 0.001, p99_latency_ms: 5000, failed_tx_count: 0 };
    const rolledBackRow = { ...canaryActiveRow, status: 'rolled_back', failure_reason: 'breach', rolled_back_at: new Date().toISOString() };
    mockPool.query
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })
      .mockResolvedValueOnce({ rows: [rolledBackRow] });

    const result = await service.recordCanaryMetrics('upgrade-canary-1', badMetrics, 'op');
    expect(result.status).toBe('rolled_back');
  });

  it('auto-rollbacks on failed_tx_count threshold breach', async () => {
    const badMetrics = { error_rate: 0.001, p99_latency_ms: 120, failed_tx_count: 1 };
    const rolledBackRow = { ...canaryActiveRow, status: 'rolled_back', failure_reason: 'breach', rolled_back_at: new Date().toISOString() };
    mockPool.query
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })
      .mockResolvedValueOnce({ rows: [rolledBackRow] });

    const result = await service.recordCanaryMetrics('upgrade-canary-1', badMetrics, 'op');
    expect(result.status).toBe('rolled_back');
  });

  it('rejects metrics recording for non-canary status', async () => {
    const appliedRow = { ...approvedRow, status: 'applied' };
    mockPool.query.mockResolvedValueOnce({ rows: [appliedRow] });

    await expect(
      service.recordCanaryMetrics('upgrade-canary-1', cleanMetrics, 'op'),
    ).rejects.toThrow(/Cannot record canary metrics.*applied/);
  });

  it('rejects negative error_rate', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [canaryActiveRow] });

    await expect(
      service.recordCanaryMetrics('upgrade-canary-1', { error_rate: -0.1, p99_latency_ms: 100, failed_tx_count: 0 }, 'op'),
    ).rejects.toThrow(/non-negative/);
  });

  it('respects custom thresholds', async () => {
    // With a very tight custom threshold, error_rate of 0.005 should breach
    const metrics = { error_rate: 0.005, p99_latency_ms: 100, failed_tx_count: 0 };
    const strictThresholds = { max_error_rate: 0.001, max_p99_latency_ms: 2000, max_failed_tx_count: 0 };
    const rolledBackRow = { ...canaryActiveRow, status: 'rolled_back', failure_reason: 'breach', rolled_back_at: new Date().toISOString() };
    mockPool.query
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })
      .mockResolvedValueOnce({ rows: [rolledBackRow] });

    const result = await service.recordCanaryMetrics('upgrade-canary-1', metrics, 'op', strictThresholds);
    expect(result.status).toBe('rolled_back');
  });
});

describe('ContractUpgradeOrchestratorService — promoteCanary', () => {
  let service: ContractUpgradeOrchestratorService;
  const mockKeypair = { publicKey: jest.fn().mockReturnValue('G-FAKE-KEY') } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ContractUpgradeOrchestratorService(
      mockPool, mockAuditLogRepo, mockTenantSettingsRepo, mockKeypair,
    );
  });

  it('promotes to canary_passed when hold period has elapsed and metrics are clean', async () => {
    const passedRow = { ...holdPeriodRow, status: 'canary_passed', canary_passed_at: new Date().toISOString() };
    mockPool.query
      .mockResolvedValueOnce({ rows: [holdPeriodRow] })
      .mockResolvedValueOnce({ rows: [passedRow] });

    const result = await service.promoteCanary('upgrade-canary-1', 'op');

    expect(result.status).toBe('canary_passed');
    expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CONTRACT_UPGRADE_CANARY_PROMOTED' }),
    );
  });

  it('rejects promotion when hold period has NOT elapsed', async () => {
    // hold_started_at only 10 s ago, hold_period_seconds = 300
    const recentHoldRow = {
      ...holdPeriodRow,
      hold_started_at: new Date(Date.now() - 10_000).toISOString(),
    };
    mockPool.query.mockResolvedValueOnce({ rows: [recentHoldRow] });

    await expect(service.promoteCanary('upgrade-canary-1', 'op'))
      .rejects.toThrow(/Hold period has not elapsed/);
  });

  it('rejects promotion when status is not hold_period', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [canaryActiveRow] });

    await expect(service.promoteCanary('upgrade-canary-1', 'op'))
      .rejects.toThrow(/Cannot promote canary.*canary_active/);
  });

  it('rejects promotion when no canary_metrics recorded', async () => {
    const noMetricsRow = { ...holdPeriodRow, canary_metrics: null };
    mockPool.query.mockResolvedValueOnce({ rows: [noMetricsRow] });

    await expect(service.promoteCanary('upgrade-canary-1', 'op'))
      .rejects.toThrow(/No canary metrics recorded/);
  });

  it('rejects promotion when hold_started_at is null', async () => {
    const noHoldRow = { ...holdPeriodRow, hold_started_at: null };
    mockPool.query.mockResolvedValueOnce({ rows: [noHoldRow] });

    await expect(service.promoteCanary('upgrade-canary-1', 'op'))
      .rejects.toThrow(/Hold period has not started/);
  });

  it('auto-rollbacks during promote when latest metrics breach threshold', async () => {
    const dirtyMetrics = { error_rate: 0.9, p99_latency_ms: 120, failed_tx_count: 0 };
    const dirtyHoldRow = { ...holdPeriodRow, canary_metrics: dirtyMetrics };
    const rolledBackRow = { ...holdPeriodRow, status: 'rolled_back', failure_reason: 'breach', rolled_back_at: new Date().toISOString() };
    mockPool.query
      .mockResolvedValueOnce({ rows: [dirtyHoldRow] })   // promoteCanary -> getUpgrade
      .mockResolvedValueOnce({ rows: [dirtyHoldRow] })   // rollbackCanary -> getUpgrade
      .mockResolvedValueOnce({ rows: [rolledBackRow] }); // rollbackCanary -> UPDATE

    const result = await service.promoteCanary('upgrade-canary-1', 'op');
    expect(result.status).toBe('rolled_back');
    expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CONTRACT_UPGRADE_CANARY_ROLLED_BACK' }),
    );
  });
});

describe('ContractUpgradeOrchestratorService — rollbackCanary', () => {
  let service: ContractUpgradeOrchestratorService;
  const mockKeypair = { publicKey: jest.fn().mockReturnValue('G-FAKE-KEY') } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ContractUpgradeOrchestratorService(
      mockPool, mockAuditLogRepo, mockTenantSettingsRepo, mockKeypair,
    );
  });

  it('rolls back a canary_active upgrade', async () => {
    const rolledBackRow = { ...canaryActiveRow, status: 'rolled_back', failure_reason: 'Manual rollback requested', rolled_back_at: new Date().toISOString() };
    mockPool.query
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })
      .mockResolvedValueOnce({ rows: [rolledBackRow] });

    const result = await service.rollbackCanary('upgrade-canary-1', 'op');

    expect(result.status).toBe('rolled_back');
    expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CONTRACT_UPGRADE_CANARY_ROLLED_BACK' }),
    );
  });

  it('rolls back a hold_period upgrade', async () => {
    const rolledBackRow = { ...holdPeriodRow, status: 'rolled_back', failure_reason: 'Operator decision', rolled_back_at: new Date().toISOString() };
    mockPool.query
      .mockResolvedValueOnce({ rows: [holdPeriodRow] })
      .mockResolvedValueOnce({ rows: [rolledBackRow] });

    const result = await service.rollbackCanary('upgrade-canary-1', 'op', 'Operator decision');
    expect(result.status).toBe('rolled_back');
    expect(result.failure_reason).toBe('Operator decision');
  });

  it('is idempotent: returns current state when already rolled_back', async () => {
    const alreadyRolledBack = { ...canaryActiveRow, status: 'rolled_back', rolled_back_at: new Date().toISOString() };
    mockPool.query.mockResolvedValueOnce({ rows: [alreadyRolledBack] });

    const result = await service.rollbackCanary('upgrade-canary-1', 'op');
    expect(result.status).toBe('rolled_back');
    // Only one query (the getUpgrade), no UPDATE
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: returns current state when already failed', async () => {
    const failedRow = { ...approvedRow, status: 'failed', failure_reason: 'prior failure' };
    mockPool.query.mockResolvedValueOnce({ rows: [failedRow] });

    const result = await service.rollbackCanary('upgrade-canary-1', 'op');
    expect(result.status).toBe('failed');
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  it('rejects rollback for non-canary statuses like applied', async () => {
    const appliedRow = { ...approvedRow, status: 'applied', transaction_hash: 'txhash' };
    mockPool.query.mockResolvedValueOnce({ rows: [appliedRow] });

    await expect(service.rollbackCanary('upgrade-canary-1', 'op'))
      .rejects.toThrow(/Cannot rollback canary.*applied/);
  });

  it('rejects rollback for pending status', async () => {
    const pendingRow = { ...approvedRow, status: 'pending' };
    mockPool.query.mockResolvedValueOnce({ rows: [pendingRow] });

    await expect(service.rollbackCanary('upgrade-canary-1', 'op'))
      .rejects.toThrow(/Cannot rollback canary.*pending/);
  });

  it('records the rollback reason in audit log', async () => {
    const rolledBackRow = { ...canaryActiveRow, status: 'rolled_back', failure_reason: 'Latency spike detected', rolled_back_at: new Date().toISOString() };
    mockPool.query
      .mockResolvedValueOnce({ rows: [canaryActiveRow] })
      .mockResolvedValueOnce({ rows: [rolledBackRow] });

    await service.rollbackCanary('upgrade-canary-1', 'op', 'Latency spike detected');

    const auditCall = (mockAuditLogRepo.createAuditLog as jest.Mock).mock.calls[0][0];
    const details = JSON.parse(auditCall.details);
    expect(details.reason).toBe('Latency spike detected');
    expect(details.previous_status).toBe('canary_active');
  });
});