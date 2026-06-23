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
import { CreateRuleInput, UpdateRuleInput, CreateCaseInput, UpdateCaseInput, SemVer } from './types';

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

  beforeEach(() => {
    ruleRepo = new MockRuleRepository();
    alertRepo = new MockAlertRepository();
    evaluator = new MockRuleEvaluator();
    auditRepo = new MockAuditRepository();
    service = new AMLService(ruleRepo as any, alertRepo as any, evaluator as any, auditRepo, 'test_user');
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
});
