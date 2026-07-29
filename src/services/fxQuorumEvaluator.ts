/**
 * FX Quorum / Variance Guard
 * ===========================
 *
 * Problem
 * -------
 * The FX rate pipeline aggregates several upstream rate providers (see
 * `providerHealthScorer.ts`). Historically `FxProviderRouter` would *silently*
 * pick the first healthy provider's rate. When two or more providers disagree
 * by more than a variance threshold this hides a data-integrity bug: a single
 * misbehaving provider could feed a wildly wrong rate into a conversion, a
 * ledger post, or a payout — with no signal that anything was wrong.
 *
 * Solution
 * --------
 * This module adds a **quorum rule**: at least `k` of `n` configured providers
 * must report a rate within a relative `tolerance` of a consensus reference.
 * When the quorum is *not* met the run is blocked (a 503 is raised), ops are
 * paged with the divergent rates attached, a `fx_quorum_failed_total` counter is
 * emitted, and the event is written to the audit trail.
 *
 * Design notes
 * ------------
 * - The evaluator is **pure and framework-free**: it only depends on
 *   `ExchangeRate`, `MetricsCollector`, `Logger` and (optionally) a pager sink.
 *   This keeps it trivially unit-testable and easy to review.
 * - The consensus reference is, by default, the **median** of the returned
 *   mids. Using the median (rather than the mean or "first provider") makes the
 *   reference robust to a single outlier and prevents the outlier from becoming
 *   the chosen rate. A `mean` mode is available for callers that prefer it.
 *   `Libor`-style means can be skewed by one bad quote; median cannot.
 * - "Within tolerance" is evaluated **relatively**: `|v - ref| / ref <= tolerance`.
 *   A relative tolerance is the correct model for FX rates, which span many
 *   orders of magnitude across currency pairs.
 * - The returned consensus rate is the **median** of `bid`/`ask`/`mid` across
 *   the in-consensus providers, with the most-recent timestamp and the smallest
 *   `ttlMs` (most conservative freshness) — so a safe, aggregated quote is used
 *   rather than a single provider's quote.
 *
 * Edge cases handled
 * ------------------
 * - Single-provider outage: if one of `n` providers is down (returns `null`) but
 *   the remaining `n-1` are within tolerance and `k <= n-1`, quorum is met.
 * - Total outage (all `null`): quorum cannot be reached → blocked + paged.
 * - Fewer than 2 configured providers with `allowReducedQuorum` (default): the
 *   lone provider is trusted (there is nothing to disagree with). Set
 *   `allowReducedQuorum: false` to force a failure when quorum is impossible.
 * - `k > n` (misconfiguration): quorum can never be reached → blocked + paged,
 *   surfacing the misconfiguration to operators.
 *
 * Security assumptions
 * -------------------
 * - Provider ids and currency pairs are treated as **untrusted labels** and are
 *   sanitised before being used as metric labels or logged (mirrors the
 *   scorer's `sanitizeProviderId`).
 * - No secrets, PII, or credentials are emitted in metrics, logs, or the pager
 *   payload. Only provider ids, the pair, numeric rates and the deviation are
 *   included — exactly what an on-call engineer needs to triage.
 * - The pager callback is wrapped so a failing pager never crashes the caller.
 *
 * @module services/fxQuorumEvaluator
 */

import { Decimal } from '../lib/decimal';
import { AppError, ErrorCode } from '../lib/errors';
import { Logger } from '../lib/logger';
import { MetricsCollector } from '../lib/metrics';
import { SecurityAuditRepository } from '../security/types';
import { ExchangeRate } from './fxConversionEngine';

// ─── Metric names (Prometheus-style, underscore-separated per codebase convention) ─

/** Counter incremented every time a quorum evaluation is performed. */
export const METRIC_QUORUM_EVALUATED = 'fx_quorum_evaluated_total';
/** Counter incremented when quorum is satisfied. */
export const METRIC_QUORUM_PASSED = 'fx_quorum_passed_total';
/** Counter incremented when quorum FAILS (providers diverge beyond tolerance). */
export const METRIC_QUORUM_FAILED = 'fx_quorum_failed_total';
/** Gauge: number of providers that agreed within tolerance for the last eval. */
export const METRIC_QUORUM_IN_CONSENSUS = 'fx_quorum_in_consensus';
/** Gauge: maximum relative deviation observed in the last eval (0..n). */
export const METRIC_QUORUM_DIVERGENCE = 'fx_quorum_divergence_ratio';

