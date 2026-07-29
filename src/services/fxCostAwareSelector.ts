/**
 * Cost-Aware FX Rate Provider Selector
 *
 * Wraps a ranked list of `RateProvider` instances – each annotated with its
 * per-call cost in USD – and selects the most accurate provider that is still
 * within the tenant's monthly budget.  When the preferred provider's budget is
 * exhausted or near its limit, the selector automatically degrades to a
 * cheaper alternative.
 *
 * Key design invariants
 * ---------------------
 * 1. **Distributions are never blocked.** The selector MUST always include at
 *    least one provider with `costUsdPerCall: 0` (e.g. ECB, open-exchange-free).
 *    `CostAwareRateSelector` enforces this at construction time.
 * 2. **Cheapest first under budget pressure.** When a provider is near its
 *    monthly budget limit, the selector skips it and tries the next cheaper
 *    provider.  Exhausted providers are always skipped.
 * 3. **Best quality first under normal conditions.** Providers are ordered by
 *    descending accuracy/cost so the most accurate (expensive) provider is
 *    tried first when budget allows.
 * 4. **Spend is recorded only on successful rate retrieval.** A provider call
 *    that returns `null` (no rate available) is still charged its cost because
 *    the API was invoked.
 * 5. **Metrics are emitted** after every selection round so dashboards can
 *    track `fx.provider.spend_month` and `fx.provider.degraded_total`.
 *
 * Security Assumptions
 * --------------------
 * - `tenantId` is authenticated upstream; the selector inherits that trust.
 * - Cost values are defined in code by operators, not derived from external
 *   inputs, to prevent cost-manipulation attacks.
 * - The `FxProviderBudgetRegistry` is the authoritative source for spend data;
 *   the selector does not maintain its own spend counters.
 * - Metric labels never include tenant IDs (PII) – only `providerId` and
 *   `pair` are used as label dimensions.
 *
 * @module services/fxCostAwareSelector
 */

import { RateProvider, ExchangeRate } from './fxConversionEngine';
import {
  FxProviderBudgetRegistry,
  MonthKey,
  currentMonthKey,
} from './fxProviderBudgetRegistry';
import { MetricsCollector } from '../lib/metrics';

// ─── Metric names ─────────────────────────────────────────────────────────────

/** Gauge: accumulated spend in USD for a provider in the current month. */
export const METRIC_SPEND_MONTH = 'fx_provider_spend_month';

/** Counter: total number of times a cheaper provider was used due to budget pressure. */
export const METRIC_DEGRADED_TOTAL = 'fx_provider_degraded_total';

/** Counter: total provider selection attempts. */
export const METRIC_SELECTION_TOTAL = 'fx_provider_selection_total';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A `RateProvider` decorated with cost and quality metadata.
 */
export interface CostedRateProvider {
  /**
   * Unique, stable identifier for this provider (e.g. `"bloomberg"`, `"ecb"`).
   * Must match the `providerId` used in `FxProviderBudgetRegistry.configureProvider`.
   */
  providerId: string;

  /** The underlying rate provider implementation. */
  provider: RateProvider;

  /**
   * Cost per API call in USD.  Must be ≥ 0.
   * Set to `0` for free-tier providers.
   */
  costUsdPerCall: number;

  /**
   * Relative accuracy rank (higher = more accurate / preferred).
   * Providers are tried in descending order of this value under normal budget.
   * Under budget pressure the selector falls back to lower-ranked providers.
   *
   * @default 0
   */
  accuracyRank?: number;
}

/**
 * Result of a provider-selection round, enriched with cost accounting metadata.
 */
export interface CostAwareRateResult {
  /** The exchange rate returned by the selected provider, or null if none. */
  rate: ExchangeRate | null;
  /** The provider that was ultimately used. */
  providerId: string;
  /** Whether the selector had to degrade (skip a preferred provider). */
  degraded: boolean;
  /** Number of providers that were skipped due to budget exhaustion. */
  exhaustedSkipCount: number;
  /** Number of providers that were skipped due to near-limit degradation. */
  nearLimitSkipCount: number;
}

