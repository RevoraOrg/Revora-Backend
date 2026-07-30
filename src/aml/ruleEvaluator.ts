/**
 * AML Rule Evaluator Engine
 * Evaluates transactions against AML rules to detect suspicious patterns.
 */

import {
  AMLRule,
  TransactionContext,
  RuleEvaluationResult,
  VelocityRuleConfig,
  VelocityRepository,
  InvestmentVelocityRecord,
  OfacCounterparty,
  OfacScreeningMatch,
  OfacVesselAircraftRuleConfig,
  OfacEntityType,
} from './types';
import { InvestmentRepository } from '../db/repositories/investmentRepository';
import { jaroWinkler, normalizeName } from '../lib/jaroWinkler';
import { MetricsCollector } from '../lib/metrics';

interface StructuringRuleConfig {
  window_hours: number;
  amount_threshold: number;
  min_transactions: number;
  reporting_threshold: number;
  /** Histogram bin size for amount clustering (default 500). */
  cluster_bin_size?: number;
  /** Minimum cluster score (0-1) required to trigger (default 0.5). */
  score_threshold?: number;
  /** Per-jurisdiction overrides (ISO 3166-1 alpha-2 → reporting_threshold, currency). */
  jurisdictions?: Record<string, { reporting_threshold: number; currency: string }>;
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
      case 'ofac_counterparty_screening':
        ({ triggered, details } = this.evaluateOfacCounterpartyRule(context, rule));
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

  /**
   * @notice Amount-clustering structuring detection rule.
   * @dev    Builds a histogram of deposit amounts using a configurable bin size,
   *         computes a per-investor cluster score, and triggers when deposits
   *         are clustered just under regulatory reporting thresholds (smurfing).
   *
   *         Algorithm:
   *          1. Filter non-failed transactions in the sliding window.
   *          2. Resolve jurisdiction-aware reporting threshold.
   *          3. Bucket amounts into histogram bins of size `cluster_bin_size`.
   *          4. Compute a cluster score (0–1) from bin concentration and
   *             proximity to the reporting threshold.
   *          5. Trigger if `cluster_score >= score_threshold` AND at least
   *             `min_transactions` similar transactions exist.
   *
   *         Metrics: `aml.structuring.score` gauge (labels: investor_id, rule_id).
   *         Jurisdiction-aware: `config.jurisdictions[country]` overrides
   *         `config.reporting_threshold`.
   */
  private evaluateStructuringRule(context: TransactionContext, rule: AMLRule): { triggered: boolean; details: Record<string, unknown> } {
    const config = rule.config as unknown as StructuringRuleConfig;
    const transactions = context.previous_transactions ?? [];
    const currentAmount = parseFloat(context.amount);

    // Resolve jurisdiction-aware reporting threshold
    const reportingThreshold = this.resolveStructuingThreshold(config, context);

    // Build the sliding window
    const windowEnd = new Date(context.timestamp);
    const windowStart = new Date(windowEnd.getTime() - (config.window_hours ?? 24) * 60 * 60 * 1000);

    // Collect non-failed transactions inside the window
    const recentTransactions = transactions.filter(
      tx => tx.timestamp >= windowStart && tx.timestamp <= windowEnd && tx.status !== 'failed'
    );

    // Include the current transaction
    const allAmounts = [
      ...recentTransactions.map(tx => parseFloat(tx.amount)),
      currentAmount,
    ];

    // Compute amount-clustering histogram and score
    const binSize = config.cluster_bin_size ?? 500;
    const { clusterScore, histogram, similarTransactionCount, totalClusteredAmount } =
      computeStructuringClusterScore(allAmounts, reportingThreshold, binSize);

    const scoreThreshold = config.score_threshold ?? 0.5;
    const minTx = config.min_transactions ?? 3;
    const triggered = clusterScore >= scoreThreshold && similarTransactionCount >= minTx;

    // Emit metrics gauge
    if (this.metrics) {
      this.metrics.setGauge('aml.structuring.score', clusterScore, {
        investor_id: context.investor_id,
        rule_id: rule.id,
      });
    }

    return {
      triggered,
      details: {
        window_hours: config.window_hours ?? 24,
        window_start: windowStart.toISOString(),
        window_end: windowEnd.toISOString(),
        reporting_threshold: reportingThreshold,
        cluster_score: clusterScore,
        score_threshold: scoreThreshold,
        similar_transaction_count: similarTransactionCount,
        min_transactions: minTx,
        total_clustered_amount: totalClusteredAmount,
        bin_size: binSize,
        histogram_bins: histogram.length,
        /** Top 3 histogram bins for analyst review. */
        top_bins: histogram.slice(0, 3).map(bin => ({
          range: `${bin.min}-${bin.max}`,
          count: bin.count,
          total: bin.total,
        })),
      },
    };
  }

