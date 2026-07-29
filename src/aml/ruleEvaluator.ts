/**
 * AML Rule Evaluator Engine
 * Evaluates transactions against AML rules to detect suspicious patterns.
 */

import { AMLRule, TransactionContext, RuleEvaluationResult, VelocityRuleConfig, VelocityRepository, InvestmentVelocityRecord } from './types';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { jaroWinkler, normalizeName } from '../lib/jaroWinkler';
import { MetricsCollector } from '../lib/metrics';

interface StructuringRuleConfig {
  window_hours: number;
  amount_threshold: number;
  min_transactions: number;
  reporting_threshold: number;
}

interface GeoMismatchRuleConfig {
  high_risk_countries: string[];
  max_country_changes: number;
}

interface AmountThresholdConfig {
  threshold: number;
}

interface SanctionsRuleConfig {
  sanctions_list: string[];
  jaro_winkler_threshold?: number;
  fuzzy_enabled?: boolean;
}

// ─── InMemoryVelocityRepository ───────────────────────────────────────────────

/**
 * @notice In-process implementation of VelocityRepository for testing and
 *         single-node deployments.
 * @dev    Production code should swap this for a PgVelocityRepository that
 *         issues an UPSERT against the aml_investment_velocity table.
 *
 *         The upsert key is (investor_id, window_start, window_end, rule_id).
 *         Late-arriving events call upsert again with updated tx_count /
 *         total_amount / investment_ids, shifting the window without creating
 *         a duplicate row.
 */
export class InMemoryVelocityRepository implements VelocityRepository {
  /** Key: `${investor_id}|${window_start.getTime()}|${window_end.getTime()}|${rule_id}` */
  private store = new Map<string, InvestmentVelocityRecord>();
  private idSeq = 0;

  private key(r: Pick<InvestmentVelocityRecord, 'investor_id' | 'window_start' | 'window_end' | 'rule_id'>): string {
    return `${r.investor_id}|${r.window_start.getTime()}|${r.window_end.getTime()}|${r.rule_id}`;
  }

  async upsert(
    record: Omit<InvestmentVelocityRecord, 'id' | 'created_at' | 'updated_at'>
  ): Promise<InvestmentVelocityRecord> {
    const k = this.key(record);
    const now = new Date();
    const existing = this.store.get(k);
    if (existing) {
      const updated: InvestmentVelocityRecord = {
        ...existing,
        ...record,
        id: existing.id,
        created_at: existing.created_at,
        updated_at: now,
      };
      this.store.set(k, updated);
      return updated;
    }
    const row: InvestmentVelocityRecord = {
      ...record,
      id: `vel_${++this.idSeq}`,
      created_at: now,
      updated_at: now,
    };
    this.store.set(k, row);
    return row;
  }

  async findByInvestor(investorId: string, from: Date, to: Date): Promise<InvestmentVelocityRecord[]> {
    return Array.from(this.store.values())
      .filter(r =>
        r.investor_id === investorId &&
        r.window_end >= from &&
        r.window_end <= to
      )
      .sort((a, b) => b.window_end.getTime() - a.window_end.getTime());
  }

  /** Test helper — returns all stored records. */
  all(): InvestmentVelocityRecord[] {
    return Array.from(this.store.values());
  }

  clear(): void {
    this.store.clear();
  }
}

// ─── RuleEvaluator ────────────────────────────────────────────────────────────

export class RuleEvaluator {
  private readonly velocityRepo: VelocityRepository;
  private readonly metrics?: MetricsCollector;

  constructor(
    private investmentRepo: InvestmentRepository,
    options?: {
      velocityRepo?: VelocityRepository;
      metrics?: MetricsCollector;
    }
  ) {
    this.velocityRepo = options?.velocityRepo ?? new InMemoryVelocityRepository();
    this.metrics = options?.metrics;
  }

  async evaluate(context: TransactionContext, rules: AMLRule[]): Promise<RuleEvaluationResult[]> {
    const results: RuleEvaluationResult[] = [];
    
    // Use provided previous_transactions or fetch from repository
    if (!context.previous_transactions) {
      context.previous_transactions = await this.getPreviousTransactions(context.investor_id, context.offering_id, 30);
    }

    for (const rule of rules) {
      if (!rule.enabled) continue;
      const result = await this.evaluateRule(context, rule);
      results.push(result);
    }
    return results;
  }

