/**
 * FX Provider Health Scoring Service
 *
 * Tracks per-provider rolling metrics (success rate, p95 latency, rate staleness)
 * and automatically demotes unreliable providers out of primary rotation, then
 * promotes them back after a sustained recovery window.
 *
 * Oscillation Prevention
 * ─────────────────────
 * Demotion and promotion use separate thresholds (hysteresis), mirroring the
 * PressureGauge pattern already used in this codebase.  A provider must cross
 * the *demotion* threshold to leave primary rotation, but must cross the lower
 * *promotion* threshold to re-enter it.  The demoted provider also has a
 * mandatory `recoveryWindowMs` cooldown before it is eligible for promotion,
 * giving it time to stabilise before being observed again.
 *
 * Observability
 * ─────────────
 * Every state transition emits:
 *  - A `setGauge` call to the MetricsCollector (fx_provider_health_score,
 *    fx_provider_status)
 *  - A structured log entry via the Logger (WARN on demotion, INFO on promotion)
 *  - An optional user-supplied callback for alert integration
 *
 * Security Assumptions
 * ─────────────────────
 * - Provider names are treated as untrusted labels and sanitised before use
 *   in metrics to prevent metric-injection attacks.
 * - No secrets or PII are included in log/metric output.
 * - The scorer is process-local; multi-replica deployments require an external
 *   coordination layer for consistent global demotion state.
 *
 * @module services/providerHealthScorer
 */

import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';
import { RateProvider, ExchangeRate } from './fxConversionEngine';
import { FxQuorumEvaluator } from './fxQuorumEvaluator';

// ─── Metric names ─────────────────────────────────────────────────────────────

/** 0.0–1.0 rolling success rate (gauge). */
const METRIC_HEALTH_SCORE = 'fx_provider_health_score';
/** 1 = primary (healthy), 0 = demoted. */
const METRIC_PROVIDER_STATUS = 'fx_provider_status';
/** Rolling p95 call latency in milliseconds (gauge). */
const METRIC_LATENCY_P95 = 'fx_provider_latency_p95_ms';
/** Total demotion events (counter). */
const METRIC_DEMOTIONS_TOTAL = 'fx_provider_demotions_total';
/** Total promotion events (counter). */
const METRIC_PROMOTIONS_TOTAL = 'fx_provider_promotions_total';
/** Total provider calls (counter). */
const METRIC_CALLS_TOTAL = 'fx_provider_calls_total';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Individual call outcome recorded by ScoredRateProvider.
 */
export interface CallRecord {
  /** Whether the call succeeded (returned a non-null rate). */
  success: boolean;
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
  /** Age of the returned rate in ms, or null if the call failed. */
  rateAgeMs: number | null;
  /** When this call was made. */
  timestamp: Date;
}

/**
 * Computed rolling metrics for a provider over the current window.
 */
export interface ProviderHealthSnapshot {
  /** Provider identifier. */
  providerId: string;
  /** Fraction of calls that succeeded (0.0–1.0). */
  successRate: number;
  /** 95th-percentile call latency in ms, or null if no calls recorded. */
  latencyP95Ms: number | null;
  /** Mean staleness of returned rates in ms, or null if no successful calls. */
  meanRateAgeMs: number | null;
  /** Number of calls in the current window. */
  windowSize: number;
  /** Whether this provider is currently in primary rotation. */
  isHealthy: boolean;
  /** Timestamp of the last state change (demotion or promotion). */
  lastStateChangeAt: Date;
}

/**
 * Configuration for ProviderHealthScorer.
 */
export interface ProviderHealthScorerConfig {
  /**
   * Maximum number of call records to keep per provider (rolling window).
   * Older records are evicted as new ones arrive.
   * Default: 100
   */
  windowSize?: number;

  /**
   * Minimum number of calls required before health evaluation begins.
   * Providers with fewer calls are always treated as healthy.
   * Default: 10
   */
  minCallsForEvaluation?: number;

  /**
   * Success-rate threshold below which a provider is demoted.
   * Must be above `promotionSuccessRate` for hysteresis to function.
   * Default: 0.80 (80 %)
   */
  demotionSuccessRate?: number;

  /**
   * Success-rate threshold above which a demoted provider is promoted back.
   * Default: 0.90 (90 %)
   */
  promotionSuccessRate?: number;

  /**
   * p95 latency ceiling (ms) above which a provider is demoted.
   * Set to Infinity to disable latency-based demotion.
   * Default: 5000 ms
   */
  demotionLatencyP95Ms?: number;

