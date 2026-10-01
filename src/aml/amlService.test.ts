/**
 * AML Service Tests
 * 
 * Comprehensive test coverage for AML service layer including
 * rule management, case management, and audit logging.
 */

import { AMLService } from './amlService';
import { AMLRuleRepository } from './amlRuleRepository';
import { AMLAlertRepository } from './amlAlertRepository';
import { RuleEvaluator } from './ruleEvaluator';
import { SecurityAuditRepository, AuditEvent } from '../security/types';
import {
  CreateOFACReviewInput,
  CreateRuleInput,
  OFACReview,
  UpdateRuleInput,
  CreateCaseInput,
  UpdateCaseInput,
  SemVer,
} from './types';
import {
  RECORDED_PROVIDERS,
  assertNoPiiLeaks,
  findPiiLeaks,
  interactionByLabel,
  replayInteractions,
  replayProvider,
} from './fixtures/replay';
import { createRedactionContext, redactObject } from './fixtures/redaction';

// Mock repositories
class MockRuleRepository {
  private rules: any[] = [];
  private history: any[] = [];

  async create(input: CreateRuleInput, userId: string): Promise<any> {
    const rule = {
      id: `rule_${Date.now()}`,
      ...input,
      version: { major: 1, minor: 0, patch: 0 },
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.rules.push(rule);
    return rule;
  }

  async findById(ruleId: string): Promise<any> {
    return this.rules.find(r => r.id === ruleId) || null;
  }

  async findEnabled(): Promise<any[]> {
    return this.rules.filter(r => r.enabled);
  }

  async findAll(): Promise<any[]> {
    return this.rules;
  }

  async update(ruleId: string, input: UpdateRuleInput, userId: string): Promise<any> {
    const index = this.rules.findIndex(r => r.id === ruleId);
    if (index === -1) throw new Error('Rule not found');
    
    this.rules[index] = {
      ...this.rules[index],
      ...input,
      version: { major: 1, minor: 1, patch: 0 },
      updated_at: new Date(),
    };
    return this.rules[index];
  }

  async rollbackToVersion(ruleId: string, version: SemVer, userId: string): Promise<any> {
    const index = this.rules.findIndex(r => r.id === ruleId);
    if (index === -1) throw new Error('Rule not found');
    
    this.rules[index] = {
      ...this.rules[index],
      version: { major: version.major, minor: version.minor, patch: version.patch + 1 },
      updated_at: new Date(),
    };
    return this.rules[index];
  }

  async getVersionHistory(ruleId: string): Promise<any[]> {
    return this.history.filter(h => h.rule_id === ruleId);
  }
}

class MockAlertRepository {
  private alerts: any[] = [];
  private cases: any[] = [];

