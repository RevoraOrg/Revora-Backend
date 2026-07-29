import { RiskScoreEngine, DEFAULT_RISK_WEIGHTS } from './riskScoreEngine';
import { AMLAlertRepository } from './amlAlertRepository';
import { UserRepository } from '../db/repositories/userRepository';
import { SecurityAuditRepository, AuditEvent } from '../security/types';
import { Pool } from 'pg';

describe('RiskScoreEngine', () => {
  let userRepo: jest.Mocked<UserRepository>;
  let alertRepo: jest.Mocked<AMLAlertRepository>;
  let auditRepo: jest.Mocked<SecurityAuditRepository>;
  let engine: RiskScoreEngine;

  beforeEach(() => {
    userRepo = {
      findById: jest.fn(),
    } as unknown as jest.Mocked<UserRepository>;

    alertRepo = {
      findByInvestor: jest.fn(),
    } as unknown as jest.Mocked<AMLAlertRepository>;

    auditRepo = {
      record: jest.fn(),
    } as unknown as jest.Mocked<SecurityAuditRepository>;

    engine = new RiskScoreEngine(userRepo, alertRepo, auditRepo);
  });

  describe('calculateScore', () => {
    it('returns score based on KYC tier and alerts', async () => {
      userRepo.findById.mockResolvedValue({ id: 'inv1', kyc_risk_tier: 'elevated' } as any);
      alertRepo.findByInvestor.mockResolvedValue([
        { severity: 'high', status: 'pending' } as any,
        { severity: 'low', status: 'reviewed' } as any,
        { severity: 'critical', status: 'dismissed' } as any, // should be ignored
      ]);

      const score = await engine.calculateScore('inv1');
      // baseScore (0) + elevated (25) + high (30) + low (5) = 60
      expect(score).toBe(60);

      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'risk.score.recalculated',
          resource: 'investor:inv1',
          outcome: 'SUCCESS',
          details: expect.objectContaining({ score: 60 }),
        })
      );
    });

    it('caps score at 100', async () => {
      userRepo.findById.mockResolvedValue({ id: 'inv1', kyc_risk_tier: 'restricted' } as any);
      alertRepo.findByInvestor.mockResolvedValue([
        { severity: 'critical', status: 'pending' } as any,
      ]);

      const score = await engine.calculateScore('inv1');
      // restricted (100) + critical (50) = 150 -> capped at 100
      expect(score).toBe(100);
    });

    it('defaults to worst-case (restricted) if user missing or fails', async () => {
      userRepo.findById.mockRejectedValue(new Error('DB error'));
      alertRepo.findByInvestor.mockResolvedValue([]);

      const score = await engine.calculateScore('inv1');
      // restricted (100) + 0 = 100
      expect(score).toBe(100);
    });

    it('defaults to max score (100) if alert fetch fails', async () => {
      userRepo.findById.mockResolvedValue({ id: 'inv1', kyc_risk_tier: 'low' } as any);
      alertRepo.findByInvestor.mockRejectedValue(new Error('DB error'));

      const score = await engine.calculateScore('inv1');
      expect(score).toBe(100);
    });
  });

  describe('updateWeights', () => {
    const newWeights = {
      kycTierWeights: { low: 0, standard: 5, elevated: 10, high: 20, restricted: 40 },
      amlSeverityWeights: { low: 2, medium: 5, high: 10, critical: 20 },
      baseScore: 10
    };

    it('updates weights if dual-control confirmation is true', async () => {
      await engine.updateWeights(newWeights, true, 'admin1');

      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'risk.score.weights.update',
          outcome: 'SUCCESS',
        })
      );

      // Verify the new weights take effect
      userRepo.findById.mockResolvedValue({ id: 'inv1', kyc_risk_tier: 'high' } as any);
      alertRepo.findByInvestor.mockResolvedValue([]);
      
      const score = await engine.calculateScore('inv1');
      // base (10) + high (20) = 30
      expect(score).toBe(30);
    });

    it('throws error and blocks if dual-control confirmation is false', async () => {
      await expect(engine.updateWeights(newWeights, false, 'admin1')).rejects.toThrow(
        'Dual-control confirmation is required'
      );

      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'risk.score.weights.update',
          outcome: 'BLOCKED',
        })
      );
    });
  });
});
