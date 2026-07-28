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