// ─── Selector ─────────────────────────────────────────────────────────────────

/**
 * CostAwareRateSelector
 *
 * Selects the best available FX rate provider for a given tenant, respecting
 * per-provider monthly budget caps and automatically degrading to cheaper
 * providers when limits are approached or exceeded.
 *
 * Example:
 * ```typescript
 * const selector = new CostAwareRateSelector(
 *   [
 *     { providerId: 'bloomberg', provider: bloombergProvider, costUsdPerCall: 0.05, accuracyRank: 100 },
 *     { providerId: 'refinitiv', provider: refinitivProvider, costUsdPerCall: 0.02, accuracyRank: 80  },
 *     { providerId: 'ecb',       provider: ecbProvider,       costUsdPerCall: 0,    accuracyRank: 50  },
 *   ],
 *   registry,
 *   { metrics }
 * );
 *
 * const { rate, providerId, degraded } = await selector.selectRate(
 *   'tenant-abc', 'USD', 'EUR'
 * );
 * ```
 */
export class CostAwareRateSelector {
  /** Providers sorted by descending accuracyRank (most preferred first). */
  private readonly ranked: CostedRateProvider[];

  constructor(
    providers: CostedRateProvider[],
    private readonly registry: FxProviderBudgetRegistry,
    private readonly options?: {
      metrics?: MetricsCollector;
    }
  ) {
    if (providers.length === 0) {
      throw new Error('CostAwareRateSelector requires at least one provider');
    }
    // Guard: at least one free (zero-cost) provider must exist so distributions
    // are never blocked by budget exhaustion.
    const hasFreeProvider = providers.some((p) => p.costUsdPerCall === 0);
    if (!hasFreeProvider) {
      throw new Error(
        'CostAwareRateSelector requires at least one provider with costUsdPerCall === 0 ' +
        'to guarantee distributions are never blocked by budget exhaustion.'
      );
    }
    // Validate costs
    for (const p of providers) {
      if (p.costUsdPerCall < 0) {
        throw new RangeError(
          `Provider "${p.providerId}" has negative costUsdPerCall (${p.costUsdPerCall})`
        );
      }
    }
    // Sort descending by accuracyRank (highest = most preferred)
    this.ranked = [...providers].sort(
      (a, b) => (b.accuracyRank ?? 0) - (a.accuracyRank ?? 0)
    );
  }