  /**
   * p95 latency below which a demoted provider can be promoted back.
   * Default: 2000 ms
   */
  promotionLatencyP95Ms?: number;

  /**
   * Rate staleness ceiling (ms) above which a provider is demoted.
   * Set to Infinity to disable staleness-based demotion.
   * Default: 30_000 ms (30 s)
   */
  demotionRateAgeMs?: number;

  /**
   * Mean rate age below which a demoted provider can be promoted back.
   * Default: 15_000 ms (15 s)
   */
  promotionRateAgeMs?: number;

  /**
   * Minimum time (ms) a provider must remain demoted before it can be
   * re-evaluated for promotion.  Prevents flip-flopping on borderline metrics.
   * Default: 60_000 ms (1 minute)
   */
  recoveryWindowMs?: number;
}

/**
 * Callback fired on every demotion or promotion event.
 *
 * @param event  - 'demoted' or 'promoted'
 * @param snapshot - Health snapshot at the time of the event
 */
export type HealthStateChangeCallback = (
  event: 'demoted' | 'promoted',
  snapshot: ProviderHealthSnapshot
) => void;

// ─── ProviderHealthScorer ─────────────────────────────────────────────────────

/**
 * Tracks rolling health metrics for one or more named providers and enforces
 * demotion/promotion logic with hysteresis to prevent oscillation.
 *
 * @example
 * ```typescript
 * const scorer = new ProviderHealthScorer({ demotionSuccessRate: 0.8 }, metrics, logger);
 * scorer.onStateChange((event, snap) => alerting.fire(event, snap));
 *
 * const scored = new ScoredRateProvider('primary', primaryProvider, scorer);
 * const router  = new FxProviderRouter([scored, new ScoredRateProvider('backup', ...)], scorer);
 * const engine  = new FxConversionEngine(router, { metrics });
 * ```
 */
export class ProviderHealthScorer {
  private readonly windowSize: number;
  private readonly minCalls: number;
  private readonly demotionSuccessRate: number;
  private readonly promotionSuccessRate: number;
  private readonly demotionLatencyP95Ms: number;
  private readonly promotionLatencyP95Ms: number;
  private readonly demotionRateAgeMs: number;
  private readonly promotionRateAgeMs: number;
  private readonly recoveryWindowMs: number;

  /** Per-provider rolling call records. */
  private readonly records = new Map<string, CallRecord[]>();
  /** Per-provider demotion state. */
  private readonly demotedAt = new Map<string, Date>();
  /** Per-provider last-state-change timestamp. */
  private readonly lastStateChangeAt = new Map<string, Date>();
  /** State-change callbacks. */
  private readonly stateChangeCallbacks: HealthStateChangeCallback[] = [];

