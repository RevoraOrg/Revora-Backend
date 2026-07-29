/**
 * Rule Evaluator Tests
 * 
 * Comprehensive test coverage for AML rule evaluation engine.
 * Tests velocity, structuring, geo-mismatch, and amount threshold rules.
 */

import { RuleEvaluator, InMemoryVelocityRepository } from './ruleEvaluator';
import { AMLRule, TransactionContext, InvestmentVelocityRecord } from './types';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { MetricsCollector } from '../lib/metrics';

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

// ─── Velocity rule — sliding window aggregation (smurfing detection) ──────────

describe('Velocity Rule — Sliding Window Aggregation', () => {
  let mockRepo: MockInvestmentRepository;
  let velocityRepo: InMemoryVelocityRepository;
  let evaluator: RuleEvaluator;

  const velocityRule = (overrides: Partial<AMLRule['config']> = {}): AMLRule => ({
    id: 'vel-rule-1',
    name: 'Investment Velocity',
    description: 'Detects smurfing via sliding-window aggregation',
    type: 'velocity',
    version: { major: 1, minor: 0, patch: 0 },
    severity: 'high',
    enabled: true,
    config: {
      window_minutes: 60,
      max_amount: 1000,
      max_count: 5,
      ...overrides,
    },
    created_at: new Date(),
    updated_at: new Date(),
  });

  const makeTx = (
    id: string,
    amount: string,
    minutesAgo: number,
    status: 'completed' | 'failed' | 'pending' = 'completed'
  ): TransactionContext => ({
    investment_id: id,
    investor_id: 'inv-1',
    offering_id: 'off-1',
    amount,
    asset: 'USD',
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
    status,
  });

  beforeEach(() => {
    mockRepo = new MockInvestmentRepository();
    velocityRepo = new InMemoryVelocityRepository();
    evaluator = new RuleEvaluator(mockRepo as any, { velocityRepo });
  });

  // ── Trigger conditions ────────────────────────────────────────────────────

  it('triggers when transaction count exceeds max_count', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '100', 0),
      previous_transactions: [
        makeTx('t1', '100', 50),
        makeTx('t2', '100', 40),
        makeTx('t3', '100', 30),
        makeTx('t4', '100', 20),
        makeTx('t5', '100', 10),
      ],
    };
    const [result] = await evaluator.evaluate(context, [velocityRule()]);
    expect(result.triggered).toBe(true);
    expect(result.details.count_exceeded).toBe(true);
  });

  it('triggers when total amount exceeds max_amount', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '600', 0),
      previous_transactions: [makeTx('t1', '500', 30)],
    };
    const [result] = await evaluator.evaluate(context, [velocityRule()]);
    expect(result.triggered).toBe(true);
    expect(result.details.amount_exceeded).toBe(true);
  });

  it('does not trigger when both count and amount are within limits', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '100', 0),
      previous_transactions: [makeTx('t1', '100', 30)],
    };
    const [result] = await evaluator.evaluate(context, [velocityRule()]);
    expect(result.triggered).toBe(false);
  });

  it('ignores failed transactions when aggregating', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '100', 0),
      previous_transactions: [
        makeTx('t1', '400', 20, 'failed'),
        makeTx('t2', '400', 10, 'failed'),
      ],
    };
    const [result] = await evaluator.evaluate(context, [velocityRule()]);
    expect(result.triggered).toBe(false);
  });

  it('ignores transactions outside the window', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '100', 0),
      previous_transactions: [
        makeTx('t1', '900', 90),  // 90 min ago — outside 60-min window
      ],
    };
    const [result] = await evaluator.evaluate(context, [velocityRule()]);
    expect(result.triggered).toBe(false);
  });

  it('only counts transactions strictly within [window_start, window_end]', async () => {
    // Exactly at window boundary (60 min ago) should be included
    const context: TransactionContext = {
      ...makeTx('cur', '100', 0),
      previous_transactions: [makeTx('t1', '950', 60)],
    };
    const [result] = await evaluator.evaluate(context, [velocityRule()]);
    // 950 + 100 = 1050 > 1000 → should trigger
    expect(result.triggered).toBe(true);
    expect(result.details.amount_exceeded).toBe(true);
  });

  // ── Details payload ───────────────────────────────────────────────────────

  it('includes window_start and window_end in details', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '100', 0),
      previous_transactions: [],
    };
    const [result] = await evaluator.evaluate(context, [velocityRule()]);
    expect(result.details.window_start).toBeDefined();
    expect(result.details.window_end).toBeDefined();
    expect(typeof result.details.window_start).toBe('string');
  });

  it('includes linked_investment_ids in details', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '200', 0),
      previous_transactions: [makeTx('t1', '200', 30)],
    };
    const [result] = await evaluator.evaluate(context, [velocityRule()]);
    const ids = result.details.linked_investment_ids as string[];
    expect(ids).toContain('t1');
    expect(ids).toContain('cur');
  });

  it('linked_investment_ids contains only non-failed in-window investments', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '100', 0),
      previous_transactions: [
        makeTx('in-window', '100', 30, 'completed'),
        makeTx('failed-one', '100', 20, 'failed'),
        makeTx('too-old', '100', 90, 'completed'),
      ],
    };
    const [result] = await evaluator.evaluate(context, [velocityRule()]);
    const ids = result.details.linked_investment_ids as string[];
    expect(ids).toContain('in-window');
    expect(ids).toContain('cur');
    expect(ids).not.toContain('failed-one');
    expect(ids).not.toContain('too-old');
  });

  // ── InMemoryVelocityRepository persistence ────────────────────────────────

  it('persists a velocity aggregate row after evaluation', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '200', 0),
      previous_transactions: [makeTx('t1', '300', 30)],
    };
    await evaluator.evaluate(context, [velocityRule()]);

    const rows = velocityRepo.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].investor_id).toBe('inv-1');
    expect(rows[0].tx_count).toBe(2);
    expect(rows[0].total_amount).toBe(500);
    expect(rows[0].rule_id).toBe('vel-rule-1');
  });

  it('stores threshold_amount and threshold_count in persisted row', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '100', 0),
      previous_transactions: [],
    };
    await evaluator.evaluate(context, [velocityRule()]);
    const [row] = velocityRepo.all();
    expect(row.threshold_amount).toBe(1000);
    expect(row.threshold_count).toBe(5);
  });

  it('upserts on late-arriving event — does not duplicate row', async () => {
    const now = new Date();
    const windowEnd = now;
    const windowStart = new Date(now.getTime() - 60 * 60_000);

    // First evaluation
    const ctx1: TransactionContext = {
      ...makeTx('cur', '200', 0),
      timestamp: windowEnd,
      previous_transactions: [makeTx('t1', '300', 30)],
    };
    await evaluator.evaluate(ctx1, [velocityRule()]);

    // Late-arriving event with same window bounds — should upsert, not insert
    const ctx2: TransactionContext = {
      ...makeTx('cur', '200', 0),
      timestamp: windowEnd,
      previous_transactions: [makeTx('t1', '300', 30), makeTx('t-late', '50', 25)],
    };
    await evaluator.evaluate(ctx2, [velocityRule()]);

    // Only one row per (investor_id, window_start, window_end, rule_id)
    const rows = velocityRepo.all();
    expect(rows).toHaveLength(1);
    // The row should reflect the updated count
    expect(rows[0].tx_count).toBe(3); // t1 + t-late + cur
  });

  it('findByInvestor returns rows in descending window_end order', async () => {
    const t1 = new Date('2026-01-01T10:00:00Z');
    const t2 = new Date('2026-01-01T12:00:00Z');

    await velocityRepo.upsert({
      investor_id: 'inv-1', window_start: new Date('2026-01-01T09:00:00Z'), window_end: t1,
      window_minutes: 60, tx_count: 1, total_amount: 100, investment_ids: ['a'],
      amount_exceeded: false, count_exceeded: false,
      threshold_amount: 1000, threshold_count: 5,
      rule_id: 'r1', rule_version: { major: 1, minor: 0, patch: 0 },
    });
    await velocityRepo.upsert({
      investor_id: 'inv-1', window_start: new Date('2026-01-01T11:00:00Z'), window_end: t2,
      window_minutes: 60, tx_count: 2, total_amount: 200, investment_ids: ['b', 'c'],
      amount_exceeded: false, count_exceeded: false,
      threshold_amount: 1000, threshold_count: 5,
      rule_id: 'r1', rule_version: { major: 1, minor: 0, patch: 0 },
    });

    const rows = await velocityRepo.findByInvestor('inv-1', new Date('2026-01-01T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
    expect(rows[0].window_end.getTime()).toBeGreaterThan(rows[1].window_end.getTime());
  });

  it('findByInvestor filters by time range', async () => {
    await velocityRepo.upsert({
      investor_id: 'inv-1', window_start: new Date('2026-01-01T09:00:00Z'), window_end: new Date('2026-01-01T10:00:00Z'),
      window_minutes: 60, tx_count: 1, total_amount: 100, investment_ids: ['a'],
      amount_exceeded: false, count_exceeded: false,
      threshold_amount: 1000, threshold_count: 5,
      rule_id: 'r1', rule_version: { major: 1, minor: 0, patch: 0 },
    });
    await velocityRepo.upsert({
      investor_id: 'inv-1', window_start: new Date('2025-12-31T09:00:00Z'), window_end: new Date('2025-12-31T10:00:00Z'),
      window_minutes: 60, tx_count: 1, total_amount: 50, investment_ids: ['old'],
      amount_exceeded: false, count_exceeded: false,
      threshold_amount: 1000, threshold_count: 5,
      rule_id: 'r1', rule_version: { major: 1, minor: 0, patch: 0 },
    });

    const rows = await velocityRepo.findByInvestor(
      'inv-1',
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-01-02T00:00:00Z')
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].investment_ids).toContain('a');
  });

  // ── Metrics emission ──────────────────────────────────────────────────────

  it('emits aml_velocity_triggered_total counter on trigger', async () => {
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const eval2 = new RuleEvaluator(mockRepo as any, { velocityRepo, metrics });
    const context: TransactionContext = {
      ...makeTx('cur', '600', 0),
      previous_transactions: [makeTx('t1', '500', 30)],
    };
    await eval2.evaluate(context, [velocityRule()]);
    const prom = metrics.exportPrometheus();
    expect(prom).toContain('aml_velocity_triggered_total');
  });

  it('does not emit counter when not triggered', async () => {
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const eval2 = new RuleEvaluator(mockRepo as any, { velocityRepo, metrics });
    const context: TransactionContext = {
      ...makeTx('cur', '50', 0),
      previous_transactions: [],
    };
    await eval2.evaluate(context, [velocityRule()]);
    const prom = metrics.exportPrometheus();
    expect(prom).not.toContain('aml_velocity_triggered_total');
  });

  it('labels metric with reason=amount when only amount exceeded', async () => {
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const eval2 = new RuleEvaluator(mockRepo as any, { velocityRepo, metrics });
    const context: TransactionContext = {
      ...makeTx('cur', '900', 0),
      previous_transactions: [makeTx('t1', '200', 30)], // total 1100 > 1000; count=2 ≤ 5
    };
    await eval2.evaluate(context, [velocityRule()]);
    const snap = await metrics.getSnapshot();
    const counter = snap.custom.find((p: any) =>
      p.name === 'aml_velocity_triggered_total' && p.labels?.reason === 'amount'
    );
    expect(counter).toBeDefined();
  });

  it('labels metric with reason=count when only count exceeded', async () => {
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const eval2 = new RuleEvaluator(mockRepo as any, { velocityRepo, metrics });
    // 6 transactions of $10 each — count 6 > 5, total $60 ≤ $1000
    const context: TransactionContext = {
      ...makeTx('cur', '10', 0),
      previous_transactions: [
        makeTx('t1', '10', 50),
        makeTx('t2', '10', 40),
        makeTx('t3', '10', 30),
        makeTx('t4', '10', 20),
        makeTx('t5', '10', 10),
      ],
    };
    await eval2.evaluate(context, [velocityRule()]);
    const snap = await metrics.getSnapshot();
    const counter = snap.custom.find((p: any) =>
      p.name === 'aml_velocity_triggered_total' && p.labels?.reason === 'count'
    );
    expect(counter).toBeDefined();
  });

  it('labels metric with reason=both when both exceeded', async () => {
    const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    const eval2 = new RuleEvaluator(mockRepo as any, { velocityRepo, metrics });
    const context: TransactionContext = {
      ...makeTx('cur', '300', 0),
      previous_transactions: [
        makeTx('t1', '200', 50),
        makeTx('t2', '200', 40),
        makeTx('t3', '200', 30),
        makeTx('t4', '200', 20),
        makeTx('t5', '200', 10),
      ],
    };
    await eval2.evaluate(context, [velocityRule()]);
    const snap = await metrics.getSnapshot();
    const counter = snap.custom.find((p: any) =>
      p.name === 'aml_velocity_triggered_total' && p.labels?.reason === 'both'
    );
    expect(counter).toBeDefined();
  });

  // ── Case opening in AML service ───────────────────────────────────────────

  it('details include window_minutes from rule config', async () => {
    const rule = velocityRule({ window_minutes: 30 });
    const context: TransactionContext = {
      ...makeTx('cur', '100', 0),
      previous_transactions: [],
    };
    const [result] = await evaluator.evaluate(context, [rule]);
    expect(result.details.window_minutes).toBe(30);
  });

  it('details include max_amount and max_count thresholds', async () => {
    const context: TransactionContext = {
      ...makeTx('cur', '100', 0),
      previous_transactions: [],
    };
    const [result] = await evaluator.evaluate(context, [velocityRule()]);
    expect(result.details.max_amount).toBe(1000);
    expect(result.details.max_count).toBe(5);
  });

  // ── InMemoryVelocityRepository unit tests ─────────────────────────────────

  describe('InMemoryVelocityRepository', () => {
    it('stores and retrieves a record', async () => {
      const repo = new InMemoryVelocityRepository();
      const now = new Date();
      const row = await repo.upsert({
        investor_id: 'i1',
        window_start: new Date(now.getTime() - 60_000),
        window_end: now,
        window_minutes: 1,
        tx_count: 1,
        total_amount: 100,
        investment_ids: ['inv-1'],
        amount_exceeded: false,
        count_exceeded: false,
        threshold_amount: 500,
        threshold_count: 10,
        rule_id: 'r1',
        rule_version: { major: 1, minor: 0, patch: 0 },
      });
      expect(row.id).toBeTruthy();
      expect(repo.all()).toHaveLength(1);
    });

    it('upsert updates existing row without creating a duplicate', async () => {
      const repo = new InMemoryVelocityRepository();
      const now = new Date();
      const base = {
        investor_id: 'i1',
        window_start: new Date(now.getTime() - 60_000),
        window_end: now,
        window_minutes: 1,
        investment_ids: ['inv-1'],
        amount_exceeded: false,
        count_exceeded: false,
        threshold_amount: 500,
        threshold_count: 10,
        rule_id: 'r1',
        rule_version: { major: 1, minor: 0, patch: 0 },
      };
      await repo.upsert({ ...base, tx_count: 1, total_amount: 100 });
      await repo.upsert({ ...base, tx_count: 2, total_amount: 200 });

      const rows = repo.all();
      expect(rows).toHaveLength(1);
      expect(rows[0].tx_count).toBe(2);
      expect(rows[0].total_amount).toBe(200);
    });

    it('clear empties the store', async () => {
      const repo = new InMemoryVelocityRepository();
      const now = new Date();
      await repo.upsert({
        investor_id: 'i1', window_start: new Date(now.getTime() - 60_000), window_end: now,
        window_minutes: 1, tx_count: 1, total_amount: 10, investment_ids: [],
        amount_exceeded: false, count_exceeded: false, threshold_amount: null, threshold_count: null,
        rule_id: 'r', rule_version: { major: 1, minor: 0, patch: 0 },
      });
      repo.clear();
      expect(repo.all()).toHaveLength(0);
    });

    it('isolates records by investor_id', async () => {
      const repo = new InMemoryVelocityRepository();
      const now = new Date();
      const base = { window_start: new Date(now.getTime() - 60_000), window_end: now, window_minutes: 1, tx_count: 1, total_amount: 50, investment_ids: [], amount_exceeded: false, count_exceeded: false, threshold_amount: null, threshold_count: null, rule_id: 'r', rule_version: { major: 1, minor: 0, patch: 0 } };
      await repo.upsert({ ...base, investor_id: 'i1' });
      await repo.upsert({ ...base, investor_id: 'i2' });

      const rows = await repo.findByInvestor('i1', new Date(0), new Date(Date.now() + 1000));
      expect(rows).toHaveLength(1);
      expect(rows[0].investor_id).toBe('i1');
    });
  });
});