  /**
   * Select a rate provider for the given tenant and currency pair, respecting
   * budget constraints.
   *
   * Selection algorithm:
   * 1. Iterate providers from most-accurate to least-accurate.
   * 2. Skip any provider whose budget is **exhausted** for this tenant.
   * 3. Skip any provider whose budget is **near the limit** (≥ degradationThreshold)
   *    *if* a cheaper/lower-ranked provider is still available.
   * 4. Call `getRate` on the first eligible provider.
   * 5. Record the call cost in the budget registry.
   * 6. Emit metrics.
   *
   * The function never throws due to budget constraints – it always returns the
   * result from the cheapest available provider as a last resort.
   *
   * @param tenantId  Authenticated tenant identifier.
   * @param from      Source currency ISO-4217 code.
   * @param to        Destination currency ISO-4217 code.
   * @param monthKey  Optional month override (for testing).
   */
  async selectRate(
    tenantId: string,
    from: string,
    to: string,
    monthKey?: MonthKey
  ): Promise<CostAwareRateResult> {
    const month = monthKey ?? currentMonthKey();
    const metrics = this.options?.metrics;

    let exhaustedSkipCount = 0;
    let nearLimitSkipCount = 0;
    let firstEligibleIndex = -1;

    // ── Pass 1: determine the first eligible provider ────────────────────────
    // We collect budget statuses up-front so we can decide whether "near limit"
    // skipping is safe (i.e. there is still a cheaper provider available).

    const statuses = await Promise.all(
      this.ranked.map(async (p) => ({
        costed: p,
        exhausted: await this.registry.isProviderAvailable(tenantId, p.providerId, month).then((a) => !a),
        nearLimit: await this.registry.isProviderNearLimit(tenantId, p.providerId, month),
      }))
    );

    // Find the last non-exhausted provider index (the "last resort")
    const lastNonExhaustedIndex = statuses.reduce(
      (last, s, i) => (!s.exhausted ? i : last),
      -1
    );

    if (lastNonExhaustedIndex === -1) {
      // All providers exhausted – this should be impossible given the free-provider
      // invariant, but we defend against it defensively.
      // Fall through to the cheapest provider regardless.
      firstEligibleIndex = this.ranked.length - 1;
    } else {
      for (let i = 0; i < statuses.length; i++) {
        const { exhausted, nearLimit } = statuses[i];

        if (exhausted) {
          exhaustedSkipCount++;
          continue;
        }

        // Skip near-limit providers only when a cheaper alternative still exists
        // below this index that is not exhausted.
        if (nearLimit && lastNonExhaustedIndex > i) {
          nearLimitSkipCount++;
          continue;
        }

        firstEligibleIndex = i;
        break;
      }

      // If somehow all providers were skipped (shouldn't happen), use last resort.
      if (firstEligibleIndex === -1) {
        firstEligibleIndex = lastNonExhaustedIndex;
      }
    }

    const selected = this.ranked[firstEligibleIndex];
    const degraded = exhaustedSkipCount > 0 || nearLimitSkipCount > 0;

    // ── Call the selected provider ────────────────────────────────────────────
    let rate: ExchangeRate | null = null;
    try {
      rate = await selected.provider.getRate(from, to);
    } catch {
      // Provider error – treat as null rate; caller will handle missing rate.
      rate = null;
    }

    // ── Record spend regardless of rate availability ──────────────────────────
    // The API was invoked, so the cost is incurred even on a cache miss.
    if (selected.costUsdPerCall > 0) {
      try {
        await this.registry.recordSpend(
          tenantId,
          selected.providerId,
          selected.costUsdPerCall,
          month
        );
      } catch {
        // Defensive: spend recording failure must never block rate retrieval.
      }
    }

    // ── Emit metrics ──────────────────────────────────────────────────────────
    if (metrics) {
      // Emit spend gauge for each provider (all tenants share the same metric
      // name; the providerId label disambiguates).  We emit for the selected
      // provider only to keep cardinality low.
      try {
        const spendUsd = await this.registry
          .listTenantSpend(tenantId, month)
          .then((records) => {
            const rec = records.find((r) => r.providerId === selected.providerId);
            return rec?.spendUsd ?? 0;
          });
        metrics.setGauge(
          METRIC_SPEND_MONTH,
          spendUsd,
          { provider_id: selected.providerId }
        );
      } catch {
        // Metric emission failure must never block operations.
      }

      metrics.incrementCounter(METRIC_SELECTION_TOTAL, {
        provider_id: selected.providerId,
      });

      if (degraded) {
        metrics.incrementCounter(METRIC_DEGRADED_TOTAL, {
          provider_id: selected.providerId,
        });
      }
    }

    return {
      rate,
      providerId: selected.providerId,
      degraded,
      exhaustedSkipCount,
      nearLimitSkipCount,
    };
  }

  /**
   * Emit the `fx.provider.spend_month` gauge for ALL configured providers
   * for a given tenant.  Call this on a regular schedule (e.g. every minute)
   * to keep the metric fresh even during low-traffic periods.
   *
   * @param tenantId  Tenant to report on.
   * @param monthKey  Optional month override.
   */
  async emitSpendGauges(tenantId: string, monthKey?: MonthKey): Promise<void> {
    const metrics = this.options?.metrics;
    if (!metrics) return;

    const month = monthKey ?? currentMonthKey();
    const records = await this.registry.listTenantSpend(tenantId, month);

    for (const record of records) {
      metrics.setGauge(
        METRIC_SPEND_MONTH,
        record.spendUsd,
        { provider_id: record.providerId }
      );
    }
  }

  /**
   * Expose the ordered provider list for inspection / testing.
   */
  get providers(): ReadonlyArray<CostedRateProvider> {
    return this.ranked;
  }
}