// ─── Types ────────────────────────────────────────────────────────────────────

/** How the consensus reference value is computed from the returned rates. */
export type QuorumReference = 'median' | 'mean';

/**
 * Tenant-facing quorum configuration as persisted in tenant settings. Only the
 * operator-tunable knobs (`k`, `tolerance`, `reference`) are exposed; the
 * remaining {@link FxQuorumConfig} fields (e.g. `minValidProviders`) are
 * platform defaults applied at resolution time.
 */
export interface FxQuorumTenantConfig {
  /** Minimum providers that must agree within tolerance (K). Must be >= 1. */
  k: number;
  /** Relative tolerance, e.g. 0.005 = 0.5%. Must be >= 0. */
  tolerance: number;
  /** Consensus reference method. Defaults to 'median' when omitted. */
  reference?: QuorumReference;
}

/**
 * Tenant-agnostic quorum configuration.
 *
 * `k` is the minimum number of providers that must agree within `tolerance`
 * (relative, e.g. `0.005` = 0.5%). `reference` selects how the consensus
 * centre is computed. See {@link FxQuorumEvaluator} for semantics.
 */
export interface FxQuorumConfig {
  /** Minimum providers that must agree within tolerance (K). Must be >= 1. */
  k: number;
  /** Relative tolerance, e.g. 0.005 = 0.5%. Must be a finite number >= 0. */
  tolerance: number;
  /** Consensus reference method. Default: 'median'. */
  reference?: QuorumReference;
  /**
   * Soft floor on the number of *valid* (non-null) rates required before quorum
   * can pass. Defaults to `k`. Use this to forbid passing when too many
   * providers are simultaneously unavailable (e.g. `minValidProviders: n`).
   */
  minValidProviders?: number;
  /**
   * When true (default) a single configured provider is trusted (nothing to
   * disagree with). Set false to force a failure when quorum is impossible.
   */
  allowReducedQuorum?: boolean;
}

/** One provider's contribution to a quorum evaluation. */
export interface FxQuorumProviderInput {
  providerId: string;
  rate: ExchangeRate | null;
}

/** A provider whose rate diverged beyond tolerance. */
export interface FxQuorumDivergentEntry {
  providerId: string;
  /** Rate mid as a string (no precision loss). */
  value: string;
  /** Relative deviation from the consensus reference (0..n). */
  deviation: number;
}

/**
 * Result of a quorum assessment. `agreed: false` is the failure payload that is
 * handed to the pager / audit trail.
 */
export interface FxQuorumAssessment {
  agreed: boolean;
  /** Currency pair evaluated (sanitised). */
  pair: string;
  /** Required number of agreeing providers (K). */
  k: number;
  /** Configured provider count (N). */
  total: number;
  /** Number of providers that returned a non-null rate. */
  valid: number;
  /** Number of valid providers within tolerance of the reference. */
  inConsensus: number;
  /** Relative tolerance used. */
  tolerance: number;
  /** Consensus reference value (mid) as a string. */
  reference: string;
  /** Providers that diverged beyond tolerance. */
  divergent: FxQuorumDivergentEntry[];
  /** Every provider's contribution (value or null for outages). */
  rates: { providerId: string; value: string | null }[];
  /** ISO timestamp of the evaluation. */
  evaluatedAt: string;
  /** Present only when `agreed` is true: the aggregated consensus rate. */
  consensusRate?: ExchangeRate;
}

/** Sink invoked (best-effort) when quorum fails, to page on-call ops. */
export type FxQuorumPageSink = (failure: FxQuorumAssessment) => void | Promise<void>;

/**
 * Error raised when quorum is not met. It is an operational `AppError` with a
 * 503 status so the FX pipeline blocks the run exactly as it would for a stale
 * or unavailable rate.
 */
export class FxQuorumFailedError extends AppError {
  public readonly details: FxQuorumAssessment;