  async create(alert: any): Promise<any> {
    const newAlert = {
      id: `alert_${Date.now()}`,
      ...alert,
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.alerts.push(newAlert);
    return newAlert;
  }

  async findById(alertId: string): Promise<any> {
    return this.alerts.find(a => a.id === alertId) || null;
  }

  async findByInvestment(investmentId: string): Promise<any[]> {
    return this.alerts.filter(a => a.investment_id === investmentId);
  }

  async findByInvestor(investorId: string): Promise<any[]> {
    return this.alerts.filter(a => a.investor_id === investorId);
  }

  async findPending(): Promise<any[]> {
    return this.alerts.filter(a => a.status === 'pending' && !a.case_id);
  }

  async updateStatus(alertId: string, status: string, caseId?: string): Promise<any> {
    const index = this.alerts.findIndex(a => a.id === alertId);
    if (index === -1) throw new Error('Alert not found');
    
    this.alerts[index] = {
      ...this.alerts[index],
      status,
      case_id: caseId || null,
      updated_at: new Date(),
    };
    return this.alerts[index];
  }

  async createCase(input: CreateCaseInput): Promise<any> {
    const amlCase = {
      id: `case_${Date.now()}`,
      ...input,
      status: input.assigned_to ? 'assigned' : 'open',
      disposition: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    this.cases.push(amlCase);
    
    // Update alerts
    for (const alertId of input.alert_ids) {
      const alertIndex = this.alerts.findIndex(a => a.id === alertId);
      if (alertIndex !== -1) {
        this.alerts[alertIndex].status = 'reviewed';
        this.alerts[alertIndex].case_id = amlCase.id;
      }
    }
    
    return amlCase;
  }

  async findCaseById(caseId: string): Promise<any> {
    return this.cases.find(c => c.id === caseId) || null;
  }

  async findCasesByStatus(status: string): Promise<any[]> {
    return this.cases.filter(c => c.status === status);
  }

  async findCasesByAnalyst(analystId: string): Promise<any[]> {
    return this.cases.filter(c => c.assigned_to === analystId);
  }

  async updateCase(caseId: string, input: UpdateCaseInput): Promise<any> {
    const index = this.cases.findIndex(c => c.id === caseId);
    if (index === -1) throw new Error('Case not found');
    
    this.cases[index] = {
      ...this.cases[index],
      ...input,
      updated_at: new Date(),
      closed_at: (input.status === 'closed' || input.status === 'dismissed') ? new Date() : undefined,
    };
    return this.cases[index];
  }

  async getAlertsForCase(caseId: string): Promise<any[]> {
    return this.alerts.filter(a => a.case_id === caseId);
  }
}

class MockAuditRepository {
  private events: AuditEvent[] = [];

  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  async findByUserId(userId: string, limit?: number): Promise<AuditEvent[]> {
    return this.events.filter(e => e.userId === userId).slice(0, limit);
  }

  async findBySessionId(sessionId: string, limit?: number): Promise<AuditEvent[]> {
    return this.events.filter(e => e.sessionId === sessionId).slice(0, limit);
  }

  async findSecurityViolations(since: Date, limit?: number): Promise<AuditEvent[]> {
    return this.events.filter(e => e.type === 'SECURITY_VIOLATION' && e.timestamp >= since).slice(0, limit);
  }

  getEvents(): AuditEvent[] {
    return this.events;
  }

  clear(): void {
    this.events = [];
  }
}

class MockOFACReviewRepository {
  private reviews: OFACReview[] = [];

  async create(input: CreateOFACReviewInput, creatorId: string): Promise<OFACReview> {
    const review: OFACReview = {
      id: `ofac_${Date.now()}_${this.reviews.length}`,
      alert_id: input.alert_id,
      case_id: input.case_id,
      investor_id: input.investor_id,
      matched_name: input.matched_name,
      list_entry_id: input.list_entry_id,
      status: 'pending_first_approval',
      created_by: creatorId,
      created_at: new Date(),
      clearance_rationale: input.rationale,
      expires_at: input.expires_at || new Date(Date.now() + 86400000),
      updated_at: new Date(),
    };
    this.reviews.push(review);
    return review;
  }

  async findQueue(now = new Date()): Promise<OFACReview[]> {
    await this.reopenExpired(now);
    return this.reviews.filter(review =>
      review.status === 'pending_first_approval' || review.status === 'pending_second_approval'
    );
  }

  async findById(reviewId: string): Promise<OFACReview | null> {
    return this.reviews.find(review => review.id === reviewId) || null;
  }

  async approve(reviewId: string, approverId: string, rationale: string, now = new Date()): Promise<OFACReview> {
    const review = await this.findById(reviewId);
    if (!review) throw new Error(`OFAC review ${reviewId} not found`);

    if (review.expires_at.getTime() <= now.getTime() && review.status !== 'cleared') {
      review.status = 'pending_first_approval';
      review.first_approver_id = undefined;
      review.first_approval_rationale = undefined;
      review.first_approved_at = undefined;
    }

    if (review.created_by === approverId) {
      throw new Error('Review creator cannot approve their own OFAC clearance');
    }
    if (review.first_approver_id === approverId) {
      throw new Error('Same compliance officer cannot approve an OFAC review twice');
    }

    if (review.status === 'pending_first_approval') {
      review.status = 'pending_second_approval';
      review.first_approver_id = approverId;
      review.first_approval_rationale = rationale;
      review.first_approved_at = now;
      review.updated_at = now;
      return review;
    }

    review.status = 'cleared';
    review.second_approver_id = approverId;
    review.second_approval_rationale = rationale;
    review.second_approved_at = now;
    review.cleared_at = now;
    review.clearance_rationale = [
      review.clearance_rationale,
      `first approver ${review.first_approver_id}: ${review.first_approval_rationale}`,
      `second approver ${approverId}: ${rationale}`,
    ].join('\n');
    review.updated_at = now;
    return review;
  }

  async reopenExpired(now = new Date()): Promise<void> {
    for (const review of this.reviews) {
      if (review.status === 'pending_second_approval' && review.expires_at.getTime() <= now.getTime()) {
        review.status = 'pending_first_approval';
        review.first_approver_id = undefined;
        review.first_approval_rationale = undefined;
        review.first_approved_at = undefined;
        review.updated_at = now;
      }
    }
  }
}

class MockRuleEvaluator {
  async evaluate(context: any, rules: any[]): Promise<any[]> {
    return rules.map(rule => ({
      rule_id: rule.id,
      rule_version: rule.version,
      triggered: rule.type === 'amount_threshold' && parseFloat(context.amount) > 10000,
      severity: rule.severity,
      details: { test: true },
      timestamp: new Date(),
    }));
  }
}

describe('AMLService', () => {
  let service: AMLService;
  let ruleRepo: MockRuleRepository;
  let alertRepo: MockAlertRepository;
  let evaluator: MockRuleEvaluator;
  let auditRepo: MockAuditRepository;
  let ofacReviewRepo: MockOFACReviewRepository;

  beforeEach(() => {
    ruleRepo = new MockRuleRepository();
    alertRepo = new MockAlertRepository();
    evaluator = new MockRuleEvaluator();
    auditRepo = new MockAuditRepository();
    ofacReviewRepo = new MockOFACReviewRepository();
    service = new AMLService(ruleRepo as any, alertRepo as any, evaluator as any, auditRepo, 'test_user', ofacReviewRepo as any);
  });

  describe('Transaction Evaluation', () => {
    it('should evaluate transaction and create alerts for triggered rules', async () => {
      const rule = await ruleRepo.create({
        name: 'Test Rule',
        description: 'Test',
        type: 'amount_threshold',
        severity: 'high',
        config: { threshold: 10000 },
      }, 'test_user');

      const context = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '15000',
        asset: 'USD',
        timestamp: new Date(),
      };

      const alerts = await service.evaluateTransaction(context);

      expect(alerts).toHaveLength(1);
      expect(alerts[0].rule_id).toBe(rule.id);
      expect(alerts[0].status).toBe('pending');

      // Verify audit log
      const events = auditRepo.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('aml_alert_created');
    });

    it('should not create alerts when rules do not trigger', async () => {
      const rule = await ruleRepo.create({
        name: 'Test Rule',
        description: 'Test',
        type: 'amount_threshold',
        severity: 'high',
        config: { threshold: 10000 },
      }, 'test_user');

      const context = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '5000',
        asset: 'USD',
        timestamp: new Date(),
      };

      const alerts = await service.evaluateTransaction(context);

      expect(alerts).toHaveLength(0);
    });
  });

  describe('Rule Management', () => {
    it('should create a new rule with audit logging', async () => {
      const input: CreateRuleInput = {
        name: 'Velocity Rule',
        description: 'Detects high velocity',
        type: 'velocity',
        severity: 'high',
        config: { window_minutes: 60, max_amount: 10000, max_count: 10 },
      };

      const rule = await service.createRule(input);

      expect(rule.name).toBe(input.name);
      expect(rule.type).toBe(input.type);
      expect(rule.version).toEqual({ major: 1, minor: 0, patch: 0 });

      // Verify audit log
      const events = auditRepo.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('aml_rule_created');
    });

    it('should update a rule with version bump and audit logging', async () => {
      const rule = await ruleRepo.create({
        name: 'Test Rule',
        description: 'Test',
        type: 'velocity',
        severity: 'high',
        config: { window_minutes: 60, max_amount: 10000, max_count: 10 },
      }, 'test_user');

      const input: UpdateRuleInput = {
        enabled: false,
        change_reason: 'Disabling for testing',
      };

      const updated = await service.updateRule(rule.id, input);

      expect(updated.enabled).toBe(false);
      expect(updated.version.minor).toBe(1);

      // Verify audit log
      const events = auditRepo.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('aml_rule_updated');
    });

    it('should rollback rule to previous version with audit logging', async () => {
      const rule = await ruleRepo.create({
        name: 'Test Rule',
        description: 'Test',
        type: 'velocity',
        severity: 'high',
        config: { window_minutes: 60, max_amount: 10000, max_count: 10 },
      }, 'test_user');

      const targetVersion: SemVer = { major: 1, minor: 0, patch: 0 };

      const rolledBack = await service.rollbackRule(rule.id, targetVersion);

      expect(rolledBack.version.patch).toBe(1);

      // Verify audit log
      const events = auditRepo.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('aml_rule_rollback');
    });

    it('should get all rules', async () => {
      await ruleRepo.create({ name: 'Rule 1', description: 'Test', type: 'velocity', severity: 'high', config: {} }, 'user');
      await ruleRepo.create({ name: 'Rule 2', description: 'Test', type: 'structuring', severity: 'medium', config: {} }, 'user');

      const rules = await service.getRules();

      expect(rules).toHaveLength(2);
    });

    it('should get enabled rules only', async () => {
      await ruleRepo.create({ name: 'Rule 1', description: 'Test', type: 'velocity', severity: 'high', config: {} }, 'user');
      const rule2 = await ruleRepo.create({ name: 'Rule 2', description: 'Test', type: 'structuring', severity: 'medium', config: {} }, 'user');
      await ruleRepo.update(rule2.id, { enabled: false, change_reason: 'Test' }, 'user');

      const enabledRules = await service.getEnabledRules();

      expect(enabledRules).toHaveLength(1);
      expect(enabledRules[0].enabled).toBe(true);
    });
  });

  describe('Case Management', () => {
    it('should create a case with audit logging', async () => {
      const alert = await alertRepo.create({
        investment_id: 'inv1',
        investor_id: 'inv1',
        rule_id: 'rule1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: {},
        status: 'pending',
      });

      const input: CreateCaseInput = {
        alert_ids: [alert.id],
        investor_id: 'inv1',
        assigned_to: 'analyst1',
        notes: 'Initial review',
      };

      const amlCase = await service.createCase(input);

      expect(amlCase.status).toBe('assigned');
      expect(amlCase.assigned_to).toBe('analyst1');

      // Verify audit log
      const events = auditRepo.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('aml_case_created');
    });

    it('should update a case with audit logging', async () => {
      const alert = await alertRepo.create({
        investment_id: 'inv1',
        investor_id: 'inv1',
        rule_id: 'rule1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: {},
        status: 'pending',
      });

      const amlCase = await alertRepo.createCase({
        alert_ids: [alert.id],
        investor_id: 'inv1',
      });

      const input: UpdateCaseInput = {
        status: 'closed',
        disposition: 'false_positive',
        notes: 'Investigation complete',
      };

      const updated = await service.updateCase(amlCase.id, input);

      expect(updated.status).toBe('closed');
      expect(updated.disposition).toBe('false_positive');
      expect(updated.closed_at).toBeDefined();

      // Verify audit log
      const events = auditRepo.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('aml_case_updated');
    });

    it('should get case by ID', async () => {
      const alert = await alertRepo.create({
        investment_id: 'inv1',
        investor_id: 'inv1',
        rule_id: 'rule1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: {},
        status: 'pending',
      });

      const amlCase = await alertRepo.createCase({
        alert_ids: [alert.id],
        investor_id: 'inv1',
      });

      const found = await service.getCase(amlCase.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(amlCase.id);
    });

    it('should get cases by status', async () => {
      const alert = await alertRepo.create({
        investment_id: 'inv1',
        investor_id: 'inv1',
        rule_id: 'rule1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: {},
        status: 'pending',
      });

      await alertRepo.createCase({ alert_ids: [alert.id], investor_id: 'inv1' });

      const cases = await service.getCasesByStatus('open');

      expect(cases).toHaveLength(1);
    });

    it('should get cases by analyst', async () => {
      const alert = await alertRepo.create({
        investment_id: 'inv1',
        investor_id: 'inv1',
        rule_id: 'rule1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: {},
        status: 'pending',
      });

      await alertRepo.createCase({
        alert_ids: [alert.id],
        investor_id: 'inv1',
        assigned_to: 'analyst1',
      });

      const cases = await service.getCasesByAnalyst('analyst1');

      expect(cases).toHaveLength(1);
    });

    it('should get alerts for a case', async () => {
      const alert = await alertRepo.create({
        investment_id: 'inv1',
        investor_id: 'inv1',
        rule_id: 'rule1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: {},
        status: 'pending',
      });

      const amlCase = await alertRepo.createCase({
        alert_ids: [alert.id],
        investor_id: 'inv1',
      });

      const alerts = await service.getCaseAlerts(amlCase.id);

      expect(alerts).toHaveLength(1);
      expect(alerts[0].id).toBe(alert.id);
    });
  });

  describe('Alert Management', () => {
    it('should get pending alerts', async () => {
      await alertRepo.create({
        investment_id: 'inv1',
        investor_id: 'inv1',
        rule_id: 'rule1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: {},
        status: 'pending',
      });

      const pending = await service.getPendingAlerts();

      expect(pending).toHaveLength(1);
    });

    it('should get alerts by investor', async () => {
      await alertRepo.create({
        investment_id: 'inv1',
        investor_id: 'inv1',
        rule_id: 'rule1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: {},
        status: 'pending',
      });

      const alerts = await service.getInvestorAlerts('inv1');

      expect(alerts).toHaveLength(1);
    });

    it('should dismiss alert with audit logging', async () => {
      const alert = await alertRepo.create({
        investment_id: 'inv1',
        investor_id: 'inv1',
        rule_id: 'rule1',
        rule_version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        details: {},
        status: 'pending',
      });

      const dismissed = await service.dismissAlert(alert.id);

      expect(dismissed.status).toBe('dismissed');

      // Verify audit log
      const events = auditRepo.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('aml_alert_dismissed');
    });
  });

  describe('OFAC Review Queue', () => {
    const createReview = async (expires_at?: Date) => service.createOFACReview({
      alert_id: 'alert_ofac_1',
      investor_id: 'investor_1',
      matched_name: 'John Smith',
      list_entry_id: 'ofac_sdn_123',
      rationale: 'Documented legal name collision with verified date of birth mismatch.',
      expires_at,
    }, 'case_creator');

    it('should require two independent approvals before clearing a review', async () => {
      const review = await createReview();

      const first = await service.approveOFACReview(review.id, 'officer_1', 'Government ID and DOB do not match SDN entry.');
      expect(first.status).toBe('pending_second_approval');

      const cleared = await service.approveOFACReview(review.id, 'officer_2', 'Second review confirms false positive.');
      expect(cleared.status).toBe('cleared');
      expect(cleared.first_approver_id).toBe('officer_1');
      expect(cleared.second_approver_id).toBe('officer_2');

      const events = auditRepo.getEvents();
      expect(events.map(event => event.action)).toEqual([
        'ofac_review_created',
        'ofac_review_first_approved',
        'ofac_review_cleared',
      ]);
    });

    it('should reject same-user double approval', async () => {
      const review = await createReview();
      await service.approveOFACReview(review.id, 'officer_1', 'First review rationale is complete.');

      await expect(
        service.approveOFACReview(review.id, 'officer_1', 'Trying to approve twice.')
      ).rejects.toThrow('Same compliance officer cannot approve an OFAC review twice');
    });

    it('should reject approval from the case creator', async () => {
      const review = await createReview();

      await expect(
        service.approveOFACReview(review.id, 'case_creator', 'Creator attempts clearance.')
      ).rejects.toThrow('Review creator cannot approve their own OFAC clearance');
    });

    it('should re-enter expired pending reviews into the first-approval queue', async () => {
      const expiresAt = new Date(Date.now() + 1000);
      const review = await createReview(expiresAt);
      await service.approveOFACReview(review.id, 'officer_1', 'Initial review before timeout.');

      const queue = await service.getOFACReviewQueue(new Date(expiresAt.getTime() + 1000));

      expect(queue).toHaveLength(1);
      expect(queue[0].status).toBe('pending_first_approval');
      expect(queue[0].first_approver_id).toBeUndefined();
    });
  });

  describe('OFAC Review Failure Handling', () => {
    const createReview = async (expires_at?: Date) => service.createOFACReview({
      alert_id: 'alert_ofac_1',
      investor_id: 'investor_1',
      matched_name: 'John Smith',
      list_entry_id: 'ofac_sdn_123',
      rationale: 'Documented legal name collision with verified date of birth mismatch.',
      expires_at,
    }, 'case_creator');

    it.each([
      ['empty string', ''],
      ['single space', ' '],
      ['spaces only', '   '],
      ['tab only', '\t'],
      ['newline only', '\n'],
      ['mixed whitespace', ' \t\r\n '],
      ['non-breaking space', '\u00a0'],
    ])('rejects a %s rationale without touching the repository or audit trail', async (_label, rationale) => {
      const review = await createReview();
      const before = auditRepo.getEvents();
      const findByIdSpy = jest.spyOn(ofacReviewRepo, 'findById');
      const approveSpy = jest.spyOn(ofacReviewRepo, 'approve');

      await expect(
        service.approveOFACReview(review.id, 'officer_1', rationale)
      ).rejects.toThrow('OFAC clearance rationale is required');

      // The guard must run before any repository read/write or audit write.
      expect(findByIdSpy).not.toHaveBeenCalled();
      expect(approveSpy).not.toHaveBeenCalled();
      expect(auditRepo.getEvents()).toHaveLength(before.length);
      expect(review.status).toBe('pending_first_approval');
      expect(review.first_approver_id).toBeUndefined();
    });

    it('validates the rationale before resolving a missing OFAC repository', async () => {
      const noRepoService = new AMLService(
        ruleRepo as unknown as AMLRuleRepository,
        alertRepo as unknown as AMLAlertRepository,
        evaluator as unknown as RuleEvaluator,
        auditRepo,
        'test_user'
      );

      // A blank rationale is a caller error regardless of wiring; the rationale
      // guard must win over the "repository is not configured" guard.
      await expect(
        noRepoService.approveOFACReview('ofac_any', 'officer_1', '   ')
      ).rejects.toThrow('OFAC clearance rationale is required');
    });

    it('throws when the OFAC review repository is not configured', async () => {
      const noRepoService = new AMLService(
        ruleRepo as unknown as AMLRuleRepository,
        alertRepo as unknown as AMLAlertRepository,
        evaluator as unknown as RuleEvaluator,
        auditRepo,
        'test_user'
      );

      await expect(noRepoService.createOFACReview({
        alert_id: 'alert_ofac_1',
        investor_id: 'investor_1',
        matched_name: 'John Smith',
        rationale: 'Documented legal name collision with verified date of birth mismatch.',
      })).rejects.toThrow('OFAC review repository is not configured');

      await expect(noRepoService.getOFACReviewQueue()).rejects.toThrow(
        'OFAC review repository is not configured'
      );

      await expect(
        noRepoService.approveOFACReview('ofac_any', 'officer_1', 'Valid rationale that is not blank.')
      ).rejects.toThrow('OFAC review repository is not configured');

      // Wiring failures must not emit audit events claiming compliance activity.
      expect(auditRepo.getEvents()).toHaveLength(0);
    });

    it('returns an empty queue when no reviews are pending and excludes cleared reviews', async () => {
      // Empty-result branch: no reviews queued at all.
      await expect(service.getOFACReviewQueue()).resolves.toEqual([]);

      const review = await createReview();
      expect(await service.getOFACReviewQueue()).toHaveLength(1);

      await service.approveOFACReview(review.id, 'officer_1', 'First review rationale is complete.');
      await service.approveOFACReview(review.id, 'officer_2', 'Second review confirms false positive.');

      // Cleared reviews are no longer actionable and must drop out of the queue.
      const queue = await service.getOFACReviewQueue();
      expect(queue).toHaveLength(0);
      expect(queue.find(entry => entry.id === review.id)).toBeUndefined();
    });

    it('accepts the shortest non-blank rationale and preserves it verbatim', async () => {
      const review = await createReview();
      const rationale = ' x '; // 1 non-whitespace char, padded -> valid and stored as-is

      const first = await service.approveOFACReview(review.id, 'officer_1', rationale);

      expect(first.status).toBe('pending_second_approval');
      expect(first.first_approval_rationale).toBe(rationale);

      const firstEvent = auditRepo.getEvents().find(
        event => event.action === 'ofac_review_first_approved'
      );
      expect(firstEvent?.resource).toBe(`ofac_review/${review.id}`);
      expect(firstEvent?.details).toMatchObject({
        review_id: review.id,
        alert_id: 'alert_ofac_1',
        investor_id: 'investor_1',
        status: 'pending_second_approval',
        first_approver_id: 'officer_1',
        rationale,
      });

      const cleared = await service.approveOFACReview(review.id, 'officer_2', 'Second review confirms.');
      expect(cleared.status).toBe('cleared');

      const clearedEvent = auditRepo.getEvents().find(
        event => event.action === 'ofac_review_cleared'
      );
      expect(clearedEvent?.details).toMatchObject({
        review_id: review.id,
        status: 'cleared',
        first_approver_id: 'officer_1',
        second_approver_id: 'officer_2',
        rationale: 'Second review confirms.',
      });
    });
  });
});

