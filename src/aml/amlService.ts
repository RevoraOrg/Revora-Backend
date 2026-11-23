/**
 * AML Service
 * 
 * Orchestrates AML transaction monitoring, rule evaluation,
 * and case management workflow with audit logging.
 */

import { Pool } from 'pg';
import { AMLRuleRepository } from './amlRuleRepository';
import { AMLAlertRepository } from './amlAlertRepository';
import { OFACReviewRepository } from './ofacReviewRepository';
import { RuleEvaluator } from './ruleEvaluator';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { SecurityAuditRepository, AuditEvent } from '../security/types';
import { TenantSettingsService } from '../services/tenantSettingsService';
import {
  AMLRule,
  CreateRuleInput,
  UpdateRuleInput,
  TransactionContext,
  CreateCaseInput,
  UpdateCaseInput,
  AMLCase,
  AMLAlert,
  CreateOFACReviewInput,
  OFACReview,
  SemVer,
} from './types';

/**
 * AML Service for transaction monitoring and case management
 */
export class AMLService {
  constructor(
    private ruleRepo: AMLRuleRepository,
    private alertRepo: AMLAlertRepository,
    private evaluator: RuleEvaluator,
    private auditRepo: SecurityAuditRepository,
    private currentUserId: string,
    private ofacReviewRepo?: OFACReviewRepository,
    /**
     * Optional: when provided, the per-tenant dual-control-approved
     * Jaro-Winkler sanctions threshold is loaded and attached to the
     * transaction context before rule evaluation, so that the
     * RuleEvaluator picks it up via context.tenant_settings.sanctions_threshold.
     *
     * Without this dependency the service falls back to the rule-config or
     * hard-coded 0.85 default — exactly the behaviour described in #1289.
     */
    private tenantSettingsService?: TenantSettingsService
  ) {}

  /**
   * Evaluate a transaction against all enabled rules
   *
   * If the context carries a `tenant_id` and no `tenant_settings` have been
   * pre-populated, the method fetches the dual-control-approved sanctions
   * threshold from TenantSettingsService and attaches it to the context so
   * that RuleEvaluator can apply it without being aware of the persistence
   * layer.  The original context object is **not mutated**; a shallow copy
   * is used instead to keep callers' state intact.
   *
   * @param context Transaction context
   * @returns Array of triggered alerts
   */
  async evaluateTransaction(context: TransactionContext): Promise<AMLAlert[]> {
    // Enrich context with tenant sanctions threshold when available.
    // This is the fix for #1289: without this block, approved threshold
    // changes were silently ignored and the evaluator always fell back to
    // the rule config or the 0.85 hard-coded default.
    let enrichedContext: TransactionContext = context;
    if (
      context.tenant_id &&
      !context.tenant_settings?.sanctions_threshold &&
      this.tenantSettingsService
    ) {
      const sanctions_threshold = await this.tenantSettingsService.getSanctionsThreshold(
        context.tenant_id
      );
      enrichedContext = {
        ...context,
        tenant_settings: {
          ...context.tenant_settings,
          sanctions_threshold,
        },
      };
    }

    const rules = await this.ruleRepo.findEnabled();
    const results = await this.evaluator.evaluate(enrichedContext, rules);

    const alerts: AMLAlert[] = [];

    for (const result of results) {
      if (result.triggered) {
        const alert = await this.alertRepo.create({
          investment_id: enrichedContext.investment_id,
          investor_id: enrichedContext.investor_id,
          rule_id: result.rule_id,
          rule_version: result.rule_version,
          severity: result.severity,
          details: result.details,
          status: 'pending',
        });

        alerts.push(alert);

        // Audit log the alert creation
        await this.auditRepo.record({
          id: this.generateAuditId(),
          type: 'SECURITY_VIOLATION',
          userId: enrichedContext.investor_id,
          action: 'aml_alert_created',
          resource: `aml_alert/${alert.id}`,
          outcome: 'SUCCESS',
          details: {
            alert_id: alert.id,
            rule_id: result.rule_id,
            severity: result.severity,
            investment_id: enrichedContext.investment_id,
          },
          securityContext: {
            requestId: this.generateRequestId(),
            ipAddress: 'system',
            userAgent: 'aml-service',
            timestamp: new Date(),
          },
          timestamp: new Date(),
        });
      }
    }

    return alerts;
  }

