/**
 * AML Rule Evaluator Engine
 * Evaluates transactions against AML rules to detect suspicious patterns.
 */

import { AMLRule, TransactionContext, RuleEvaluationResult } from './types';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { jaroWinkler, normalizeName } from '../lib/jaroWinkler';

interface VelocityRuleConfig {
  window_minutes: number;
  max_amount: number;
  max_count: number;
}

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

export class RuleEvaluator {
  constructor(private investmentRepo: InvestmentRepository) {}

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
        ({ triggered, details } = this.evaluateVelocityRule(context, rule));
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

  private evaluateVelocityRule(context: TransactionContext, rule: AMLRule): { triggered: boolean; details: Record<string, unknown> } {
    const config = rule.config as unknown as VelocityRuleConfig;
    const transactions = context.previous_transactions || [];
    const currentAmount = parseFloat(context.amount);
    const windowStart = new Date(context.timestamp);
    windowStart.setMinutes(windowStart.getMinutes() - config.window_minutes);
    const recentTransactions = transactions.filter(tx => tx.timestamp >= windowStart && tx.status !== 'failed');
    const totalAmount = recentTransactions.reduce((sum, tx) => sum + parseFloat(tx.amount), 0);
    const amountExceeded = totalAmount + currentAmount > config.max_amount;
    const countExceeded = recentTransactions.length + 1 > config.max_count;
    return { triggered: amountExceeded || countExceeded, details: { window_minutes: config.window_minutes, transaction_count: recentTransactions.length + 1, total_amount: totalAmount + currentAmount, max_amount: config.max_amount, max_count: config.max_count, amount_exceeded: amountExceeded, count_exceeded: countExceeded } };
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
