import express from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { createAdminKycRiskTierRouter } from './adminKycRiskTier';
import { SecurityAuditRepository } from '../security/types';
import { AppError } from '../lib/errors';
import * as kycRiskTierServiceModule from '../services/kycRiskTierService';

jest.mock('../middleware/auth', () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    const authHeader = req.headers['authorization'];
    if (authHeader === 'Bearer admin') {
      req.user = { id: 'admin-1', role: 'admin' };
      return next();
    }
    if (authHeader === 'Bearer no-user') {
      req.user = undefined;
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  },
}));

jest.mock('../services/kycRiskTierService');

describe('createAdminKycRiskTierRouter', () => {
  let app: express.Express;
  let mockDb: jest.Mocked<Pool>;
  let mockAuditRepo: jest.Mocked<SecurityAuditRepository>;
  let updateKycRiskTierMock: jest.Mock;

  beforeEach(() => {
    mockDb = {} as any;
    mockAuditRepo = { log: jest.fn() } as any;
    
    updateKycRiskTierMock = jest.fn();
    (kycRiskTierServiceModule.createKycRiskTierService as jest.Mock).mockReturnValue({
      updateKycRiskTier: updateKycRiskTierMock,
    });

    app = express();
    app.use(express.json());
    app.use('/admin', createAdminKycRiskTierRouter(mockDb, mockAuditRepo));
    
    app.use((err: any, req: any, res: any, next: any) => {
      res.status(500).json({ error: 'Internal server error' });
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('PATCH /admin/investors/:id/kyc-risk-tier', () => {
    it('returns 401 if unauthenticated', async () => {
      const res = await request(app)
        .patch('/admin/investors/inv-1/kyc-risk-tier')
        .send({ tier: 'standard' });
        
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 if req.user is missing despite middleware passing', async () => {
      const res = await request(app)
        .patch('/admin/investors/inv-1/kyc-risk-tier')
        .set('Authorization', 'Bearer no-user')
        .send({ tier: 'standard' });
        
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 400 if tier is invalid', async () => {
      const res = await request(app)
        .patch('/admin/investors/inv-1/kyc-risk-tier')
        .set('Authorization', 'Bearer admin')
        .send({ tier: 'invalid_tier' });
        
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tier must be one of');
    });

    it('returns 400 if tier is missing', async () => {
      const res = await request(app)
        .patch('/admin/investors/inv-1/kyc-risk-tier')
        .set('Authorization', 'Bearer admin')
        .send({});
        
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('tier must be one of');
    });

    it('successfully updates the tier and returns 200 with result payload', async () => {
      updateKycRiskTierMock.mockResolvedValueOnce({
        user: { id: 'inv-1', kyc_risk_tier: 'elevated' },
        previousTier: 'standard',
        resolution: { effectiveCapBps: 500, multiplier: 2.0 },
      });

      const res = await request(app)
        .patch('/admin/investors/inv-1/kyc-risk-tier')
        .set('Authorization', 'Bearer admin')
        .send({ tier: 'elevated' });
        
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        investor_id: 'inv-1',
        previous_tier: 'standard',
        kyc_risk_tier: 'elevated',
        effective_cap_bps: 500,
        multiplier: 2.0,
        retroactive_invalidation: false,
      });

      expect(updateKycRiskTierMock).toHaveBeenCalledWith({
        investorId: 'inv-1',
        tier: 'elevated',
        actorId: 'admin-1',
        referenceOfferingCapBps: null,
      });
    });

    it('passes referenceOfferingCapBps if provided', async () => {
      updateKycRiskTierMock.mockResolvedValueOnce({
        user: { id: 'inv-1', kyc_risk_tier: 'low' },
        previousTier: 'standard',
        resolution: { effectiveCapBps: 200, multiplier: 1.0 },
      });

      const res = await request(app)
        .patch('/admin/investors/inv-1/kyc-risk-tier')
        .set('Authorization', 'Bearer admin')
        .send({ tier: 'low', offering_cap_bps: 1000 });
        
      expect(res.status).toBe(200);
      expect(updateKycRiskTierMock).toHaveBeenCalledWith({
        investorId: 'inv-1',
        tier: 'low',
        actorId: 'admin-1',
        referenceOfferingCapBps: 1000,
      });
    });

    it('returns application error if service throws AppError', async () => {
      const error = AppError.badRequest('Cannot lower risk tier during active dispute', { code: 'ACTIVE_DISPUTE' });
      updateKycRiskTierMock.mockRejectedValueOnce(error);

      const res = await request(app)
        .patch('/admin/investors/inv-1/kyc-risk-tier')
        .set('Authorization', 'Bearer admin')
        .send({ tier: 'low' });
        
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: 'BAD_REQUEST',
        message: 'Cannot lower risk tier during active dispute',
        details: { code: 'ACTIVE_DISPUTE' },
      });
    });

    it('passes unknown errors to the generic error handler', async () => {
      const genericError = new Error('Database connection lost');
      updateKycRiskTierMock.mockRejectedValueOnce(genericError);

      const res = await request(app)
        .patch('/admin/investors/inv-1/kyc-risk-tier')
        .set('Authorization', 'Bearer admin')
        .send({ tier: 'restricted' });
        
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
    });
  });
});
