/**
 * Rule Evaluator Tests
 * 
 * Comprehensive test coverage for AML rule evaluation engine.
 * Tests velocity, structuring, geo-mismatch, and amount threshold rules.
 */

import { RuleEvaluator } from './ruleEvaluator';
import { AMLRule, TransactionContext } from './types';
import { InvestmentRepository } from '../db/repositories/investmentRepository';

// Mock InvestmentRepository
class MockInvestmentRepository {
  private investments: any[] = [];

  setInvestments(investments: any[]) {
    this.investments = investments;
  }

  async listByInvestor(options: any): Promise<any[]> {
    return this.investments.filter(inv => 
      inv.investor_id === options.investor_id &&
      (!options.offering_id || inv.offering_id === options.offering_id)
    );
  }
}

describe('RuleEvaluator', () => {
  let evaluator: RuleEvaluator;
  let mockRepo: MockInvestmentRepository;

  beforeEach(() => {
    mockRepo = new MockInvestmentRepository();
    evaluator = new RuleEvaluator(mockRepo as any);
  });

  describe('Velocity Rule Evaluation', () => {
    it('should trigger when transaction count exceeds limit', async () => {
      const rule: AMLRule = {
        id: 'rule1',
        name: 'High Velocity',
        description: 'Detects high transaction frequency',
        type: 'velocity',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        enabled: true,
        config: {
          window_minutes: 60,
          max_amount: 10000,
          max_count: 5,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '100',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [
          {
            investment_id: 'inv2',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '100',
            asset: 'USD',
            timestamp: new Date(Date.now() - 30 * 60 * 1000),
            status: 'completed',
          },
          {
            investment_id: 'inv3',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '100',
            asset: 'USD',
            timestamp: new Date(Date.now() - 25 * 60 * 1000),
            status: 'completed',
          },
          {
            investment_id: 'inv4',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '100',
            asset: 'USD',
            timestamp: new Date(Date.now() - 20 * 60 * 1000),
            status: 'completed',
          },
          {
            investment_id: 'inv5',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '100',
            asset: 'USD',
            timestamp: new Date(Date.now() - 15 * 60 * 1000),
            status: 'completed',
          },
          {
            investment_id: 'inv6',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '100',
            asset: 'USD',
            timestamp: new Date(Date.now() - 10 * 60 * 1000),
            status: 'completed',
          },
        ],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].details.count_exceeded).toBe(true);
    });

    it('should trigger when total amount exceeds limit', async () => {
      const rule: AMLRule = {
        id: 'rule1',
        name: 'High Velocity',
        description: 'Detects high transaction amount',
        type: 'velocity',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        enabled: true,
        config: {
          window_minutes: 60,
          max_amount: 1000,
          max_count: 100,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '600',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [
          {
            investment_id: 'inv2',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '500',
            asset: 'USD',
            timestamp: new Date(Date.now() - 30 * 60 * 1000),
            status: 'completed',
          },
        ],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].details.amount_exceeded).toBe(true);
    });

    it('should not trigger when within limits', async () => {
      const rule: AMLRule = {
        id: 'rule1',
        name: 'High Velocity',
        description: 'Detects high transaction frequency',
        type: 'velocity',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        enabled: true,
        config: {
          window_minutes: 60,
          max_amount: 10000,
          max_count: 10,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '100',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(false);
    });

    it('should ignore failed transactions in velocity calculation', async () => {
      const rule: AMLRule = {
        id: 'rule1',
        name: 'High Velocity',
        description: 'Detects high transaction frequency',
        type: 'velocity',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        enabled: true,
        config: {
          window_minutes: 60,
          max_amount: 10000,
          max_count: 2,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '100',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [
          {
            investment_id: 'inv2',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '100',
            asset: 'USD',
            timestamp: new Date(Date.now() - 30 * 60 * 1000),
            status: 'failed',
          },
          {
            investment_id: 'inv3',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '100',
            asset: 'USD',
            timestamp: new Date(Date.now() - 20 * 60 * 1000),
            status: 'failed',
          },
        ],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(false);
    });
  });

  describe('Structuring Rule Evaluation', () => {
    it('should detect transaction splitting', async () => {
      const rule: AMLRule = {
        id: 'rule2',
        name: 'Structuring Detection',
        description: 'Detects transaction splitting',
        type: 'structuring',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        enabled: true,
        config: {
          window_hours: 24,
          amount_threshold: 100,
          min_transactions: 3,
          reporting_threshold: 9000,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '3000',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [
          {
            investment_id: 'inv2',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '3050',
            asset: 'USD',
            timestamp: new Date(Date.now() - 18 * 60 * 60 * 1000),
            status: 'completed',
          },
          {
            investment_id: 'inv3',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '2950',
            asset: 'USD',
            timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000),
            status: 'completed',
          },
          {
            investment_id: 'inv4',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '3020',
            asset: 'USD',
            timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000),
            status: 'completed',
          },
        ],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].details.similar_transaction_count).toBe(3);
    });

    it('should not trigger when below min transaction threshold', async () => {
      const rule: AMLRule = {
        id: 'rule2',
        name: 'Structuring Detection',
        description: 'Detects transaction splitting',
        type: 'structuring',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        enabled: true,
        config: {
          window_hours: 24,
          amount_threshold: 100,
          min_transactions: 5,
          reporting_threshold: 9000,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '3000',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [
          {
            investment_id: 'inv2',
            investor_id: 'inv1',
            offering_id: 'off1',
            amount: '3050',
            asset: 'USD',
            timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000),
            status: 'completed',
          },
        ],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(false);
    });
  });

  describe('Geo-Mismatch Rule Evaluation', () => {
    it('should trigger on country mismatch', async () => {
      const rule: AMLRule = {
        id: 'rule3',
        name: 'Geo Mismatch',
        description: 'Detects geographic inconsistencies',
        type: 'geo_mismatch',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'medium',
        enabled: true,
        config: {
          high_risk_countries: ['XX', 'YY'],
          max_country_changes: 3,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '100',
        asset: 'USD',
        timestamp: new Date(),
        investor_country: 'US',
        investor_ip_country: 'GB',
        previous_transactions: [],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].details.is_mismatch).toBe(true);
    });

    it('should trigger on high-risk country', async () => {
      const rule: AMLRule = {
        id: 'rule3',
        name: 'Geo Mismatch',
        description: 'Detects geographic inconsistencies',
        type: 'geo_mismatch',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'high',
        enabled: true,
        config: {
          high_risk_countries: ['XX', 'YY'],
          max_country_changes: 3,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '100',
        asset: 'USD',
        timestamp: new Date(),
        investor_country: 'XX',
        investor_ip_country: 'XX',
        previous_transactions: [],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].details.is_high_risk).toBe(true);
    });

    it('should not trigger without geo data', async () => {
      const rule: AMLRule = {
        id: 'rule3',
        name: 'Geo Mismatch',
        description: 'Detects geographic inconsistencies',
        type: 'geo_mismatch',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'medium',
        enabled: true,
        config: {
          high_risk_countries: ['XX', 'YY'],
          max_country_changes: 3,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '100',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(false);
      expect(results[0].details.reason).toBe('Insufficient geo data');
    });
  });

  describe('Amount Threshold Rule Evaluation', () => {
    it('should trigger when amount exceeds threshold', async () => {
      const rule: AMLRule = {
        id: 'rule4',
        name: 'Amount Threshold',
        description: 'Detects large single transactions',
        type: 'amount_threshold',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'critical',
        enabled: true,
        config: {
          threshold: 10000,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '15000',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
    });

    it('should not trigger when amount below threshold', async () => {
      const rule: AMLRule = {
        id: 'rule4',
        name: 'Amount Threshold',
        description: 'Detects large single transactions',
        type: 'amount_threshold',
        version: { major: 1, minor: 0, patch: 0 },
        severity: 'critical',
        enabled: true,
        config: {
          threshold: 10000,
        },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '5000',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [],
      };

      const results = await evaluator.evaluate(context, [rule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(false);
    });
  });

  describe('Sanctions Screening Rule Evaluation', () => {
    const sanctionsRule: AMLRule = {
      id: 'sanctions_rule_1',
      name: 'Sanctions Screening',
      description: 'Screens investor against sanctions watchlist with Jaro-Winkler fuzzy matching',
      type: 'sanctions_screening',
      version: { major: 1, minor: 0, patch: 0 },
      severity: 'critical',
      enabled: true,
      config: {
        sanctions_list: ['Alexander Petrov', 'John Smith', 'Vladimir Putin'],
        jaro_winkler_threshold: 0.85,
        fuzzy_enabled: true,
      },
      created_at: new Date(),
      updated_at: new Date(),
    };

    it('triggers exact match with auto_deny: true', async () => {
      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '1000',
        asset: 'USD',
        timestamp: new Date(),
        investor_name: 'John Smith',
      };

      const results = await evaluator.evaluate(context, [sanctionsRule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].details.match_type).toBe('exact');
      expect(results[0].details.action).toBe('auto_deny');
      expect(results[0].details.auto_deny).toBe(true);
    });

    it('triggers fuzzy match with action: pending_review and auto_deny: false', async () => {
      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '1000',
        asset: 'USD',
        timestamp: new Date(),
        investor_name: 'Aleksander Petrov', // Transliteration / spelling variation of Alexander Petrov
      };

      const results = await evaluator.evaluate(context, [sanctionsRule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].details.match_type).toBe('fuzzy');
      expect(results[0].details.action).toBe('pending_review');
      expect(results[0].details.auto_deny).toBe(false);
      expect(results[0].details.review_status).toBe('pending_review');
    });

    it('detects Cyrillic-to-Latin transliterations', async () => {
      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '1000',
        asset: 'USD',
        timestamp: new Date(),
        investor_name: 'Александр Петров', // Cyrillic for Alexander Petrov
      };

      const results = await evaluator.evaluate(context, [sanctionsRule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(true);
      expect(results[0].details.matched_candidate).toBe('Alexander Petrov');
      expect(results[0].details.action).toBe('pending_review');
      expect(results[0].details.auto_deny).toBe(false);
    });

    it('respects per-tenant threshold overrides in context.tenant_settings', async () => {
      const contextStrict: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '1000',
        asset: 'USD',
        timestamp: new Date(),
        investor_name: 'Jon Smithy',
        tenant_settings: {
          sanctions_threshold: 0.95, // Very strict threshold
        },
      };

      const resultsStrict = await evaluator.evaluate(contextStrict, [sanctionsRule]);
      expect(resultsStrict[0].triggered).toBe(false);

      const contextPermissive: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '1000',
        asset: 'USD',
        timestamp: new Date(),
        investor_name: 'Jon Smithy',
        tenant_settings: {
          sanctions_threshold: 0.75, // Lower threshold
        },
      };

      const resultsPermissive = await evaluator.evaluate(contextPermissive, [sanctionsRule]);
      expect(resultsPermissive[0].triggered).toBe(true);
      expect(resultsPermissive[0].details.match_type).toBe('fuzzy');
      expect(resultsPermissive[0].details.action).toBe('pending_review');
    });

    it('does not trigger for unrelated names below threshold', async () => {
      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '1000',
        asset: 'USD',
        timestamp: new Date(),
        investor_name: 'Robert Johnson',
      };

      const results = await evaluator.evaluate(context, [sanctionsRule]);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(false);
    });
  });

  describe('Multiple Rule Evaluation', () => {
    it('should evaluate multiple rules and return all results', async () => {
      const rules: AMLRule[] = [
        {
          id: 'rule1',
          name: 'Amount Threshold',
          description: 'Detects large transactions',
          type: 'amount_threshold',
          version: { major: 1, minor: 0, patch: 0 },
          severity: 'critical',
          enabled: true,
          config: { threshold: 10000 },
          created_at: new Date(),
          updated_at: new Date(),
        },
        {
          id: 'rule2',
          name: 'Velocity',
          description: 'Detects high frequency',
          type: 'velocity',
          version: { major: 1, minor: 0, patch: 0 },
          severity: 'high',
          enabled: true,
          config: { window_minutes: 60, max_amount: 100000, max_count: 10 },
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '15000',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [],
      };

      const results = await evaluator.evaluate(context, rules);
      expect(results).toHaveLength(2);
      expect(results[0].rule_id).toBe('rule1');
      expect(results[1].rule_id).toBe('rule2');
    });

    it('should skip disabled rules', async () => {
      const rules: AMLRule[] = [
        {
          id: 'rule1',
          name: 'Amount Threshold',
          description: 'Detects large transactions',
          type: 'amount_threshold',
          version: { major: 1, minor: 0, patch: 0 },
          severity: 'critical',
          enabled: false,
          config: { threshold: 10000 },
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '15000',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [],
      };

      const results = await evaluator.evaluate(context, rules);
      expect(results).toHaveLength(0);
    });

    it('should handle unknown rule types gracefully', async () => {
      const rules: AMLRule[] = [
        {
          id: 'rule1',
          name: 'Unknown Rule',
          description: 'Unknown rule type',
          type: 'unknown' as any,
          version: { major: 1, minor: 0, patch: 0 },
          severity: 'low',
          enabled: true,
          config: {},
          created_at: new Date(),
          updated_at: new Date(),
        },
      ];

      const context: TransactionContext = {
        investment_id: 'inv1',
        investor_id: 'inv1',
        offering_id: 'off1',
        amount: '100',
        asset: 'USD',
        timestamp: new Date(),
        previous_transactions: [],
      };

      const results = await evaluator.evaluate(context, rules);
      expect(results).toHaveLength(1);
      expect(results[0].triggered).toBe(false);
      expect(results[0].details.error).toBe('Unknown rule type');
    });
  });
});