  /**
   * Provider fixture replay (#755).
   *
   * The recorder/redaction harness landed in #594 but was only ever exercised
   * by its own unit tests — `amlService.test.ts` never replayed a trace, so a
   * fixture that leaked PII could still land green. These tests replay every
   * checked-in provider fixture in CI and fail the build on any leak.
   */
  describe('Provider Fixture Replay', () => {
    it('should ship a fixture for every recorded provider', async () => {
      expect(RECORDED_PROVIDERS.length).toBeGreaterThan(0);

      for (const provider of RECORDED_PROVIDERS) {
        const fixture = await replayProvider(provider);
        expect(fixture.provider).toBe(provider);
      }
    });

    it('should leak no PII or credentials in any recorded fixture', async () => {
      for (const provider of RECORDED_PROVIDERS) {
        const fixture = await replayProvider(provider);
        expect({ provider, leaks: findPiiLeaks(fixture) }).toEqual({
          provider,
          leaks: [],
        });
        expect(() => assertNoPiiLeaks(fixture)).not.toThrow();
      }
    });

    it('should replay interactions in recorded order with a non-empty body', async () => {
      for (const provider of RECORDED_PROVIDERS) {
        const fixture = await replayProvider(provider);
        const interactions = replayInteractions(fixture);

        expect(interactions.length).toBeGreaterThan(0);
        for (const interaction of interactions) {
          expect(interaction.label).toBeTruthy();
          expect(interaction.request.method).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/);
          expect(interaction.request.path).toMatch(/^\//);
          expect(interaction.response.status).toBeGreaterThanOrEqual(100);
          expect(interaction.response.status).toBeLessThan(600);
          expect(interaction.request.timestamp).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
          );
        }
      }
    });

    it('should replay deterministically across repeated loads', async () => {
      const first = await replayProvider('sumsub');
      const second = await replayProvider('sumsub');

      expect(JSON.stringify(replayInteractions(first))).toBe(
        JSON.stringify(replayInteractions(second)),
      );
    });

    it('should allow per-label lookup for adapter assertions', async () => {
      const sumsub = await replayProvider('sumsub');
      const jumio = await replayProvider('jumio');

      expect(interactionByLabel(sumsub, 'applicant_created')).toBeDefined();
      expect(interactionByLabel(sumsub, 'check_complete')).toBeDefined();
      expect(interactionByLabel(jumio, 'verify_customer')).toBeDefined();
      expect(interactionByLabel(sumsub, 'does_not_exist')).toBeUndefined();
    });

    it('should keep provider error responses replayable for negative paths', async () => {
      // Error traces must survive redaction too: an adapter's failure mapping is
      // as much of a contract as its success mapping.
      const jumio = await replayProvider('jumio');
      const notFound = interactionByLabel(jumio, 'transaction_not_found');

      expect(notFound).toBeDefined();
      expect(notFound!.response.status).toBe(404);
      expect(() => assertNoPiiLeaks(jumio)).not.toThrow();
    });

    it('should redact a raw PII payload through the engine with no leak', async () => {
      // Round-trips a realistic un-redacted vendor payload through the
      // redactor, then asserts the leak scanner catches nothing.
      const ctx = createRedactionContext();
      const raw = {
        applicant: {
          firstName: 'Jane',
          lastName: 'Doe',
          email: 'jane.doe@example.com',
          phone: '+14155552671',
          dateOfBirth: '1985-04-12',
          address: '742 Evergreen Terrace, Springfield',
        },
        document: {
          type: 'passport',
          number: 'X1234567',
        },
        meta: {
          ipAddress: '203.0.113.42',
          apiKey: 'sk_live_9f8a7b6c5d4e3f2a',
          sessionToken: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
        },
      };

      const redacted = redactObject(raw, ctx);

      const serialized = JSON.stringify(redacted);
      expect(serialized).not.toContain('jane.doe@example.com');
      expect(serialized).not.toContain('+14155552671');
      expect(serialized).not.toContain('203.0.113.42');
      expect(serialized).not.toContain('sk_live_9f8a7b6c5d4e3f2a');
      expect(serialized).not.toContain('Evergreen Terrace');
      expect(serialized).not.toContain('1985-04-12');

      // Non-PII enums must survive redaction untouched.
      const typed = redacted as typeof raw;
      expect(typed.document.type).toBe('passport');
    });

    it('should detect a leak when raw PII is injected into a fixture', async () => {
      // Negative control: proves the scanner actually fails, so the passing
      // assertions above are not vacuous.
      const fixture = await replayProvider('jumio');
      const tampered = {
        ...fixture,
        interactions: fixture.interactions.map((interaction, i) =>
          i === 0
            ? {
                ...interaction,
                response: {
                  ...interaction.response,
                  body: { ...(interaction.response.body as object), email: 'leak@example.com' },
                },
              }
            : interaction,
        ),
      };

      const leaks = findPiiLeaks(tampered);
      expect(leaks.length).toBeGreaterThan(0);
      expect(leaks.join('\n')).toMatch(/email/);
      expect(() => assertNoPiiLeaks(tampered)).toThrow(/leaks PII/);
    });

    it('should detect credential-shaped headers left un-redacted', async () => {
      const fixture = await replayProvider('sumsub');
      const tampered = {
        ...fixture,
        interactions: fixture.interactions.map((interaction, i) =>
          i === 0
            ? {
                ...interaction,
                request: {
                  ...interaction.request,
                  headers: { ...interaction.request.headers, Authorization: 'Bearer eyJhbGciOiJI' },
                },
              }
            : interaction,
        ),
      };

      expect(findPiiLeaks(tampered).length).toBeGreaterThan(0);
    });

    it('should not flag benign recorded values as leaks', () => {
      // Guards the scanner against becoming so noisy that real leaks get
      // dismissed as false positives.
      const clean = {
        provider: 'sumsub',
        version: 1 as const,
        recordedAt: '2026-01-15T12:00:00.000Z',
        interactions: [],
        redaction: { totalRedactions: 0, placeholderCount: 0 },
      };

      expect(findPiiLeaks(clean)).toEqual([]);
    });
  });