  private async evaluateRule(context: TransactionContext, rule: AMLRule): Promise<RuleEvaluationResult> {
    let triggered = false;
    let details: Record<string, unknown> = {};

    switch (rule.type) {
      case 'velocity':
        ({ triggered, details } = await this.evaluateVelocityRule(context, rule));
        break;
      case 'structuring':
        ({ triggered, details } = this.evaluateStructuringRule(context, rule));
        break;
      case 'geo_mismatch':
        ({ triggered, details } = this.evaluateGeoMismatchRule(context, rule));
        break;
      case 'amount_threshold':
        ({ triggered, details } = this.evaluateAmountThresholdRule(context, rule));
        break;
      case 'sanctions_screening':
        ({ triggered, details } = this.evaluateSanctionsRule(context, rule));
        break;
      default:
        return { rule_id: rule.id, rule_version: rule.version, triggered: false, severity: rule.severity, details: { error: 'Unknown rule type' }, timestamp: new Date() };
    }

    return { rule_id: rule.id, rule_version: rule.version, triggered, severity: rule.severity, details, timestamp: new Date() };
  }

  /**
   * @notice Sliding-window investment velocity rule (smurfing detection).
   * @dev    Aggregates all non-failed investments for the investor inside the
   *         configured window and compares against max_amount and max_count.
   *
   *         The aggregate is persisted via velocityRepo.upsert() so late-arriving
   *         events update the row in-place rather than creating duplicates.
   *         The `linked_investment_ids` field in the result details lets the
   *         AML analyst see exactly which investments tripped the rule.
   *
   *         Metric emitted on trigger: `aml_velocity_triggered_total`
   *         (labels: investor_id, rule_id, reason=[amount|count|both])
   */
  private async evaluateVelocityRule(
    context: TransactionContext,
    rule: AMLRule
  ): Promise<{ triggered: boolean; details: Record<string, unknown> }> {
    const config = rule.config as unknown as VelocityRuleConfig;
    const transactions = context.previous_transactions ?? [];
    const currentAmount = parseFloat(context.amount);

    // Build the window: [windowStart, context.timestamp]
    const windowEnd = new Date(context.timestamp);
    const windowStart = new Date(windowEnd.getTime() - config.window_minutes * 60_000);

    // Collect non-failed investments inside the window (excluding the current one).
    const recentTx = transactions.filter(
      tx => tx.timestamp >= windowStart &&
            tx.timestamp <= windowEnd &&
            tx.status !== 'failed'
    );

    const windowTotal = recentTx.reduce((sum, tx) => sum + parseFloat(tx.amount), 0);
    const totalAmount = windowTotal + currentAmount;
    const txCount = recentTx.length + 1; // +1 for the current investment

    const amountExceeded = totalAmount > config.max_amount;
    const countExceeded = txCount > config.max_count;
    const triggered = amountExceeded || countExceeded;

    // Persist the velocity aggregate (upsert handles late-arriving events).
    const linkedIds = [
      ...recentTx.map(tx => tx.investment_id),
      context.investment_id,
    ];

    await this.velocityRepo.upsert({
      investor_id: context.investor_id,
      window_start: windowStart,
      window_end: windowEnd,
      window_minutes: config.window_minutes,
      tx_count: txCount,
      total_amount: totalAmount,
      investment_ids: linkedIds,
      amount_exceeded: amountExceeded,
      count_exceeded: countExceeded,
      threshold_amount: config.max_amount,
      threshold_count: config.max_count,
      rule_id: rule.id,
      rule_version: rule.version,
    });

    if (triggered) {
      const reason = amountExceeded && countExceeded ? 'both' : amountExceeded ? 'amount' : 'count';
      this.metrics?.incrementCounter('aml_velocity_triggered_total', {
        investor_id: context.investor_id,
        rule_id: rule.id,
        reason,
      });
    }

    return {
      triggered,
      details: {
        window_minutes: config.window_minutes,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        transaction_count: txCount,
        total_amount: totalAmount,
        max_amount: config.max_amount,
        max_count: config.max_count,
        amount_exceeded: amountExceeded,
        count_exceeded: countExceeded,
        /** Linked investment IDs allow the analyst to trace which events tripped the rule. */
        linked_investment_ids: linkedIds,
      },
    };
  }

  private evaluateStructuringRule(context: TransactionContext, rule: AMLRule): { triggered: boolean; details: Record<string, unknown> } {
    const config = rule.config as unknown as StructuringRuleConfig;
    const transactions = context.previous_transactions || [];
    const currentAmount = parseFloat(context.amount);
    const windowStart = new Date(context.timestamp);
    windowStart.setHours(windowStart.getHours() - config.window_hours);
    const recentTransactions = transactions.filter(tx => tx.timestamp >= windowStart && tx.status !== 'failed');
    const similarTransactions = recentTransactions.filter(tx => Math.abs(parseFloat(tx.amount) - currentAmount) <= config.amount_threshold);
    const totalAmount = similarTransactions.reduce((sum, tx) => sum + parseFloat(tx.amount), currentAmount);
    const triggered = similarTransactions.length >= config.min_transactions && totalAmount > config.reporting_threshold;
    return { triggered, details: { window_hours: config.window_hours, similar_transaction_count: similarTransactions.length, total_amount: totalAmount, reporting_threshold: config.reporting_threshold, amount_threshold: config.amount_threshold } };
  }

