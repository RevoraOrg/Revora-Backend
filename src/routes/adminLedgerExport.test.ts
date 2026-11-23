import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { createAdminLedgerExportRouter } from './adminLedgerExport';
import { DistributionAccountRepo } from './distributions';
import { errorHandler } from '../middleware/errorHandler';
import { env } from '../config/env';

const SECRET = 'testsecret_that_is_at_least_sixteen_chars';

beforeAll(() => {
  env.JWT_SECRET = SECRET;
  process.env.JWT_SECRET = SECRET;
});

function makeToken(role: string, sub = '00000000-0000-0000-0000-000000000000'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub, role, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function mockAuditRepo() {
  return {
    createAuditLog: jest.fn().mockResolvedValue({ id: 'log-1' }),
    getAuditLogsByUser: jest.fn(),
    getAuditLogsByAction: jest.fn(),
    getAuditLogsForExport: jest.fn().mockResolvedValue([]),
    purgeBefore: jest.fn().mockResolvedValue({ deletedCount: 0, skippedHoldCount: 0 }),
  };
}

function mockAccountRepo(overrides: Partial<DistributionAccountRepo> = {}): DistributionAccountRepo {
  return {
    listForAccountingExport: jest.fn().mockResolvedValue([
      {
        id: 'run-1',
        offering_id: 'off-1',
        period_id: 'period-1',
        total_amount: '100.00',
        status: 'completed',
        run_at: new Date('2026-07-01T00:00:00Z'),
        payouts: [
          {
            id: 'p-1',
            investor_id: 'inv-1',
            amount: '100.00',
            status: 'processed',
            created_at: new Date('2026-07-02T00:00:00Z'),
            updated_at: new Date('2026-07-02T00:00:00Z'),
          },
        ],
      },
    ]),
    ...overrides,
  };
}

function createApp(accountRepo?: DistributionAccountRepo, auditRepo?: any) {
  const app = express();
  app.use(express.json());
  app.use(
    '/admin/ledger',
    createAdminLedgerExportRouter({
      distributionAccountRepo: accountRepo ?? mockAccountRepo(),
      auditLogRepo: auditRepo ?? mockAuditRepo(),
    }),
  );
  app.use(errorHandler);
  return app;
}

describe('GET /admin/ledger/export', () => {
  it('returns 401 without a token', async () => {
    const app = createApp();
    const res = await request(app).get('/admin/ledger/export').query({ offering_id: 'off-1' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for a non-admin role', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/admin/ledger/export')
      .query({ offering_id: 'off-1' })
      .set('Authorization', `Bearer ${makeToken('investor')}`);
    expect(res.status).toBe(403);
  });

  it('returns 400 when offering_id is missing', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/admin/ledger/export')
      .set('Authorization', `Bearer ${makeToken('admin')}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_REQUEST');
  });

  it('returns 400 for an empty period_id', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/admin/ledger/export')
      .query({ offering_id: 'off-1', period_id: ' ' })
      .set('Authorization', `Bearer ${makeToken('admin')}`);
    expect(res.status).toBe(400);
  });

  it('returns CSV by default with checksum headers for admin', async () => {
    const auditRepo = mockAuditRepo();
    const app = createApp(undefined, auditRepo);
    const res = await request(app)
      .get('/admin/ledger/export')
      .query({ offering_id: 'off-1' })
      .set('Authorization', `Bearer ${makeToken('admin')}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['x-ledger-export-id']).toBeTruthy();
    expect(res.headers['x-ledger-checksum']).toMatch(/^[a-f0-9]{64}$/);

    expect(res.text).toContain('# export_id=');
    expect(res.text).toContain('# checksum=');
    expect(res.text.split('\n').length).toBeGreaterThan(3);

    // Audited
    expect(auditRepo.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ledger.export',
        resource: 'offering:off-1',
        user_id: '00000000-0000-0000-0000-000000000000',
      }),
    );
  });

  it('returns JSONL when Accept: application/x-jsonlines', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/admin/ledger/export')
      .query({ offering_id: 'off-1' })
      .set('Authorization', `Bearer ${makeToken('admin')}`)
      .set('Accept', 'application/x-jsonlines');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-jsonlines');

    const lines = res.text.trim().split('\n');
    expect(JSON.parse(lines[0])).toEqual({ manifest: 'ledger-export', export_id: expect.any(String) });
    expect(JSON.parse(lines[lines.length - 1]).checksum).toBeTruthy();
  });

  it('returns JSONL when Accept includes application/json', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/admin/ledger/export')
      .query({ offering_id: 'off-1' })
      .set('Authorization', `Bearer ${makeToken('admin')}`)
      .set('Accept', 'application/json');
    expect(res.headers['content-type']).toContain('application/x-jsonlines');
  });

  it('handles empty result set', async () => {
    const app = createApp(mockAccountRepo({ listForAccountingExport: jest.fn().mockResolvedValue([]) }));
    const res = await request(app)
      .get('/admin/ledger/export')
      .query({ offering_id: 'off-9' })
      .set('Authorization', `Bearer ${makeToken('admin')}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('# checksum=');
  });

  it('clamps limit to a maximum of 1000', async () => {
    const manyRuns = Array.from({ length: 1500 }, (_, i) => ({
      id: `run-${i}`,
      offering_id: 'off-1',
      period_id: 'period-1',
      total_amount: '1.00',
      status: 'completed',
      run_at: new Date('2026-07-01T00:00:00Z'),
      payouts: [],
    }));
    const listSpy = jest.fn().mockResolvedValue(manyRuns);
    const app = createApp(mockAccountRepo({ listForAccountingExport: listSpy }));
    const res = await request(app)
      .get('/admin/ledger/export')
      .query({ offering_id: 'off-1', limit: '9999' })
      .set('Authorization', `Bearer ${makeToken('admin')}`);
    expect(res.status).toBe(200);

    const dataRows = res.text.trim().split('\n').filter((l) => !l.startsWith('#'));
    // 1 header + 1000 runs * 2 lines = 2001 <= bounded by MAX_EXPORT_LIMIT (1000)
    expect(dataRows.length).toBe(1 + 1000 * 2);
  });

  it('does not leak internal errors when the repository throws', async () => {
    const auditRepo = mockAuditRepo();
    const accountRepo = mockAccountRepo({
      listForAccountingExport: jest.fn().mockRejectedValue(new Error('db exploded')),
    });
    const app = createApp(accountRepo, auditRepo);
    const res = await request(app)
      .get('/admin/ledger/export')
      .query({ offering_id: 'off-1' })
      .set('Authorization', `Bearer ${makeToken('admin')}`);
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('db exploded');
  });
});
