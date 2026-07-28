import request from 'supertest';
import express from 'express';
import { Pool } from 'pg';
import { createAdminKycRiskTierRouter } from '../adminKycRiskTier';
import { InMemorySecurityAuditRepository } from '../../security/audit';
import { INVESTOR_CAP_RECALCULATED_ACTION } from '../../lib/kycRiskTierCaps';
import { errorHandler } from '../../middleware/errorHandler';

let setAdminUser = true;

jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    requireAdmin: (req: any, _res: any, next: any) => {
      if (setAdminUser) {
        req.user = { id: 'admin-1', role: 'admin' };
      }
      next();
    },
  };
});

describe('PATCH /admin/investors/:id/kyc-risk-tier', () => {
  let app: express.Express;
  let mockPool: { query: jest.Mock };
  let auditRepo: InMemorySecurityAuditRepository;

  beforeEach(() => {
    setAdminUser = true;
    mockPool = { query: jest.fn() };
    auditRepo = new InMemorySecurityAuditRepository();
    app = express();
    app.use(express.json());
    app.use('/admin', createAdminKycRiskTierRouter(mockPool as unknown as Pool, auditRepo));
    app.use(errorHandler);
  });

  it('updates tier and returns non-retroactive response', async () => {
    const investor = {
      id: 'investor-1',
      email: 'a@b.com',
      password_hash: 'x',
      role: 'investor',
      kyc_risk_tier: 'high',
      created_at: new Date(),
      updated_at: new Date(),
    };

    mockPool.query
      // findById
      .mockResolvedValueOnce({ rows: [investor], rowCount: 1, command: 'SELECT', oid: 0, fields: [] })
      // updateUser RETURNING
      .mockResolvedValueOnce({
        rows: [{ ...investor, kyc_risk_tier: 'standard' }],
        rowCount: 1,
        command: 'UPDATE',
        oid: 0,
        fields: [],
      });

    const res = await request(app)
      .patch('/admin/investors/investor-1/kyc-risk-tier')
      .send({ tier: 'standard', offering_cap_bps: 1000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      investor_id: 'investor-1',
      previous_tier: 'high',
      kyc_risk_tier: 'standard',
      effective_cap_bps: 1000,
      retroactive_invalidation: false,
    });

    const events = await auditRepo.findByUserId('admin-1');
    expect(events.some((e) => e.action === INVESTOR_CAP_RECALCULATED_ACTION)).toBe(true);
  });


  it('returns 401 when authenticated user is absent', async () => {
    setAdminUser = false;
    const res = await request(app)
      .patch('/admin/investors/investor-1/kyc-risk-tier')
      .send({ tier: 'standard' });
    expect(res.status).toBe(401);
  });

  it('returns 404 when investor is not found', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    });

    const res = await request(app)
      .patch('/admin/investors/missing/kyc-risk-tier')
      .send({ tier: 'standard' });

    expect(res.status).toBe(404);
  });

  it('delegates unexpected errors to the error handler', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('db down'));

    const res = await request(app)
      .patch('/admin/investors/investor-1/kyc-risk-tier')
      .send({ tier: 'standard' });

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('rejects invalid tier', async () => {
    const res = await request(app)
      .patch('/admin/investors/investor-1/kyc-risk-tier')
      .send({ tier: 'nope' });
    expect(res.status).toBe(400);
  });
});