  constructor(failure: FxQuorumAssessment) {
    super(
      ErrorCode.SERVICE_UNAVAILABLE,
      503,
      `FX rate quorum not reached for ${failure.pair}: ` +
        `${failure.inConsensus}/${failure.k} providers within tolerance ` +
        `${failure.tolerance} (valid ${failure.valid}/${failure.total})`,
      failure,
      { expose: true, isOperational: true },
    );
    this.name = 'FxQuorumFailedError';
    this.details = failure;
  }
}

// ─── FxQuorumEvaluator ────────────────────────────────────────────────────────

/**
 * Evaluates provider agreement for a single FX pair and produces either a
 * consensus {@link ExchangeRate} or a {@link FxQuorumFailedError}.
 *
 * @example
 * ```typescript
 * const evaluator = new FxQuorumEvaluator(
 *   { k: 2, tolerance: 0.005 },
 *   { metrics, logger, pager: (f) => pager.pageOps(f) },
 * );
 *
 * // Inside the rate-fetch pipeline:
 * const consensus = evaluator.evaluate(pair, [
 *   { providerId: 'prime',   rate: await prime.getRate(f, t) },
 *   { providerId: 'backup',  rate: await backup.getRate(f, t) },
 *   { providerId: 'fix',     rate: await fix.getRate(f, t) },
 * ]);
 * ```
 */
export class FxQuorumEvaluator {
  private readonly k: number;
  private readonly tolerance: number;
  private readonly reference: QuorumReference;
  private readonly minValidProviders: number;
  private readonly allowReducedQuorum: boolean;

  constructor(
    private readonly config: FxQuorumConfig,
    private readonly options: {
      metrics?: MetricsCollector;
      logger?: Logger;
      pager?: FxQuorumPageSink;
    } = {},
  ) {
    if (!Number.isInteger(config.k) || config.k < 1) {
      throw new Error('FxQuorumEvaluator: k must be an integer >= 1');
    }
    if (
      typeof config.tolerance !== 'number' ||
      !Number.isFinite(config.tolerance) ||
      config.tolerance < 0
    ) {
      throw new Error('FxQuorumEvaluator: tolerance must be a finite number >= 0');
    }
    if (
      config.reference !== undefined &&
      config.reference !== 'median' &&
      config.reference !== 'mean'
    ) {
      throw new Error("FxQuorumEvaluator: reference must be 'median' or 'mean'");
    }

    this.k = config.k;
    this.tolerance = config.tolerance;
    this.reference = config.reference ?? 'median';
    this.minValidProviders = config.minValidProviders ?? config.k;
    this.allowReducedQuorum = config.allowReducedQuorum ?? true;
  }

  /**
   * Non-throwing assessment. Returns an {@link FxQuorumAssessment} with
   * `agreed: true` (and a `consensusRate`) or `agreed: false`.
   */
  assess(pair: string, inputs: FxQuorumProviderInput[]): FxQuorumAssessment {
    const safePair = sanitizePair(pair);
    const total = inputs.length;
    const valid = inputs.filter((i) => i.rate !== null) as {
      providerId: string;
      rate: ExchangeRate;
    }[];

    const base = {
      pair: safePair,
      k: this.k,
      total,
      tolerance: this.tolerance,
      evaluatedAt: new Date().toISOString(),
      rates: inputs.map((i) => ({
        providerId: sanitizeId(i.providerId),
        value: i.rate ? i.rate.mid.toString() : null,
      })),
    };

    // Nothing usable at all.
    if (valid.length === 0) {
      return {
        ...base,
        agreed: false,
        valid: 0,
        inConsensus: 0,
        reference: '0',
        divergent: [],
      };
    }

    // Fewer than two providers: there is nothing to disagree about.
    if (total < 2 && this.allowReducedQuorum) {
      const only = valid[0].rate;
      return {
        ...base,
        agreed: true,
        valid: valid.length,
        inConsensus: valid.length,
        reference: only.mid.toString(),
        divergent: [],
        consensusRate: only,
      };
    }

    // Compute the consensus reference from the valid mids.
    const referenceValue = this.computeReference(valid.map((v) => v.rate.mid));

    // Classify each valid provider relative to the reference.
    const classified = valid.map((v) => {
      const mid = v.rate.mid;
      const deviation = relativeDeviation(mid, referenceValue);
      return {
        providerId: v.providerId,
        rate: v.rate,
        value: mid.toString(),
        deviation,
        inConsensus: deviation <= this.tolerance,
      };
    });

    const inConsensusProviders = classified.filter((c) => c.inConsensus);
    const divergent: FxQuorumDivergentEntry[] = classified
      .filter((c) => !c.inConsensus)
      .map((c) => ({
        providerId: sanitizeId(c.providerId),
        value: c.value,
        deviation: c.deviation,
      }));

    const quorumMet =
      inConsensusProviders.length >= this.k &&
      valid.length >= this.minValidProviders;

    if (quorumMet) {
      const consensusRate = aggregateConsensus(
        inConsensusProviders.map((c) => c.rate),
        safePair,
      );
      return {
        ...base,
        agreed: true,
        valid: valid.length,
        inConsensus: inConsensusProviders.length,
        reference: referenceValue.toString(),
        divergent,
        consensusRate,
      };
    }

    return {
      ...base,
      agreed: false,
      valid: valid.length,
      inConsensus: inConsensusProviders.length,
      reference: referenceValue.toString(),
      divergent,
    };
  }