  private evaluateGeoMismatchRule(context: TransactionContext, rule: AMLRule): { triggered: boolean; details: Record<string, unknown> } {
    const config = rule.config as unknown as GeoMismatchRuleConfig;
    const transactions = context.previous_transactions || [];
    if (!context.investor_country || !context.investor_ip_country) return { triggered: false, details: { reason: 'Insufficient geo data' } };
    const isMismatch = context.investor_country !== context.investor_ip_country;
    const isHighRiskCountry = config.high_risk_countries.includes(context.investor_ip_country);
    const countryChanges = transactions.filter(tx => tx.investor_ip_country && tx.investor_ip_country !== context.investor_ip_country).length;
    const triggered = isMismatch || isHighRiskCountry || countryChanges >= config.max_country_changes;
    return { triggered, details: { investor_country: context.investor_country, ip_country: context.investor_ip_country, is_mismatch: isMismatch, is_high_risk: isHighRiskCountry, country_changes: countryChanges, max_country_changes: config.max_country_changes } };
  }

  private evaluateAmountThresholdRule(context: TransactionContext, rule: AMLRule): { triggered: boolean; details: Record<string, unknown> } {
    const config = rule.config as unknown as AmountThresholdConfig;
    const currentAmount = parseFloat(context.amount);
    const triggered = currentAmount > config.threshold;
    return { triggered, details: { amount: currentAmount, threshold: config.threshold } };
  }

  private evaluateSanctionsRule(context: TransactionContext, rule: AMLRule): { triggered: boolean; details: Record<string, unknown> } {
    const config = rule.config as unknown as SanctionsRuleConfig;
    const sanctionsList = config.sanctions_list || [];
    const nameToScreen = context.investor_name || context.investor_id;

    if (!nameToScreen || sanctionsList.length === 0) {
      return { triggered: false, details: { reason: 'Missing investor name or sanctions list' } };
    }

    // Per-tenant threshold > rule config threshold > default 0.85
    const tenantThreshold = context.tenant_settings?.sanctions_threshold;
    const threshold = typeof tenantThreshold === 'number'
      ? tenantThreshold
      : (typeof config.jaro_winkler_threshold === 'number' ? config.jaro_winkler_threshold : 0.85);

    const normName = normalizeName(nameToScreen);
    let bestMatch: { candidate: string; score: number; matchType: 'exact' | 'fuzzy' } | null = null;

    for (const candidate of sanctionsList) {
      const normCandidate = normalizeName(candidate);
      if (normName === normCandidate) {
        bestMatch = { candidate, score: 1.0, matchType: 'exact' };
        break;
      }

      if (config.fuzzy_enabled !== false) {
        const score = jaroWinkler(nameToScreen, candidate, { transliterate: true });
        if (score >= threshold) {
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { candidate, score, matchType: 'fuzzy' };
          }
        }
      }
    }

    if (!bestMatch) {
      return {
        triggered: false,
        details: {
          screened_name: nameToScreen,
          threshold,
          matched: false,
        },
      };
    }

    // Every fuzzy hit is treated as a pending review, never an auto-deny.
    const isFuzzy = bestMatch.matchType === 'fuzzy';
    const action = isFuzzy ? 'pending_review' : 'auto_deny';
    const autoDeny = !isFuzzy;

    return {
      triggered: true,
      details: {
        screened_name: nameToScreen,
        matched_candidate: bestMatch.candidate,
        match_type: bestMatch.matchType,
        similarity_score: bestMatch.score,
        threshold,
        action,
        auto_deny: autoDeny,
        review_status: isFuzzy ? 'pending_review' : 'confirmed_deny',
      },
    };
  }

  private async getPreviousTransactions(investorId: string, offeringId: string, daysBack: number): Promise<TransactionContext[]> {
    const investments = await this.investmentRepo.listByInvestor({ investor_id: investorId, offering_id: offeringId, limit: 100 });
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);
    return investments
      .filter(inv => inv.created_at >= cutoffDate)
      .map(inv => ({
        investment_id: inv.id,
        investor_id: inv.investor_id,
        offering_id: inv.offering_id,
        amount: inv.amount,
        asset: inv.asset,
        timestamp: inv.created_at,
        status: inv.status,
      }));
  }
}