  /**
   * @notice Resolve the jurisdiction-aware reporting threshold.
   * @dev    Checks `config.jurisdictions` for a per-country override; falls back
   *         to `config.reporting_threshold`. If the investor's country is in the
   *         jurisdiction map, its `reporting_threshold` is used instead.
   *
   *         Example: investor from US → $10,000, investor from EU → €10,000.
   */
  private resolveStructuingThreshold(config: StructuringRuleConfig, context: TransactionContext): number {
    const country = context.investor_country?.toUpperCase();
    if (country && config.jurisdictions?.[country]) {
      return config.jurisdictions[country].reporting_threshold;
    }
    return config.reporting_threshold;
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

  // ─── OFAC Counterparty Screening ────────────────────────────────────────────

  /**
   * IMO vessel identification number pattern: the letters "IMO" followed by
   * exactly 7 digits, as defined by IMO resolution A.600(15).
   * @see https://www.imo.org/en/OurWork/MSAS/Pages/IMO-identification-number-scheme.aspx
   */
  private static readonly IMO_PATTERN = /^IMO\d{7}$/;

  /**
   * @notice Screens each counterparty in `context.counterparties` against the
   *         configured OFAC SDN list using exact + optional Jaro-Winkler fuzzy
   *         matching, with per-entity-type filtering and validated IMO surfacing.
   *
   * @dev    Security assumptions:
   *         1. **Isolation** — This method is completely separate from
   *            `evaluateSanctionsRule` (person queue). A counterparty named the
   *            same as an SDN person does NOT trigger the person alert queue.
   *         2. **IMO validation** — `imo_number` values that do not match
   *            `/^IMO\d{7}$/` are dropped from alert details before emission.
   *            The counterparty is still screened by name.
   *         3. **Type-filtered matching** — When `config.entity_types` is set,
   *            counterparties whose `type` is not in the filter are skipped
   *            entirely, preventing cross-type false-positive noise.
   *         4. **No early return on first hit** — All counterparties are
   *            screened so analysts see the full match set per evaluation.
   *
   * @param context - Transaction context carrying `counterparties[]`.
   * @param rule    - AML rule with `OfacVesselAircraftRuleConfig` config.
   * @returns `triggered=true` with `details.matches[]` if any counterparty hit.
   */
  private evaluateOfacCounterpartyRule(
    context: TransactionContext,
    rule: AMLRule
  ): { triggered: boolean; details: Record<string, unknown> } {
    const config = rule.config as unknown as OfacVesselAircraftRuleConfig;
    const sanctionsList = config.sanctions_list ?? [];
    const counterparties: OfacCounterparty[] = context.counterparties ?? [];
    const allowedTypes: OfacEntityType[] | undefined = config.entity_types;

    // Per-tenant threshold > rule config threshold > default 0.85
    const tenantThreshold = context.tenant_settings?.sanctions_threshold;
    const threshold =
      typeof tenantThreshold === 'number'
        ? tenantThreshold
        : typeof config.jaro_winkler_threshold === 'number'
        ? config.jaro_winkler_threshold
        : 0.85;

    if (counterparties.length === 0 || sanctionsList.length === 0) {
      return {
        triggered: false,
        details: {
          screened_count: 0,
          reason: counterparties.length === 0
            ? 'No counterparties to screen'
            : 'No sanctions list configured',
        },
      };
    }

    const matches: OfacScreeningMatch[] = [];

    for (const cp of counterparties) {
      // Skip if entity type is not in the configured filter.
      if (allowedTypes !== undefined && !allowedTypes.includes(cp.type)) {
        continue;
      }

      // Validate and conditionally surface IMO number.
      // An invalid IMO is NOT a screening error — the counterparty is still
      // screened by name. The malformed value is simply not echoed to details.
      const validatedImo =
        cp.type === 'vessel' &&
        typeof cp.imo_number === 'string' &&
        RuleEvaluator.IMO_PATTERN.test(cp.imo_number)
          ? cp.imo_number
          : undefined;

      const normName = normalizeName(cp.name);
      let bestMatch: {
        candidate: string;
        score: number;
        matchType: 'exact' | 'fuzzy';
      } | null = null;

      for (const candidate of sanctionsList) {
        const normCandidate = normalizeName(candidate);

        if (normName === normCandidate) {
          bestMatch = { candidate, score: 1.0, matchType: 'exact' };
          break; // Exact match is definitive; skip remaining candidates.
        }

        if (config.fuzzy_enabled !== false) {
          const score = jaroWinkler(cp.name, candidate, { transliterate: true });
          if (score >= threshold) {
            if (!bestMatch || score > bestMatch.score) {
              bestMatch = { candidate, score, matchType: 'fuzzy' };
            }
          }
        }
      }

      if (bestMatch) {
        const isFuzzy = bestMatch.matchType === 'fuzzy';
        const match: OfacScreeningMatch = {
          screened_name: cp.name,
          entity_type: cp.type,
          matched_candidate: bestMatch.candidate,
          similarity_score: bestMatch.score,
          match_type: bestMatch.matchType,
          // Format: ofac_<entity_type>_<match_type>
          match_reason: `ofac_${cp.type}_${bestMatch.matchType}`,
          action: isFuzzy ? 'pending_review' : 'auto_deny',
          ...(validatedImo !== undefined ? { imo_number: validatedImo } : {}),
        };
        matches.push(match);
      }
    }

    if (matches.length === 0) {
      return {
        triggered: false,
        details: {
          screened_count: counterparties.length,
          matched: false,
          threshold,
        },
      };
    }

    // Determine overall action: if any match is auto_deny, surface that.
    const overallAction = matches.some(m => m.action === 'auto_deny')
      ? 'auto_deny'
      : 'pending_review';

    return {
      triggered: true,
      details: {
        screened_count: counterparties.length,
        matched: true,
        match_count: matches.length,
        matches,
        threshold,
        action: overallAction,
      },
    };
  }
}

// ─── Structuring Cluster Score Computation ────────────────────────────────────

/** A single histogram bin in the amount-clustering histogram. */
export interface StructuringHistogramBin {
  /** Lower bound (inclusive). */
  min: number;
  /** Upper bound (exclusive). */
  max: number;
  /** Number of transactions in this bin. */
  count: number;
  /** Total amount in this bin. */
  total: number;
}

/** Result of the structuring cluster score computation. */
export interface StructuringClusterResult {
  /** Overall cluster score (0–1), higher = more suspicious. */
  clusterScore: number;
  /** Full histogram bins, sorted by count descending. */
  histogram: StructuringHistogramBin[];
  /** Number of transactions that fall into bins near the reporting threshold. */
  similarTransactionCount: number;
  /** Total amount across all clustered bins (bins with count ≥ 2). */
  totalClusteredAmount: number;
}

/**
 * @notice Compute a structuring cluster score from a list of deposit amounts
 *         using histogram-based clustering.
 *
 * @dev    Algorithm:
 *         1. Sort amounts and bucket them into histogram bins of `binSize`.
 *         2. Identify the "threshold band" — bins whose upper bound is just
 *            below the reporting threshold (within 2 × binSize).
 *         3. Count transactions in the threshold band as "similar transactions."
 *         4. Compute the cluster score as a weighted combination of:
 *            - `concentrationScore`: fraction of all transactions inside the
 *              threshold band (higher = more suspicious clustering).
 *            - `volumeScore`: total amount in the threshold band relative to the
 *              reporting threshold (higher = closer to triggering manual review).
 *         5. The final score is clamped to [0, 1].
 *
 *         Refunds (`status === 'failed'`) must be filtered by the caller before
 *         passing amounts to this function; they will distort the cluster score.
 *
 * @param amounts           - Array of deposit amounts (already filtered for non-failed).
 * @param reportingThreshold - Regulatory reporting threshold (e.g., 10000).
 * @param binSize           - Size of each histogram bin (default 500).
 * @returns A `StructuringClusterResult` with score, histogram, and metadata.
 */
export function computeStructuringClusterScore(
  amounts: number[],
  reportingThreshold: number,
  binSize: number = 500,
): StructuringClusterResult {
  if (amounts.length === 0) {
    return { clusterScore: 0, histogram: [], similarTransactionCount: 0, totalClusteredAmount: 0 };
  }

  // Sort amounts for consistent binning
  const sorted = [...amounts].sort((a, b) => a - b);
  const minAmount = sorted[0];
  const maxAmount = sorted[sorted.length - 1];

  // Build histogram bins
  const histogram: StructuringHistogramBin[] = [];
  for (let edge = Math.floor(minAmount / binSize) * binSize; edge <= maxAmount; edge += binSize) {
    const binMin = edge;
    const binMax = edge + binSize;
    const inBin = sorted.filter(a => a >= binMin && a < binMax);
    if (inBin.length > 0) {
      histogram.push({
        min: binMin,
        max: binMax,
        count: inBin.length,
        total: inBin.reduce((s, a) => s + a, 0),
      });
    }
  }

  // Sort bins by count descending for the top_bins output
  const sortedBins = [...histogram].sort((a, b) => b.count - a.count);

  // Identify the "threshold band": bins whose amounts are within 2 × binSize
  // below the reporting threshold. These represent deposits clustered just
  // under the regulatory limit (classic structuring/smurfing pattern).
  const thresholdBandLower = reportingThreshold - 2 * binSize;
  const thresholdBandUpper = reportingThreshold;

  const thresholdBins = histogram.filter(
    b => b.max > thresholdBandLower && b.max <= thresholdBandUpper,
  );

  const similarTransactionCount = thresholdBins.reduce((s, b) => s + b.count, 0);
  const totalClusteredAmount = histogram
    .filter(b => b.count >= 2)
    .reduce((s, b) => s + b.total, 0);

  // ── Score computation ──────────────────────────────────────────────────

  // concentrationScore: fraction of all transactions that fall into the
  // threshold band. A high fraction means the investor is heavily
  // concentrating deposits just under the reporting limit.
  const concentrationScore = amounts.length > 0
    ? similarTransactionCount / amounts.length
    : 0;

  // volumeScore: total amount in the threshold band relative to the
  // reporting threshold. Values near 1.0 indicate deposits are nearly
  // hitting the threshold (multiplied across multiple transactions).
  const thresholdBandTotal = thresholdBins.reduce((s, b) => s + b.total, 0);
  const volumeScore = reportingThreshold > 0
    ? Math.min(thresholdBandTotal / reportingThreshold, 1.0)
    : 0;

  // Bin concentration bonus: if most transactions are in a single bin,
  // that's a stronger signal of deliberate structuring.
  const maxBinCount = sortedBins.length > 0 ? sortedBins[0].count : 0;
  const binConcentrationBonus = amounts.length > 0
    ? (maxBinCount / amounts.length) * 0.3
    : 0;

  // Final cluster score: weighted combination, clamped to [0, 1]
  const rawScore = (concentrationScore * 0.4) + (volumeScore * 0.4) + binConcentrationBonus;
  const clusterScore = Math.min(Math.max(rawScore, 0), 1);

  return {
    clusterScore: Math.round(clusterScore * 10000) / 10000, // round to 4 decimals
    histogram: sortedBins,
    similarTransactionCount,
    totalClusteredAmount,
  };
}