  constructor(
    config: ProviderHealthScorerConfig = {},
    private readonly metrics?: MetricsCollector,
    private readonly logger?: Logger
  ) {
    this.windowSize             = config.windowSize                ?? 100;
    this.minCalls               = config.minCallsForEvaluation     ?? 10;
    this.demotionSuccessRate    = config.demotionSuccessRate        ?? 0.80;
    this.promotionSuccessRate   = config.promotionSuccessRate       ?? 0.90;
    this.demotionLatencyP95Ms   = config.demotionLatencyP95Ms       ?? 5_000;
    this.promotionLatencyP95Ms  = config.promotionLatencyP95Ms      ?? 2_000;
    this.demotionRateAgeMs      = config.demotionRateAgeMs          ?? 30_000;
    this.promotionRateAgeMs     = config.promotionRateAgeMs         ?? 15_000;
    this.recoveryWindowMs       = config.recoveryWindowMs           ?? 60_000;

    if (this.promotionSuccessRate <= this.demotionSuccessRate) {
      throw new Error(
        `ProviderHealthScorer: promotionSuccessRate (${this.promotionSuccessRate}) ` +
        `must be greater than demotionSuccessRate (${this.demotionSuccessRate}) ` +
        `for hysteresis to function correctly.`
      );
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Register a callback invoked on every demotion or promotion event.
   */
  onStateChange(cb: HealthStateChangeCallback): void {
    this.stateChangeCallbacks.push(cb);
  }

  /**
   * Remove a previously-registered state-change callback.
   */
  offStateChange(cb: HealthStateChangeCallback): void {
    const idx = this.stateChangeCallbacks.indexOf(cb);
    if (idx !== -1) this.stateChangeCallbacks.splice(idx, 1);
  }

  /**
   * Record the outcome of one call to `providerId`.
   * Triggers health re-evaluation and may cause a demotion or promotion.
   *
   * @param providerId - Unique provider identifier (used as a metric label).
   * @param record     - Call outcome.
   */
  record(providerId: string, callRecord: CallRecord): void {
    const safe = this.sanitizeProviderId(providerId);

    // Initialise window if needed
    if (!this.records.has(safe)) {
      this.records.set(safe, []);
      this.lastStateChangeAt.set(safe, new Date());
    }

    const window = this.records.get(safe)!;
    window.push(callRecord);

    // Evict oldest record(s) to stay within windowSize
    while (window.length > this.windowSize) {
      window.shift();
    }

    // Track total calls metric
    this.metrics?.incrementCounter(METRIC_CALLS_TOTAL, { provider: safe });

    // Re-evaluate health after recording
    this.evaluate(safe);
  }

  /**
   * Returns true if the provider is currently in primary (healthy) rotation.
   * Providers with fewer than `minCalls` are always considered healthy.
   */
  isHealthy(providerId: string): boolean {
    const safe = this.sanitizeProviderId(providerId);
    return !this.demotedAt.has(safe);
  }

  /**
   * Returns a snapshot of rolling health metrics for the given provider.
   * Returns `null` if no calls have been recorded yet.
   */
  getSnapshot(providerId: string): ProviderHealthSnapshot | null {
    const safe = this.sanitizeProviderId(providerId);
    const window = this.records.get(safe);
    if (!window) return null;
    return this.buildSnapshot(safe, window);
  }

  /**
   * Returns snapshots for all known providers.
   */
  getAllSnapshots(): ProviderHealthSnapshot[] {
    const snapshots: ProviderHealthSnapshot[] = [];
    for (const [id, window] of this.records) {
      snapshots.push(this.buildSnapshot(id, window));
    }
    return snapshots;
  }

  /**
   * Resets all stored records and demotion state for the given provider.
   * Useful in tests or when a provider is completely replaced.
   */
  reset(providerId: string): void {
    const safe = this.sanitizeProviderId(providerId);
    this.records.delete(safe);
    this.demotedAt.delete(safe);
    this.lastStateChangeAt.delete(safe);
  }

  // ── Internal evaluation logic ──────────────────────────────────────────────

  /**
   * Core evaluation loop called after every `record()` call.
   * Checks demotion/promotion thresholds and fires state-change events.
   */
  private evaluate(providerId: string): void {
    const window = this.records.get(providerId)!;

    // Not enough data yet — skip evaluation
    if (window.length < this.minCalls) return;

    const snapshot = this.buildSnapshot(providerId, window);

    if (this.demotedAt.has(providerId)) {
      // ── Promotion check ──────────────────────────────────────────────────
      this.maybePromote(providerId, snapshot);
    } else {
      // ── Demotion check ───────────────────────────────────────────────────
      this.maybeDemote(providerId, snapshot);
    }

    // Publish gauges unconditionally so dashboards stay current
    this.publishMetrics(providerId, snapshot);
  }

  private maybeDemote(providerId: string, snapshot: ProviderHealthSnapshot): void {
    const shouldDemote =
      snapshot.successRate        < this.demotionSuccessRate   ||
      this.exceedsLatencyDemotion(snapshot.latencyP95Ms)       ||
      this.exceedsStaleness(snapshot.meanRateAgeMs);

    if (!shouldDemote) return;

    // Transition to demoted
    const now = new Date();
    this.demotedAt.set(providerId, now);
    this.lastStateChangeAt.set(providerId, now);

    const updatedSnapshot = this.buildSnapshot(providerId, this.records.get(providerId)!);

    this.metrics?.incrementCounter(METRIC_DEMOTIONS_TOTAL, { provider: providerId });

    this.logger?.warn('FX provider demoted from primary rotation', {
      provider:      providerId,
      successRate:   snapshot.successRate,
      latencyP95Ms:  snapshot.latencyP95Ms,
      meanRateAgeMs: snapshot.meanRateAgeMs,
      windowSize:    snapshot.windowSize,
    });

    this.fireCallbacks('demoted', updatedSnapshot);
  }

  private maybePromote(providerId: string, snapshot: ProviderHealthSnapshot): void {
    const demotedAt = this.demotedAt.get(providerId)!;
    const now = Date.now();

    // Enforce mandatory recovery window before evaluating for promotion
    if (now - demotedAt.getTime() < this.recoveryWindowMs) return;

    const canPromote =
      snapshot.successRate               >= this.promotionSuccessRate      &&
      !this.exceedsLatencyPromotion(snapshot.latencyP95Ms)                 &&
      !this.exceedsStalenesPromotion(snapshot.meanRateAgeMs);

    if (!canPromote) return;

    // Transition to healthy
    this.demotedAt.delete(providerId);
    const changeAt = new Date();
    this.lastStateChangeAt.set(providerId, changeAt);

    const updatedSnapshot = this.buildSnapshot(providerId, this.records.get(providerId)!);

    this.metrics?.incrementCounter(METRIC_PROMOTIONS_TOTAL, { provider: providerId });

    this.logger?.info('FX provider promoted back to primary rotation', {
      provider:      providerId,
      successRate:   snapshot.successRate,
      latencyP95Ms:  snapshot.latencyP95Ms,
      meanRateAgeMs: snapshot.meanRateAgeMs,
      windowSize:    snapshot.windowSize,
    });

    this.fireCallbacks('promoted', updatedSnapshot);
  }

  // ── Threshold helpers ─────────────────────────────────────────────────────

  private exceedsLatencyDemotion(p95Ms: number | null): boolean {
    if (p95Ms === null || this.demotionLatencyP95Ms === Infinity) return false;
    return p95Ms > this.demotionLatencyP95Ms;
  }

  private exceedsLatencyPromotion(p95Ms: number | null): boolean {
    if (p95Ms === null || this.promotionLatencyP95Ms === Infinity) return false;
    return p95Ms > this.promotionLatencyP95Ms;
  }

  private exceedsStaleness(meanAgeMs: number | null): boolean {
    if (meanAgeMs === null || this.demotionRateAgeMs === Infinity) return false;
    return meanAgeMs > this.demotionRateAgeMs;
  }

  private exceedsStalenesPromotion(meanAgeMs: number | null): boolean {
    if (meanAgeMs === null || this.promotionRateAgeMs === Infinity) return false;
    return meanAgeMs > this.promotionRateAgeMs;
  }

  // ── Snapshot builder ──────────────────────────────────────────────────────

  private buildSnapshot(providerId: string, window: CallRecord[]): ProviderHealthSnapshot {
    const total      = window.length;
    const successes  = window.filter(r => r.success).length;
    const successRate = total === 0 ? 1.0 : successes / total;

    const latencies  = window.map(r => r.latencyMs).sort((a, b) => a - b);
    const latencyP95Ms = latencies.length === 0
      ? null
      : latencies[Math.floor(latencies.length * 0.95)];

    const ages = window.filter(r => r.rateAgeMs !== null).map(r => r.rateAgeMs as number);
    const meanRateAgeMs = ages.length === 0
      ? null
      : ages.reduce((acc, v) => acc + v, 0) / ages.length;

    return {
      providerId,
      successRate,
      latencyP95Ms,
      meanRateAgeMs,
      windowSize:      total,
      isHealthy:       !this.demotedAt.has(providerId),
      lastStateChangeAt: this.lastStateChangeAt.get(providerId) ?? new Date(0),
    };
  }

  // ── Metrics emission ──────────────────────────────────────────────────────

  private publishMetrics(providerId: string, snapshot: ProviderHealthSnapshot): void {
    const labels = { provider: providerId };
    this.metrics?.setGauge(METRIC_HEALTH_SCORE,  snapshot.successRate,         labels);
    this.metrics?.setGauge(METRIC_PROVIDER_STATUS, snapshot.isHealthy ? 1 : 0, labels);
    if (snapshot.latencyP95Ms !== null) {
      this.metrics?.setGauge(METRIC_LATENCY_P95, snapshot.latencyP95Ms, labels);
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  /** Sanitise provider identifiers so they are safe to use as metric labels. */
  private sanitizeProviderId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  }

  private fireCallbacks(
    event: 'demoted' | 'promoted',
    snapshot: ProviderHealthSnapshot
  ): void {
    for (const cb of this.stateChangeCallbacks) {
      try {
        cb(event, snapshot);
      } catch {
        // Callbacks must not crash the scorer
      }
    }
  }
}

// ─── ScoredRateProvider ───────────────────────────────────────────────────────

/**
 * Wraps any `RateProvider` to automatically record every call result into a
 * `ProviderHealthScorer`.
 *
 * This is the preferred integration point: wrap each of your upstream providers
 * with `ScoredRateProvider`, then pass them all to `FxProviderRouter`.
 */
export class ScoredRateProvider implements RateProvider {
  constructor(
    /** Unique, human-readable identifier used in metrics and logs. */
    public readonly providerId: string,
    private readonly inner: RateProvider,
    private readonly scorer: ProviderHealthScorer
  ) {}

  async getRate(from: string, to: string): Promise<ExchangeRate | null> {
    const start = Date.now();
    let rate: ExchangeRate | null = null;
    let success = false;

    try {
      rate    = await this.inner.getRate(from, to);
      success = rate !== null;
    } finally {
      const latencyMs  = Date.now() - start;
      const rateAgeMs  = rate ? Date.now() - rate.timestamp.getTime() : null;

      this.scorer.record(this.providerId, {
        success,
        latencyMs,
        rateAgeMs,
        timestamp: new Date(),
      });
    }

    return rate;
  }
}

// ─── FxProviderRouter ─────────────────────────────────────────────────────────

/**
 * Routes `getRate` calls across a prioritised list of `ScoredRateProvider`s.
 *
 * Strategy:
 *  1. Try each *healthy* provider in declaration order.
 *  2. If all healthy providers return `null`, try each *demoted* provider.
 *  3. Return the first non-null rate found, or `null` if all fail.
 *
 * This means demoted providers serve as a last-resort fallback so that the
 * engine degrades gracefully rather than hard-failing.
 *
 * Variance guard (quorum)
 * ───────────────────────
 * When a third `quorum` argument ({@link FxQuorumEvaluator}) is supplied, the
 * router switches into *quorum mode*: it gathers every provider's quote in
 * parallel and enforces the variance guard before returning. If the providers
 * diverge beyond the configured tolerance the run is blocked (a 503 is thrown)
 * and ops are paged with the divergent rates. This prevents silently trusting a
 * single misbehaving provider. When no `quorum` is supplied the legacy
 * first-healthy-wins behaviour is preserved for backwards compatibility.
 *
 * @example
 * ```typescript
 * const router = new FxProviderRouter(
 *   [
 *     new ScoredRateProvider('primary',   primaryProvider,   scorer),
 *     new ScoredRateProvider('secondary', secondaryProvider, scorer),
 *     new ScoredRateProvider('fix',       fixProvider,       scorer),
 *   ],
 *   scorer,
 *   new FxQuorumEvaluator(
 *     { k: 2, tolerance: 0.005 },
 *     { metrics, logger, pager: (f) => alerting.handle(f) },
 *   ),
 * );
 * ```
 */
export class FxProviderRouter implements RateProvider {
  constructor(
    private readonly providers: ScoredRateProvider[],
    private readonly scorer: ProviderHealthScorer,
    private readonly quorum?: FxQuorumEvaluator
  ) {
    if (providers.length === 0) {
      throw new Error('FxProviderRouter requires at least one provider.');
    }
    // Surface a misconfiguration up-front: quorum can never be reached if k > n.
    if (quorum && quorum.getConfig().k > providers.length) {
      throw new Error(
        `FxProviderRouter: quorum requires k=${quorum.getConfig().k} but only ` +
          `${providers.length} providers are configured. Reduce k or add providers.`
      );
    }
  }

  async getRate(from: string, to: string): Promise<ExchangeRate | null> {
    // When a quorum evaluator is configured, the rate-fetch pipeline gathers
    // every provider's quote and enforces the variance guard. A quorum failure
    // throws (blocking the run); agreement returns the aggregated consensus rate.
    if (this.quorum) {
      const pair = `${from}/${to}`;
      const inputs = await Promise.all(
        this.providers.map(async (p) => {
          try {
            return { providerId: p.providerId, rate: await p.getRate(from, to) };
          } catch {
            // A throwing provider counts as an unavailable/outage provider.
            return { providerId: p.providerId, rate: null as ExchangeRate | null };
          }
        })
      );
      return this.quorum.evaluate(pair, inputs);
    }

    // Phase 1 – try healthy providers first
    for (const p of this.providers) {
      if (!this.scorer.isHealthy(p.providerId)) continue;
      const rate = await p.getRate(from, to);
      if (rate !== null) return rate;
    }

    // Phase 2 – fall back to demoted providers
    for (const p of this.providers) {
      if (this.scorer.isHealthy(p.providerId)) continue;
      const rate = await p.getRate(from, to);
      if (rate !== null) return rate;
    }

    return null;
  }

  /**
   * Returns the list of providers currently in primary (healthy) rotation.
   */
  getHealthyProviders(): ScoredRateProvider[] {
    return this.providers.filter(p => this.scorer.isHealthy(p.providerId));
  }

  /**
   * Returns the list of providers currently demoted from primary rotation.
   */
  getDemotedProviders(): ScoredRateProvider[] {
    return this.providers.filter(p => !this.scorer.isHealthy(p.providerId));
  }
}