  /**
   * Create a new AML rule
   * @param input Rule creation data
   * @param actorId User ID of the actor performing the action (falls back to currentUserId if not provided)
   * @returns Created rule
   */
  async createRule(input: CreateRuleInput, actorId?: string): Promise<AMLRule> {
    const userId = actorId || this.currentUserId;
    const rule = await this.ruleRepo.create(input, userId);

    // Audit log rule creation
    await this.auditRepo.record({
      id: this.generateAuditId(),
      type: 'VALIDATION',
      userId,
      action: 'aml_rule_created',
      resource: `aml_rule/${rule.id}`,
      outcome: 'SUCCESS',
      details: {
        rule_id: rule.id,
        rule_name: rule.name,
        rule_type: rule.type,
        version: rule.version,
      },
      securityContext: {
        requestId: this.generateRequestId(),
        ipAddress: 'system',
        userAgent: 'aml-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    });

    return rule;
  }

  /**
   * Update an existing AML rule
   * @param ruleId Rule ID
   * @param input Update data
   * @param actorId User ID of the actor performing the action (falls back to currentUserId if not provided)
   * @returns Updated rule
   */
  async updateRule(ruleId: string, input: UpdateRuleInput, actorId?: string): Promise<AMLRule> {
    const userId = actorId || this.currentUserId;
    const rule = await this.ruleRepo.update(ruleId, input, userId);

    // Audit log rule update
    await this.auditRepo.record({
      id: this.generateAuditId(),
      type: 'VALIDATION',
      userId,
      action: 'aml_rule_updated',
      resource: `aml_rule/${ruleId}`,
      outcome: 'SUCCESS',
      details: {
        rule_id: ruleId,
        new_version: rule.version,
        change_reason: input.change_reason,
      },
      securityContext: {
        requestId: this.generateRequestId(),
        ipAddress: 'system',
        userAgent: 'aml-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    });

    return rule;
  }

  /**
   * Rollback a rule to a specific version
   * @param ruleId Rule ID
   * @param version Target version
   * @param actorId User ID of the actor performing the action (falls back to currentUserId if not provided)
   * @returns Updated rule
   */
  async rollbackRule(ruleId: string, version: SemVer, actorId?: string): Promise<AMLRule> {
    const userId = actorId || this.currentUserId;
    const rule = await this.ruleRepo.rollbackToVersion(ruleId, version, userId);

    // Audit log rollback
    await this.auditRepo.record({
      id: this.generateAuditId(),
      type: 'VALIDATION',
      userId,
      action: 'aml_rule_rollback',
      resource: `aml_rule/${ruleId}`,
      outcome: 'SUCCESS',
      details: {
        rule_id: ruleId,
        target_version: version,
        new_version: rule.version,
      },
      securityContext: {
        requestId: this.generateRequestId(),
        ipAddress: 'system',
        userAgent: 'aml-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    });

    return rule;
  }

  /**
   * Get all rules
   * @returns Array of rules
   */
  async getRules(): Promise<AMLRule[]> {
    return this.ruleRepo.findAll();
  }

  /**
   * Get enabled rules
   * @returns Array of enabled rules
   */
  async getEnabledRules(): Promise<AMLRule[]> {
    return this.ruleRepo.findEnabled();
  }

  /**
   * Get rule version history
   * @param ruleId Rule ID
   * @returns Version history
   */
  async getRuleHistory(ruleId: string) {
    return this.ruleRepo.getVersionHistory(ruleId);
  }

  /**
   * Create a new AML case
   * @param input Case creation data
   * @param actorId User ID of the actor performing the action (falls back to currentUserId if not provided)
   * @returns Created case
   */
  async createCase(input: CreateCaseInput, actorId?: string): Promise<AMLCase> {
    const userId = actorId || this.currentUserId;
    const amlCase = await this.alertRepo.createCase(input);

    // Audit log case creation
    await this.auditRepo.record({
      id: this.generateAuditId(),
      type: 'VALIDATION',
      userId,
      action: 'aml_case_created',
      resource: `aml_case/${ amlCase.id}`,
      outcome: 'SUCCESS',
      details: {
        case_id: amlCase.id,
        investor_id: input.investor_id,
        alert_count: input.alert_ids.length,
        assigned_to: input.assigned_to,
      },
      securityContext: {
        requestId: this.generateRequestId(),
        ipAddress: 'system',
        userAgent: 'aml-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    });

    return amlCase;
  }

  /**
   * Update an AML case
   * @param caseId Case ID
   * @param input Update data
   * @param actorId User ID of the actor performing the action (falls back to currentUserId if not provided)
   * @returns Updated case
   */
  async updateCase(caseId: string, input: UpdateCaseInput, actorId?: string): Promise<AMLCase> {
    const userId = actorId || this.currentUserId;
    const amlCase = await this.alertRepo.updateCase(caseId, input);

    // Audit log case update
    await this.auditRepo.record({
      id: this.generateAuditId(),
      type: 'VALIDATION',
      userId,
      action: 'aml_case_updated',
      resource: `aml_case/${caseId}`,
      outcome: 'SUCCESS',
      details: {
        case_id: caseId,
        status: input.status,
        disposition: input.disposition,
        assigned_to: input.assigned_to,
      },
      securityContext: {
        requestId: this.generateRequestId(),
        ipAddress: 'system',
        userAgent: 'aml-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    });

    return amlCase;
  }

  /**
   * Get case by ID
   * @param caseId Case ID
   * @returns Case or null
   */
  async getCase(caseId: string): Promise<AMLCase | null> {
    return this.alertRepo.findCaseById(caseId);
  }

  /**
   * Get cases by status
   * @param status Case status
   * @returns Array of cases
   */
  async getCasesByStatus(status: AMLCase['status']): Promise<AMLCase[]> {
    return this.alertRepo.findCasesByStatus(status);
  }

  /**
   * Get cases assigned to an analyst
   * @param analystId Analyst user ID
   * @returns Array of cases
   */
  async getCasesByAnalyst(analystId: string): Promise<AMLCase[]> {
    return this.alertRepo.findCasesByAnalyst(analystId);
  }

  /**
   * Get alerts for a case
   * @param caseId Case ID
   * @returns Array of alerts
   */
  async getCaseAlerts(caseId: string): Promise<AMLAlert[]> {
    return this.alertRepo.getAlertsForCase(caseId);
  }

  /**
   * Get pending alerts
   * @returns Array of pending alerts
   */
  async getPendingAlerts(): Promise<AMLAlert[]> {
    return this.alertRepo.findPending();
  }

  /**
   * Get alerts by investor
   * @param investorId Investor ID
   * @returns Array of alerts
   */
  async getInvestorAlerts(investorId: string): Promise<AMLAlert[]> {
    return this.alertRepo.findByInvestor(investorId);
  }

  /**
   * Dismiss an alert as false positive
   * @param alertId Alert ID
   * @param actorId User ID of the actor performing the action (falls back to currentUserId if not provided)
   * @returns Updated alert
   */
  async dismissAlert(alertId: string, actorId?: string): Promise<AMLAlert> {
    const userId = actorId || this.currentUserId;
    const alert = await this.alertRepo.updateStatus(alertId, 'dismissed');

    // Audit log alert dismissal
    await this.auditRepo.record({
      id: this.generateAuditId(),
      type: 'VALIDATION',
      userId,
      action: 'aml_alert_dismissed',
      resource: `aml_alert/${alertId}`,
      outcome: 'SUCCESS',
      details: {
        alert_id: alertId,
        investor_id: alert.investor_id,
      },
      securityContext: {
        requestId: this.generateRequestId(),
        ipAddress: 'system',
        userAgent: 'aml-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    });

    return alert;
  }

  async createOFACReview(input: CreateOFACReviewInput, creatorId = this.currentUserId): Promise<OFACReview> {
    const repo = this.requireOFACReviewRepo();
    const review = await repo.create(input, creatorId);

    await this.recordAudit('VALIDATION', creatorId, 'ofac_review_created', `ofac_review/${review.id}`, {
      review_id: review.id,
      alert_id: input.alert_id,
      investor_id: input.investor_id,
      matched_name: input.matched_name,
      expires_at: review.expires_at,
    });

    return review;
  }

  async getOFACReviewQueue(now = new Date()): Promise<OFACReview[]> {
    return this.requireOFACReviewRepo().findQueue(now);
  }

  async approveOFACReview(
    reviewId: string,
    approverId: string,
    rationale: string,
    now = new Date()
  ): Promise<OFACReview> {
    if (!rationale.trim()) {
      throw new Error('OFAC clearance rationale is required');
    }

    const repo = this.requireOFACReviewRepo();
    const before = await repo.findById(reviewId);
    const review = await repo.approve(reviewId, approverId, rationale, now);
    const action = review.status === 'cleared' ? 'ofac_review_cleared' : 'ofac_review_first_approved';

    await this.recordAudit('VALIDATION', approverId, action, `ofac_review/${review.id}`, {
      review_id: review.id,
      alert_id: review.alert_id,
      investor_id: review.investor_id,
      status: review.status,
      first_approver_id: review.first_approver_id,
      second_approver_id: review.second_approver_id,
      previous_status: before?.status,
      rationale,
    });

    return review;
  }

  /**
   * Generate unique audit ID
   */
  private generateAuditId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private requireOFACReviewRepo(): OFACReviewRepository {
    if (!this.ofacReviewRepo) {
      throw new Error('OFAC review repository is not configured');
    }
    return this.ofacReviewRepo;
  }

  private async recordAudit(
    type: AuditEvent['type'],
    userId: string,
    action: string,
    resource: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await this.auditRepo.record({
      id: this.generateAuditId(),
      type,
      userId,
      action,
      resource,
      outcome: 'SUCCESS',
      details,
      securityContext: {
        requestId: this.generateRequestId(),
        ipAddress: 'system',
        userAgent: 'aml-service',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    });
  }
}

/**
 * Factory function to create AMLService with dependencies
 */
export function createAMLService(db: Pool, auditRepo: SecurityAuditRepository, userId: string, tenantSettingsService?: TenantSettingsService): AMLService {
  const investmentRepo = new InvestmentRepository(db);
  const ruleRepo = new AMLRuleRepository(db);
  const alertRepo = new AMLAlertRepository(db);
  const ofacReviewRepo = new OFACReviewRepository(db);
  const evaluator = new RuleEvaluator(investmentRepo);

  return new AMLService(ruleRepo, alertRepo, evaluator, auditRepo, userId, ofacReviewRepo, tenantSettingsService);
}