  /**
   * Throwing variant used by the rate-fetch pipeline. Returns the aggregated
   * consensus {@link ExchangeRate}, or raises {@link FxQuorumFailedError} after
   * emitting metrics, logging, and paging ops.
   */
  evaluate(pair: string, inputs: FxQuorumProviderInput[]): ExchangeRate {
    const result = this.assess(pair, inputs);
    const { metrics, logger, pager } = this.options;

    metrics?.incrementCounter(METRIC_QUORUM_EVALUATED, { pair: sanitizePair(pair) });

    if (result.agreed && result.consensusRate) {
      metrics?.incrementCounter(METRIC_QUORUM_PASSED, { pair: result.pair });
      metrics?.setGauge(METRIC_QUORUM_IN_CONSENSUS, result.inConsensus, {
        pair: result.pair,
      });
      return result.consensusRate;
    }

    // ── Failure path: emit, log, page, then block the run. ──
    metrics?.incrementCounter(METRIC_QUORUM_FAILED, { pair: result.pair });
    metrics?.setGauge(METRIC_QUORUM_IN_CONSENSUS, result.inConsensus, {
      pair: result.pair,
    });
    metrics?.setGauge(
      METRIC_QUORUM_DIVERGENCE,
      maxDeviation(result.divergent),
      { pair: result.pair },
    );

    logger?.error('FX rate quorum failed: provider divergence beyond tolerance', {
      pair: result.pair,
      inConsensus: result.inConsensus,
      required: result.k,
      valid: result.valid,
      total: result.total,
      tolerance: result.tolerance,
      reference: result.reference,
      divergent: result.divergent,
    });

    if (pager) {
      try {
        const paged = pager(result);
        if (paged instanceof Promise) {
          // Fire-and-forget: never let the pager delay or crash the pipeline.
          paged.catch((err) =>
            logger?.error('FX quorum pager rejected', { error: String(err) }),
          );
        }
      } catch (err) {
        logger?.error('FX quorum pager threw', { error: String(err) });
      }
    }

    throw new FxQuorumFailedError(result);
  }

  /** Exposed for tests / review: the parsed, validated config. */
  getConfig(): Readonly<FxQuorumConfig> {
    return {
      k: this.k,
      tolerance: this.tolerance,
      reference: this.reference,
      minValidProviders: this.minValidProviders,
      allowReducedQuorum: this.allowReducedQuorum,
    };
  }

  // ── Reference computation ──────────────────────────────────────────────────

  private computeReference(values: Decimal[]): Decimal {
    if (this.reference === 'mean') {
      const sum = values.reduce((acc, v) => acc.add(v), new Decimal('0'));
      return sum.divide(new Decimal(String(values.length)));
    }
    // median
    const sorted = [...values].sort((a, b) => a.compareTo(b));
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return sorted[mid - 1].add(sorted[mid]).divide(new Decimal('2'));
  }
}

// ─── FxQuorumAlerting (pager + audit wiring) ───────────────────────────────────

