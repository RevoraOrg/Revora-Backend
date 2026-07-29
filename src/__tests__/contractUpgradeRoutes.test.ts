import express from 'express';
import request from 'supertest';
import { createContractUpgradeRouter } from '../routes/contractUpgradeRoutes';
import { StorageDriftReportService } from '../services/storageDriftReportService';
import { errorHandler } from '../middleware/errorHandler';

jest.mock('../middleware/auth', () => ({
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

const mockContractUpgradeService = {
  createUpgrade: jest.fn(),
} as any;

const validDescriptor = {
  version: '1.0',
  codeId: 'aaa',
  entries: [
    { key: 'balance', storageType: 'persistent', valueType: 'Uint128' },
  ],
};

function buildApp(driftService?: StorageDriftReportService) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1/contract-upgrades',
    createContractUpgradeRouter(mockContractUpgradeService, driftService),
  );
  app.use(errorHandler);
  return app;
}

describe('Contract Upgrade Routes — drift-report endpoint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 when current_descriptor is missing', async () => {
    const app = buildApp(new StorageDriftReportService());
    const res = await request(app)
      .post('/api/v1/contract-upgrades/drift-report')
      .send({ target_descriptor: validDescriptor });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when target_descriptor is missing', async () => {
    const app = buildApp(new StorageDriftReportService());
    const res = await request(app)
      .post('/api/v1/contract-upgrades/drift-report')
      .send({ current_descriptor: validDescriptor });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 200 with safe report', async () => {
    const app = buildApp(new StorageDriftReportService());
    const res = await request(app)
      .post('/api/v1/contract-upgrades/drift-report')
      .send({
        current_descriptor: validDescriptor,
        target_descriptor: { ...validDescriptor, codeId: 'bbb' },
      });
    expect(res.status).toBe(200);
    expect(res.body.report.recommendation).toBe('safe');
    expect(res.body.alert_emitted).toBe(false);
  });

  it('returns 422 with blocking report for breaking changes', async () => {
    const app = buildApp(new StorageDriftReportService());
    const res = await request(app)
      .post('/api/v1/contract-upgrades/drift-report')
      .send({
        current_descriptor: validDescriptor,
        target_descriptor: {
          version: '1.0',
          codeId: 'bbb',
          entries: [],
        },
      });
    expect(res.status).toBe(422);
    expect(res.body.report.recommendation).toBe('blocking');
    expect(res.body.alert_emitted).toBe(true);
  });

  it('returns 503 when drift service is not provided', async () => {
    const app = buildApp(undefined);
    const res = await request(app)
      .post('/api/v1/contract-upgrades/drift-report')
      .send({
        current_descriptor: validDescriptor,
        target_descriptor: validDescriptor,
      });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns 400 when both descriptors are missing', async () => {
    const app = buildApp(new StorageDriftReportService());
    const res = await request(app)
      .post('/api/v1/contract-upgrades/drift-report')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when descriptor format is invalid', async () => {
    const app = buildApp(new StorageDriftReportService());
    const res = await request(app)
      .post('/api/v1/contract-upgrades/drift-report')
      .send({
        current_descriptor: { nope: true },
        target_descriptor: validDescriptor,
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('passes upgrade_id to the drift service', async () => {
    const app = buildApp(new StorageDriftReportService());
    const res = await request(app)
      .post('/api/v1/contract-upgrades/drift-report')
      .send({
        current_descriptor: validDescriptor,
        target_descriptor: { ...validDescriptor, codeId: 'bbb' },
        upgrade_id: 'upg-99',
      });
    expect(res.status).toBe(200);
    expect(res.body.report.currentCodeId).toBe('aaa');
    expect(res.body.report.targetCodeId).toBe('bbb');
  });

  it('returns review_required with 200 for additions only', async () => {
    const app = buildApp(new StorageDriftReportService());
    const res = await request(app)
      .post('/api/v1/contract-upgrades/drift-report')
      .send({
        current_descriptor: validDescriptor,
        target_descriptor: {
          version: '1.0',
          codeId: 'bbb',
          entries: [
            { key: 'balance', storageType: 'persistent', valueType: 'Uint128' },
            { key: 'fee', storageType: 'persistent', valueType: 'Uint32' },
          ],
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.report.recommendation).toBe('review_required');
  });
});

// ── Canary route tests ────────────────────────────────────────────────────────

const canaryUpgrade = {
  id: 'upgrade-canary-1',
  tenant_id: 'tenant-1',
  contract_id: 'contract-1',
  target_code_id: 'deadbeef',
  status: 'canary_active',
  proposed_by: 'user-1',
  approved_by: 'approver-1',
  simulate_ok: true,
  canary_offering_id: 'offering-shadow-1',
  canary_started_at: new Date().toISOString(),
  hold_period_seconds: 300,
  hold_started_at: null,
  canary_metrics: null,
  canary_passed_at: null,
  rolled_back_at: null,
  failure_reason: null,
  transaction_hash: null,
  created_at: new Date().toISOString(),
  approved_at: new Date().toISOString(),
  applied_at: null,
  updated_at: new Date().toISOString(),
};

describe('Contract Upgrade Routes — canary/start endpoint', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 and upgrade on successful canary start', async () => {
    mockContractUpgradeService.startCanary = jest.fn().mockResolvedValue(canaryUpgrade);
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/start')
      .send({ canary_offering_id: 'offering-shadow-1', actor_id: 'op-1', hold_period_seconds: 300 });

    expect(res.status).toBe(200);
    expect(res.body.upgrade.status).toBe('canary_active');
    expect(res.body.upgrade.canary_offering_id).toBe('offering-shadow-1');
  });

  it('returns 400 when canary_offering_id is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/start')
      .send({ actor_id: 'op-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when actor_id is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/start')
      .send({ canary_offering_id: 'offering-shadow-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when hold_period_seconds is negative', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/start')
      .send({ canary_offering_id: 'offering-shadow-1', actor_id: 'op-1', hold_period_seconds: -5 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('propagates service errors (e.g. conflict) to error handler', async () => {
    const { Errors: E } = await import('../lib/errors');
    mockContractUpgradeService.startCanary = jest.fn().mockRejectedValue(
      E.conflict("Cannot start canary for upgrade with status 'pending'"),
    );
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/start')
      .send({ canary_offering_id: 'offering-shadow-1', actor_id: 'op-1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });
});

describe('Contract Upgrade Routes — canary/metrics endpoint', () => {
  beforeEach(() => jest.clearAllMocks());

  const cleanMetrics = { error_rate: 0.001, p99_latency_ms: 120, failed_tx_count: 0 };
  const holdUpgrade = { ...canaryUpgrade, status: 'hold_period', hold_started_at: new Date().toISOString(), canary_metrics: cleanMetrics };

  it('returns 200 on successful metrics recording', async () => {
    mockContractUpgradeService.recordCanaryMetrics = jest.fn().mockResolvedValue(holdUpgrade);
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/metrics')
      .send({ actor_id: 'op-1', metrics: cleanMetrics });

    expect(res.status).toBe(200);
    expect(res.body.upgrade.status).toBe('hold_period');
  });

  it('returns 400 when actor_id is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/metrics')
      .send({ metrics: cleanMetrics });
    expect(res.status).toBe(400);
  });

  it('returns 400 when metrics object is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/metrics')
      .send({ actor_id: 'op-1' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when metrics fields are non-numeric', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/metrics')
      .send({ actor_id: 'op-1', metrics: { error_rate: 'bad', p99_latency_ms: 100, failed_tx_count: 0 } });
    expect(res.status).toBe(400);
  });

  it('passes optional thresholds to service', async () => {
    const rolledBackUpgrade = { ...canaryUpgrade, status: 'rolled_back' };
    mockContractUpgradeService.recordCanaryMetrics = jest.fn().mockResolvedValue(rolledBackUpgrade);
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/metrics')
      .send({
        actor_id: 'op-1',
        metrics: cleanMetrics,
        thresholds: { max_error_rate: 0.0001, max_p99_latency_ms: 2000, max_failed_tx_count: 0 },
      });
    expect(res.status).toBe(200);
    expect(mockContractUpgradeService.recordCanaryMetrics).toHaveBeenCalledWith(
      'upgrade-canary-1',
      cleanMetrics,
      'op-1',
      expect.objectContaining({ max_error_rate: 0.0001 }),
    );
  });
});

describe('Contract Upgrade Routes — canary/promote endpoint', () => {
  beforeEach(() => jest.clearAllMocks());

  const passedUpgrade = { ...canaryUpgrade, status: 'canary_passed', canary_passed_at: new Date().toISOString() };

  it('returns 200 on successful promotion', async () => {
    mockContractUpgradeService.promoteCanary = jest.fn().mockResolvedValue(passedUpgrade);
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/promote')
      .send({ actor_id: 'op-1' });

    expect(res.status).toBe(200);
    expect(res.body.upgrade.status).toBe('canary_passed');
  });

  it('returns 400 when actor_id is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/promote')
      .send({});
    expect(res.status).toBe(400);
  });

  it('propagates 409 conflict when hold period not elapsed', async () => {
    const { Errors: E } = await import('../lib/errors');
    mockContractUpgradeService.promoteCanary = jest.fn().mockRejectedValue(
      E.conflict('Hold period has not elapsed — 250s remaining', { remaining_seconds: 250 }),
    );
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/promote')
      .send({ actor_id: 'op-1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('passes optional custom thresholds to service', async () => {
    mockContractUpgradeService.promoteCanary = jest.fn().mockResolvedValue(passedUpgrade);
    const app = buildApp();
    const customThresholds = { max_error_rate: 0.005, max_p99_latency_ms: 1000, max_failed_tx_count: 0 };
    await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/promote')
      .send({ actor_id: 'op-1', thresholds: customThresholds });
    expect(mockContractUpgradeService.promoteCanary).toHaveBeenCalledWith(
      'upgrade-canary-1', 'op-1', expect.objectContaining({ max_error_rate: 0.005 }),
    );
  });
});

describe('Contract Upgrade Routes — canary/rollback endpoint', () => {
  beforeEach(() => jest.clearAllMocks());

  const rolledBackUpgrade = {
    ...canaryUpgrade,
    status: 'rolled_back',
    failure_reason: 'Manual rollback requested',
    rolled_back_at: new Date().toISOString(),
  };

  it('returns 200 on successful rollback', async () => {
    mockContractUpgradeService.rollbackCanary = jest.fn().mockResolvedValue(rolledBackUpgrade);
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/rollback')
      .send({ actor_id: 'op-1', reason: 'Manual rollback requested' });

    expect(res.status).toBe(200);
    expect(res.body.upgrade.status).toBe('rolled_back');
  });

  it('returns 400 when actor_id is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/rollback')
      .send({ reason: 'some reason' });
    expect(res.status).toBe(400);
  });

  it('accepts rollback without a reason (defaults to service default)', async () => {
    mockContractUpgradeService.rollbackCanary = jest.fn().mockResolvedValue(rolledBackUpgrade);
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/upgrade-canary-1/canary/rollback')
      .send({ actor_id: 'op-1' });
    expect(res.status).toBe(200);
    expect(mockContractUpgradeService.rollbackCanary).toHaveBeenCalledWith(
      'upgrade-canary-1', 'op-1', undefined,
    );
  });

  it('returns 404 when upgrade does not exist', async () => {
    const { Errors: E } = await import('../lib/errors');
    mockContractUpgradeService.rollbackCanary = jest.fn().mockRejectedValue(
      E.notFound("Contract upgrade 'nonexistent' not found"),
    );
    const app = buildApp();
    const res = await request(app)
      .post('/api/v1/contract-upgrades/nonexistent/canary/rollback')
      .send({ actor_id: 'op-1' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});