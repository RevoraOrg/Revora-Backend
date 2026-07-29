import { AMLAlertRepository } from './amlAlertRepository';
import { UserRepository } from '../db/repositories/userRepository';
import { SecurityAuditRepository, AuditEvent } from '../security/types';
import { KycRiskTier } from '../lib/kycRiskTierCaps';
import { AMLAlert, AMLSeverity } from './types';

export interface RiskScoreWeights {
  kycTierWeights: Record<KycRiskTier, number>;
  amlSeverityWeights: Record<AMLSeverity, number>;
  baseScore: number;
}

export const DEFAULT_RISK_WEIGHTS: RiskScoreWeights = {
  kycTierWeights: {
    'low': 0,
    'standard': 10,
    'elevated': 25,
    'high': 50,
    'restricted': 100 // worst-case
  },
  amlSeverityWeights: {
    'low': 5,
    'medium': 15,
    'high': 30,
    'critical': 50
  },
  baseScore: 0
};

export class RiskScoreEngine {
  private weights: RiskScoreWeights;

  constructor(
    private userRepo: UserRepository,
    private alertRepo: AMLAlertRepository,
    private auditRepo: SecurityAuditRepository,
    initialWeights: RiskScoreWeights = DEFAULT_RISK_WEIGHTS
  ) {
    this.weights = initialWeights;
  }

  /**
   * Compute deterministic risk score for investor.
   * Missing signals default to worst-case.
   */
  async calculateScore(investorId: string, actorId: string = 'system'): Promise<number> {
    let kycTier: KycRiskTier = 'restricted'; // default to worst case
    let alerts: AMLAlert[] = [];
    
    try {
      const user = await this.userRepo.findById(investorId);
      if (user && user.kyc_risk_tier) {
        kycTier = user.kyc_risk_tier;
      }
    } catch (error) {
      // Missing signal defaults to worst case (restricted)
    }

    try {
      alerts = await this.alertRepo.findByInvestor(investorId);
    } catch (error) {
      // If we can't get alerts, assume worst-case (critical alerts might exist, let's max out score)
      // Requirements: "Missing signal defaults to worst-case, never zero"
      const score = 100;
      await this.emitAudit(investorId, score, actorId);
      return score;
    }

    let score = this.weights.baseScore;
    
    // Add KYC weight
    score += this.weights.kycTierWeights[kycTier] ?? this.weights.kycTierWeights['restricted'];

    // Add AML weights (only non-dismissed alerts)
    const activeAlerts = alerts.filter(a => a.status !== 'dismissed');
    for (const alert of activeAlerts) {
      score += this.weights.amlSeverityWeights[alert.severity] ?? 0;
    }

    // Cap at 100
    const finalScore = Math.min(100, Math.max(0, score));

    await this.emitAudit(investorId, finalScore, actorId);
    return finalScore;
  }

  /**
   * Weights change requires dual-control audit.
   */
  async updateWeights(newWeights: RiskScoreWeights, confirmation: boolean, actorId: string): Promise<void> {
    if (!confirmation) {
      await this.auditRepo.record({
        id: this.generateAuditId(),
        type: 'SECURITY_VIOLATION',
        action: 'risk.score.weights.update',
        resource: 'global:risk_weights',
        outcome: 'BLOCKED',
        details: { reason: 'Missing dual-control confirmation' },
        securityContext: {
          requestId: '',
          ipAddress: '',
          userAgent: '',
          timestamp: new Date()
        },
        timestamp: new Date()
      });
      throw new Error('Dual-control confirmation is required to change risk weights');
    }

    const previousWeights = { ...this.weights };
    this.weights = newWeights;
    
    await this.auditRepo.record({
      id: this.generateAuditId(),
      type: 'AUTHORIZATION',
      action: 'risk.score.weights.update',
      resource: 'global:risk_weights',
      outcome: 'SUCCESS',
      details: {
        previous_weights: previousWeights,
        new_weights: newWeights,
        actor_id: actorId
      },
      securityContext: {
        requestId: '',
        ipAddress: '',
        userAgent: '',
        timestamp: new Date()
      },
      timestamp: new Date()
    });
  }

  private async emitAudit(investorId: string, score: number, actorId: string): Promise<void> {
    await this.auditRepo.record({
      id: this.generateAuditId(),
      type: 'VALIDATION',
      action: 'risk.score.recalculated',
      resource: `investor:${investorId}`,
      outcome: 'SUCCESS',
      details: {
        score,
        actor_id: actorId
      },
      securityContext: {
        requestId: '',
        ipAddress: '',
        userAgent: '',
        timestamp: new Date()
      },
      timestamp: new Date()
    });
  }

  private generateAuditId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