/**
 * Bridges a quorum failure to on-call paging and the security audit trail.
 *
 * Construct it from a `pageOps` callback (your paging provider) and, optionally,
 * a {@link SecurityAuditRepository}. On failure it pages ops and records an
 * audit event that includes the divergent rates — satisfying the
 * "tenant-configurable with audit" requirement for the guard itself.
 *
 * Tenant-threshold changes are audited separately in `TenantSettingsService`.
 */
export class FxQuorumAlerting {
  constructor(
    private readonly pageOps: FxQuorumPageSink,
    private readonly auditRepo?: SecurityAuditRepository,
    private readonly context: { tenantId?: string; actorId?: string } = {},
  ) {}

  /** Page ops and (if configured) write the failure to the audit trail. */
  async handle(failure: FxQuorumAssessment): Promise<void> {
    try {
      await this.pageOps(failure);
    } catch (err) {
      // Paging is best-effort; do not let it abort the audit write.
      // eslint-disable-next-line no-console
      console.error('FxQuorumAlerting: pageOps failed', err);
    }

    if (this.auditRepo) {
      await this.auditRepo.record({
        id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        type: 'SECURITY_VIOLATION',
        userId: this.context.actorId,
        action: 'fx_quorum_failed',
        resource: `fx_quorum/${failure.pair}`,
        outcome: 'BLOCKED',
        details: {
          tenant_id: this.context.tenantId,
          pair: failure.pair,
          required: failure.k,
          total: failure.total,
          valid: failure.valid,
          in_consensus: failure.inConsensus,
          tolerance: failure.tolerance,
          reference: failure.reference,
          divergent: failure.divergent,
          rates: failure.rates,
          evaluated_at: failure.evaluatedAt,
        },
        securityContext: {
          requestId: `req_${Date.now()}`,
          ipAddress: 'system',
          userAgent: 'fx-quorum-guard',
          timestamp: new Date(),
        },
        timestamp: new Date(),
      });
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Relative deviation of `value` from `ref`, i.e. |value - ref| / ref. */
function relativeDeviation(value: Decimal, ref: Decimal): number {
  if (ref.isZero()) {
    // Reference is zero (degenerate). Anything non-zero diverges infinitely.
    return value.isZero() ? 0 : Infinity;
  }
  const diff = value.subtract(ref);
  // Take the absolute difference via compareTo so we never call toString() on a
  // negative Decimal (defensive; Decimal.toString handles negatives correctly,
  // but this keeps the math robust regardless).
  const absDiff = diff.compareTo(new Decimal('0')) >= 0 ? diff : ref.subtract(value);
  return Number(absDiff.toString()) / Number(ref.toString());
}

/** Largest relative deviation among divergent entries (0 if none). */
function maxDeviation(divergent: FxQuorumDivergentEntry[]): number {
  return divergent.reduce((max, d) => Math.max(max, d.deviation), 0);
}

/** Median of a list of Decimals (used to aggregate the consensus quote). */
function medianDecimal(values: Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.compareTo(b));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return sorted[mid - 1].add(sorted[mid]).divide(new Decimal('2'));
}

/**
 * Build a single consensus {@link ExchangeRate} from the in-consensus rates by
 * taking the median of each leg and the most-recent timestamp / smallest ttl.
 */
function aggregateConsensus(rates: ExchangeRate[], pair: string): ExchangeRate {
  const bids = rates.map((r) => r.bid);
  const asks = rates.map((r) => r.ask);
  const mids = rates.map((r) => r.mid);
  const timestamps = rates.map((r) => r.timestamp.getTime());
  const ttlMs = Math.min(...rates.map((r) => r.ttlMs));
  const latest = new Date(Math.max(...timestamps));

  return {
    pair,
    bid: medianDecimal(bids),
    ask: medianDecimal(asks),
    mid: medianDecimal(mids),
    timestamp: latest,
    ttlMs,
  };
}

/** Sanitise a provider id so it is safe as a metric label / log field. */
function sanitizeId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
}

/** Sanitise a currency pair (e.g. "USD/EUR" -> "USD_EUR") for labels. */
function sanitizePair(pair: string): string {
  return String(pair).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
}
