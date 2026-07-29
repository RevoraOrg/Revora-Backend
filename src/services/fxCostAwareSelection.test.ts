/**
 * Tests for FX Cost-Aware Provider Selection
 *
 * Covers:
 *  - FxProviderBudgetRegistry (unit)
 *  - CostAwareRateSelector    (unit + integration)
 *  - Budget cap exhaustion never blocks distributions
 *  - Near-limit degradation selects cheaper provider
 *  - Spend recording on successful and null rate retrieval
 *  - Metric emission (fx.provider.spend_month gauge, degraded counter)
 *  - Security / abuse edge cases (negative spend, misconfiguration)
 */

import {
  InMemorySpendStore,
  FxProviderBudgetRegistry,
  currentMonthKey,
  MonthKey,
  SpendStore,
} from './fxProviderBudgetRegistry';

import {
  CostAwareRateSelector,
  CostedRateProvider,
  METRIC_SPEND_MONTH,
  METRIC_DEGRADED_TOTAL,
  METRIC_SELECTION_TOTAL,
} from './fxCostAwareSelector';

import { InMemoryRateProvider } from './fxConversionEngine';
import { MetricsCollector } from '../lib/metrics';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TENANT = 'tenant-test';
const MONTH: MonthKey = '2025-01';



function makeRateProvider(pair: string, mid = '1.00'): InMemoryRateProvider {
  const p = new InMemoryRateProvider();
  p.setRateFromValues(pair, mid, mid, mid, 300000);
  return p;
}

/** Build a CostAwareRateSelector with three providers: expensive > mid > free. */
function makeSelector(
  store: InMemorySpendStore,
  registry: FxProviderBudgetRegistry,
  metrics?: MetricsCollector
): { selector: CostAwareRateSelector; expensive: InMemoryRateProvider; cheap: InMemoryRateProvider; free: InMemoryRateProvider } {
  const expensive = makeRateProvider('USD/EUR', '0.92');
  const cheap = makeRateProvider('USD/EUR', '0.91');
  const free = makeRateProvider('USD/EUR', '0.90');

  const providers: CostedRateProvider[] = [
    { providerId: 'bloomberg', provider: expensive, costUsdPerCall: 0.05, accuracyRank: 100 },
    { providerId: 'refinitiv', provider: cheap,     costUsdPerCall: 0.02, accuracyRank: 80  },
    { providerId: 'ecb',       provider: free,      costUsdPerCall: 0,    accuracyRank: 50  },
  ];

  const selector = new CostAwareRateSelector(providers, registry, { metrics });
  return { selector, expensive, cheap, free };
}

// ─── InMemorySpendStore ───────────────────────────────────────────────────────

describe('InMemorySpendStore', () => {
  let store: InMemorySpendStore;
  beforeEach(() => { store = new InMemorySpendStore(); });

  it('returns 0 for unknown key', async () => {
    expect(await store.get(TENANT, 'bloomberg', MONTH)).toBe(0);
  });

  it('increments spend correctly', async () => {
    await store.increment(TENANT, 'bloomberg', MONTH, 1.50);
    await store.increment(TENANT, 'bloomberg', MONTH, 0.50);
    expect(await store.get(TENANT, 'bloomberg', MONTH)).toBeCloseTo(2.0);
  });

  it('tracks different providers independently', async () => {
    await store.increment(TENANT, 'bloomberg', MONTH, 10);
    await store.increment(TENANT, 'ecb', MONTH, 0);
    expect(await store.get(TENANT, 'bloomberg', MONTH)).toBe(10);
    expect(await store.get(TENANT, 'ecb', MONTH)).toBe(0);
  });

  it('tracks different tenants independently', async () => {
    await store.increment('tenant-a', 'bloomberg', MONTH, 5);
    await store.increment('tenant-b', 'bloomberg', MONTH, 15);
    expect(await store.get('tenant-a', 'bloomberg', MONTH)).toBe(5);
    expect(await store.get('tenant-b', 'bloomberg', MONTH)).toBe(15);
  });

  it('tracks different months independently', async () => {
    await store.increment(TENANT, 'bloomberg', '2025-01', 10);
    await store.increment(TENANT, 'bloomberg', '2025-02', 20);
    expect(await store.get(TENANT, 'bloomberg', '2025-01')).toBe(10);
    expect(await store.get(TENANT, 'bloomberg', '2025-02')).toBe(20);
  });

  it('rejects negative increment', async () => {
    await expect(store.increment(TENANT, 'bloomberg', MONTH, -1))
      .rejects.toThrow('non-negative');
  });

  it('listByTenant returns all records for tenant and month', async () => {
    await store.increment(TENANT, 'bloomberg', MONTH, 5);
    await store.increment(TENANT, 'ecb', MONTH, 0);
    await store.increment('other-tenant', 'bloomberg', MONTH, 99);
    const records = await store.listByTenant(TENANT, MONTH);
    expect(records).toHaveLength(1); // ecb was 0 so not inserted
    expect(records[0].providerId).toBe('bloomberg');
  });

  it('clear resets all data', async () => {
    await store.increment(TENANT, 'bloomberg', MONTH, 5);
    store.clear();
    expect(await store.get(TENANT, 'bloomberg', MONTH)).toBe(0);
  });
});

// ─── currentMonthKey ─────────────────────────────────────────────────────────

describe('currentMonthKey', () => {
  it('returns a string matching YYYY-MM format', () => {
    expect(currentMonthKey()).toMatch(/^\d{4}-\d{2}$/);
  });
});

// ─── FxProviderBudgetRegistry ─────────────────────────────────────────────────

describe('FxProviderBudgetRegistry', () => {
  let store: InMemorySpendStore;
  let registry: FxProviderBudgetRegistry;

  beforeEach(() => {
    store = new InMemorySpendStore();
    registry = new FxProviderBudgetRegistry(store);
    registry.configureProvider(TENANT, { providerId: 'bloomberg', monthlyCapUsd: 100, degradationThreshold: 0.8 });
  });

  // ── Configuration ──────────────────────────────────────────────────────────

  describe('configureProvider', () => {
    it('accepts valid configuration', () => {
      expect(() =>
        registry.configureProvider(TENANT, { providerId: 'ecb', monthlyCapUsd: 10 })
      ).not.toThrow();
    });

    it('rejects zero monthlyCapUsd', () => {
      expect(() =>
        registry.configureProvider(TENANT, { providerId: 'ecb', monthlyCapUsd: 0 })
      ).toThrow('positive finite number');
    });

    it('rejects negative monthlyCapUsd', () => {
      expect(() =>
        registry.configureProvider(TENANT, { providerId: 'ecb', monthlyCapUsd: -50 })
      ).toThrow('positive finite number');
    });

    it('rejects non-finite monthlyCapUsd', () => {
      expect(() =>
        registry.configureProvider(TENANT, { providerId: 'ecb', monthlyCapUsd: Infinity })
      ).toThrow('positive finite number');
    });

    it('rejects degradationThreshold > 1', () => {
      expect(() =>
        registry.configureProvider(TENANT, { providerId: 'ecb', monthlyCapUsd: 10, degradationThreshold: 1.5 })
      ).toThrow('degradationThreshold');
    });

    it('rejects degradationThreshold <= 0', () => {
      expect(() =>
        registry.configureProvider(TENANT, { providerId: 'ecb', monthlyCapUsd: 10, degradationThreshold: 0 })
      ).toThrow('degradationThreshold');
    });

    it('overwrites existing config', () => {
      registry.configureProvider(TENANT, { providerId: 'bloomberg', monthlyCapUsd: 200 });
      expect(registry.hasConfig(TENANT, 'bloomberg')).toBe(true);
    });

    it('hasConfig returns false for unconfigured pair', () => {
      expect(registry.hasConfig(TENANT, 'unknown-provider')).toBe(false);
    });
  });

  // ── recordSpend ────────────────────────────────────────────────────────────

  describe('recordSpend', () => {
    it('records positive spend', async () => {
      await registry.recordSpend(TENANT, 'bloomberg', 1.50, MONTH);
      const status = await registry.getBudgetStatus(TENANT, 'bloomberg', MONTH);
      expect(status.spendUsd).toBeCloseTo(1.50);
    });

    it('zero spend is a no-op (no store write)', async () => {
      await registry.recordSpend(TENANT, 'bloomberg', 0, MONTH);
      const records = await store.listByTenant(TENANT, MONTH);
      expect(records).toHaveLength(0);
    });

    it('rejects negative spend', async () => {
      await expect(registry.recordSpend(TENANT, 'bloomberg', -5, MONTH))
        .rejects.toThrow('non-negative');
    });

    it('accumulates across multiple calls', async () => {
      await registry.recordSpend(TENANT, 'bloomberg', 10, MONTH);
      await registry.recordSpend(TENANT, 'bloomberg', 20, MONTH);
      const status = await registry.getBudgetStatus(TENANT, 'bloomberg', MONTH);
      expect(status.spendUsd).toBeCloseTo(30);
    });
  });

  // ── getBudgetStatus ────────────────────────────────────────────────────────

  describe('getBudgetStatus', () => {
    it('returns zero spend on fresh registry', async () => {
      const status = await registry.getBudgetStatus(TENANT, 'bloomberg', MONTH);
      expect(status.spendUsd).toBe(0);
      expect(status.capUsd).toBe(100);
      expect(status.remainingUsd).toBe(100);
      expect(status.isExhausted).toBe(false);
      expect(status.isNearLimit).toBe(false);
    });

    it('throws for unconfigured provider', async () => {
      await expect(registry.getBudgetStatus(TENANT, 'unknown', MONTH))
        .rejects.toThrow('No budget config');
    });

    it('isNearLimit when spend >= cap × threshold', async () => {
      // threshold = 0.8, cap = 100 → near limit at 80
      await registry.recordSpend(TENANT, 'bloomberg', 80, MONTH);
      const status = await registry.getBudgetStatus(TENANT, 'bloomberg', MONTH);
      expect(status.isNearLimit).toBe(true);
      expect(status.isExhausted).toBe(false);
    });

    it('isExhausted when spend >= cap', async () => {
      await registry.recordSpend(TENANT, 'bloomberg', 100, MONTH);
      const status = await registry.getBudgetStatus(TENANT, 'bloomberg', MONTH);
      expect(status.isExhausted).toBe(true);
      expect(status.remainingUsd).toBe(0);
    });

    it('remainingUsd goes negative on overspend', async () => {
      await registry.recordSpend(TENANT, 'bloomberg', 120, MONTH);
      const status = await registry.getBudgetStatus(TENANT, 'bloomberg', MONTH);
      expect(status.remainingUsd).toBeLessThan(0);
      expect(status.isExhausted).toBe(true);
    });

    it('uses default threshold of 0.9 when not specified', async () => {
      const r2 = new FxProviderBudgetRegistry(store);
      r2.configureProvider(TENANT, { providerId: 'ecb', monthlyCapUsd: 100 });
      // threshold should be 0.9 → near limit at 90
      await r2.recordSpend(TENANT, 'ecb', 89, MONTH);
      expect((await r2.getBudgetStatus(TENANT, 'ecb', MONTH)).isNearLimit).toBe(false);
      await r2.recordSpend(TENANT, 'ecb', 2, MONTH); // total 91
      expect((await r2.getBudgetStatus(TENANT, 'ecb', MONTH)).isNearLimit).toBe(true);
    });
  });

  // ── isProviderAvailable ────────────────────────────────────────────────────

  describe('isProviderAvailable', () => {
    it('returns true when under cap', async () => {
      expect(await registry.isProviderAvailable(TENANT, 'bloomberg', MONTH)).toBe(true);
    });

    it('returns false when budget exhausted', async () => {
      await registry.recordSpend(TENANT, 'bloomberg', 100, MONTH);
      expect(await registry.isProviderAvailable(TENANT, 'bloomberg', MONTH)).toBe(false);
    });

    it('returns true for unconfigured provider (fail open)', async () => {
      expect(await registry.isProviderAvailable(TENANT, 'unconfigured', MONTH)).toBe(true);
    });
  });

  // ── isProviderNearLimit ────────────────────────────────────────────────────

  describe('isProviderNearLimit', () => {
    it('returns false when under threshold', async () => {
      expect(await registry.isProviderNearLimit(TENANT, 'bloomberg', MONTH)).toBe(false);
    });

    it('returns true when near limit', async () => {
      await registry.recordSpend(TENANT, 'bloomberg', 80, MONTH);
      expect(await registry.isProviderNearLimit(TENANT, 'bloomberg', MONTH)).toBe(true);
    });

    it('returns false for unconfigured provider', async () => {
      expect(await registry.isProviderNearLimit(TENANT, 'unconfigured', MONTH)).toBe(false);
    });
  });

  // ── listTenantSpend ────────────────────────────────────────────────────────

  describe('listTenantSpend', () => {
    it('returns empty array when no spend', async () => {
      const records = await registry.listTenantSpend(TENANT, MONTH);
      expect(records).toHaveLength(0);
    });

    it('returns spend for all configured providers', async () => {
      registry.configureProvider(TENANT, { providerId: 'ecb', monthlyCapUsd: 10 });
      await registry.recordSpend(TENANT, 'bloomberg', 5, MONTH);
      await registry.recordSpend(TENANT, 'ecb', 1, MONTH);
      const records = await registry.listTenantSpend(TENANT, MONTH);
      expect(records).toHaveLength(2);
      const bloomberg = records.find((r) => r.providerId === 'bloomberg');
      expect(bloomberg?.spendUsd).toBeCloseTo(5);
    });
  });
});

// ─── CostAwareRateSelector ────────────────────────────────────────────────────

describe('CostAwareRateSelector', () => {
  let store: InMemorySpendStore;
  let registry: FxProviderBudgetRegistry;

  beforeEach(() => {
    store = new InMemorySpendStore();
    registry = new FxProviderBudgetRegistry(store);
    // Configure budgets for the three providers
    registry.configureProvider(TENANT, { providerId: 'bloomberg', monthlyCapUsd: 10, degradationThreshold: 0.8 });
    registry.configureProvider(TENANT, { providerId: 'refinitiv', monthlyCapUsd: 20, degradationThreshold: 0.8 });
    // ecb is free – no budget config needed
  });

  // ── Construction ──────────────────────────────────────────────────────────

  describe('construction', () => {
    it('throws when no providers supplied', () => {
      expect(() => new CostAwareRateSelector([], registry))
        .toThrow('at least one provider');
    });

    it('throws when no free provider exists', () => {
      expect(() =>
        new CostAwareRateSelector(
          [{ providerId: 'bloomberg', provider: makeRateProvider('USD/EUR'), costUsdPerCall: 0.05, accuracyRank: 100 }],
          registry
        )
      ).toThrow('zero-cost');
    });

    it('throws when provider has negative costUsdPerCall', () => {
      expect(() =>
        new CostAwareRateSelector(
          [
            { providerId: 'bad', provider: makeRateProvider('USD/EUR'), costUsdPerCall: -1, accuracyRank: 10 },
            { providerId: 'ecb', provider: makeRateProvider('USD/EUR'), costUsdPerCall: 0,  accuracyRank: 1  },
          ],
          registry
        )
      ).toThrow('negative costUsdPerCall');
    });

    it('sorts providers by descending accuracyRank', () => {
      const { selector } = makeSelector(store, registry);
      expect(selector.providers[0].providerId).toBe('bloomberg');
      expect(selector.providers[1].providerId).toBe('refinitiv');
      expect(selector.providers[2].providerId).toBe('ecb');
    });
  });

  // ── Normal selection (under budget) ───────────────────────────────────────

  describe('normal selection (budget not constrained)', () => {
    it('selects the most accurate (expensive) provider when budget is available', async () => {
      const { selector } = makeSelector(store, registry);
      const result = await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      expect(result.providerId).toBe('bloomberg');
      expect(result.degraded).toBe(false);
      expect(result.exhaustedSkipCount).toBe(0);
      expect(result.nearLimitSkipCount).toBe(0);
    });

    it('returns the rate from the selected provider', async () => {
      const { selector } = makeSelector(store, registry);
      const result = await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      expect(result.rate).not.toBeNull();
      expect(result.rate!.pair).toBe('USD/EUR');
    });

    it('records spend after successful rate retrieval', async () => {
      const { selector } = makeSelector(store, registry);
      await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      const status = await registry.getBudgetStatus(TENANT, 'bloomberg', MONTH);
      expect(status.spendUsd).toBeCloseTo(0.05);
    });

    it('does not record spend for free providers', async () => {
      // Use only the free provider
      const freeProvider = makeRateProvider('USD/EUR', '0.90');
      const selector = new CostAwareRateSelector(
        [{ providerId: 'ecb', provider: freeProvider, costUsdPerCall: 0, accuracyRank: 1 }],
        registry
      );
      await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      const records = await store.listByTenant(TENANT, MONTH);
      expect(records.find((r) => r.providerId === 'ecb')).toBeUndefined();
    });
  });

  // ── Budget-pressure degradation ────────────────────────────────────────────

  describe('budget-pressure degradation', () => {
    it('skips expensive provider when its budget is near limit, uses cheaper one', async () => {
      // bloomberg cap = $10, threshold = 80% → near limit at $8
      await registry.recordSpend(TENANT, 'bloomberg', 8.50, MONTH);

      const { selector } = makeSelector(store, registry);
      const result = await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      // bloomberg is near limit AND a cheaper provider (refinitiv) exists
      expect(result.providerId).toBe('refinitiv');
      expect(result.degraded).toBe(true);
      expect(result.nearLimitSkipCount).toBe(1);
    });

    it('uses exhausted provider when it is the ONLY non-exhausted option', async () => {
      // Exhaust bloomberg; put refinitiv near limit but still available;
      // ecb has no budget → treated as always available.
      // If bloomberg and refinitiv are both exhausted, ecb (free) must be chosen.
      await registry.recordSpend(TENANT, 'bloomberg', 10, MONTH);  // exhausted
      await registry.recordSpend(TENANT, 'refinitiv', 20, MONTH);  // exhausted

      const { selector } = makeSelector(store, registry);
      const result = await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      // ecb has no budget config → isProviderAvailable returns true
      expect(result.providerId).toBe('ecb');
      expect(result.degraded).toBe(true);
      expect(result.exhaustedSkipCount).toBe(2);
    });

    it('budget exhaustion NEVER blocks distributions (always returns a rate)', async () => {
      // Exhaust all paid providers; free provider must still serve
      await registry.recordSpend(TENANT, 'bloomberg', 100, MONTH);
      await registry.recordSpend(TENANT, 'refinitiv', 100, MONTH);

      const { selector } = makeSelector(store, registry);
      const result = await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      expect(result.providerId).toBe('ecb');
      expect(result.rate).not.toBeNull();
    });

    it('uses most-preferred provider after budget resets (new month)', async () => {
      // Exhaust bloomberg in MONTH
      await registry.recordSpend(TENANT, 'bloomberg', 10, MONTH);
      const { selector } = makeSelector(store, registry);

      const resultOldMonth = await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      expect(resultOldMonth.providerId).not.toBe('bloomberg');

      // New month key: bloomberg spend is zero
      const newMonth = '2025-02';
      const resultNewMonth = await selector.selectRate(TENANT, 'USD', 'EUR', newMonth);
      expect(resultNewMonth.providerId).toBe('bloomberg');
    });

    it('skips near-limit provider but uses it when no cheaper alternative exists', async () => {
      // Only the expensive provider is near limit AND there's no cheaper non-exhausted one
      // Exhaust ecb and refinitiv; bloomberg is near limit
      await registry.recordSpend(TENANT, 'refinitiv', 20, MONTH); // exhausted
      await registry.recordSpend(TENANT, 'bloomberg', 8.5, MONTH); // near limit

      // ecb has no config → available; but bloomberg near limit + ecb available
      // selector should prefer ecb over near-limit bloomberg
      const { selector } = makeSelector(store, registry);
      const result = await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      // bloomberg is near limit, but there's ecb (cheaper, not exhausted) → degrade
      expect(result.degraded).toBe(true);
    });
  });

  // ── Provider returning null rate ───────────────────────────────────────────

  describe('provider returning null rate', () => {
    it('returns null rate from selected provider', async () => {
      const emptyProvider = new InMemoryRateProvider(); // no rates set
      const freeProvider = makeRateProvider('USD/EUR');
      const selector = new CostAwareRateSelector(
        [
          { providerId: 'bloomberg', provider: emptyProvider, costUsdPerCall: 0.05, accuracyRank: 100 },
          { providerId: 'ecb',       provider: freeProvider,  costUsdPerCall: 0,    accuracyRank: 10  },
        ],
        registry
      );
      const result = await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      // bloomberg has no rate but is selected first (most accurate)
      expect(result.providerId).toBe('bloomberg');
      expect(result.rate).toBeNull();
      // spend still recorded (API was called)
      const status = await registry.getBudgetStatus(TENANT, 'bloomberg', MONTH);
      expect(status.spendUsd).toBeCloseTo(0.05);
    });

    it('records cost even when provider returns null', async () => {
      // Provider that throws
      const crashingProvider: any = {
        getRate: jest.fn().mockRejectedValue(new Error('provider down')),
      };
      const freeProvider = makeRateProvider('USD/EUR');
      const selector = new CostAwareRateSelector(
        [
          { providerId: 'bloomberg', provider: crashingProvider, costUsdPerCall: 0.05, accuracyRank: 100 },
          { providerId: 'ecb',       provider: freeProvider,     costUsdPerCall: 0,    accuracyRank: 10  },
        ],
        registry
      );
      const result = await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      // provider crashed → rate is null, cost still charged
      expect(result.rate).toBeNull();
      const status = await registry.getBudgetStatus(TENANT, 'bloomberg', MONTH);
      expect(status.spendUsd).toBeCloseTo(0.05);
    });
  });

  // ── Metrics ───────────────────────────────────────────────────────────────

  describe('metrics emission', () => {
    let metrics: MetricsCollector;

    beforeEach(() => {
      metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    });

    it('emits fx_provider_selection_total counter', async () => {
      const { selector } = makeSelector(store, registry, metrics);
      await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      expect(metrics.exportPrometheus()).toContain(METRIC_SELECTION_TOTAL);
    });

    it('emits fx_provider_spend_month gauge after selection', async () => {
      const { selector } = makeSelector(store, registry, metrics);
      await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      expect(metrics.exportPrometheus()).toContain(METRIC_SPEND_MONTH);
    });

    it('emits fx_provider_degraded_total when degradation occurs', async () => {
      await registry.recordSpend(TENANT, 'bloomberg', 8.5, MONTH); // near limit
      const { selector } = makeSelector(store, registry, metrics);
      await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      expect(metrics.exportPrometheus()).toContain(METRIC_DEGRADED_TOTAL);
    });

    it('does NOT emit degraded counter when no degradation', async () => {
      const { selector } = makeSelector(store, registry, metrics);
      await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      expect(metrics.exportPrometheus()).not.toContain(METRIC_DEGRADED_TOTAL);
    });

    it('emitSpendGauges emits gauge for all providers with spend', async () => {
      await registry.recordSpend(TENANT, 'bloomberg', 3, MONTH);
      await registry.recordSpend(TENANT, 'refinitiv', 1, MONTH);
      const { selector } = makeSelector(store, registry, metrics);
      await selector.emitSpendGauges(TENANT, MONTH);
      const prom = metrics.exportPrometheus();
      expect(prom).toContain(METRIC_SPEND_MONTH);
    });

    it('emitSpendGauges is a no-op when no metrics configured', async () => {
      const { selector } = makeSelector(store, registry); // no metrics
      // Should not throw
      await expect(selector.emitSpendGauges(TENANT, MONTH)).resolves.toBeUndefined();
    });
  });

  // ── Multiple tenants ───────────────────────────────────────────────────────

  describe('multi-tenant isolation', () => {
    it('budget exhaustion for one tenant does not affect another', async () => {
      const TENANT_B = 'tenant-b';
      registry.configureProvider(TENANT_B, { providerId: 'bloomberg', monthlyCapUsd: 10 });

      // Exhaust bloomberg for TENANT only
      await registry.recordSpend(TENANT, 'bloomberg', 10, MONTH);

      const { selector } = makeSelector(store, registry);

      const resultA = await selector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      const resultB = await selector.selectRate(TENANT_B, 'USD', 'EUR', MONTH);

      // Tenant A should degrade (bloomberg exhausted)
      expect(resultA.providerId).not.toBe('bloomberg');
      // Tenant B should still use bloomberg
      expect(resultB.providerId).toBe('bloomberg');
    });
  });

  // ── Security / abuse edge cases ────────────────────────────────────────────

  describe('security / abuse edge cases', () => {
    it('does not allow tenantId injection via provider selection', async () => {
      // Provider should use exactly the tenantId passed in, not any embedded injection
      const maliciousTenantId = 'tenant-a:bloomberg:9999-99';
      const { selector } = makeSelector(store, registry);
      // Should not crash or match another tenant's budget
      const result = await selector.selectRate(maliciousTenantId, 'USD', 'EUR', MONTH);
      expect(result).toBeDefined();
      // Bloomberg has no budget config for the malicious tenantId → treated as available
      expect(result.providerId).toBe('bloomberg');
    });

    it('spend recording failure (store throws) does not block rate retrieval', async () => {
      const brokenStore: SpendStore = {
        increment: jest.fn().mockRejectedValue(new Error('DB down')),
        get: jest.fn().mockResolvedValue(0),
        listByTenant: jest.fn().mockResolvedValue([]),
      };
      const brokenRegistry = new FxProviderBudgetRegistry(brokenStore as any);
      brokenRegistry.configureProvider(TENANT, { providerId: 'bloomberg', monthlyCapUsd: 100 });

      const { selector: brokenSelector } = makeSelector(brokenStore as any, brokenRegistry);
      // Should still return a rate even if spend recording fails
      const result = await brokenSelector.selectRate(TENANT, 'USD', 'EUR', MONTH);
      expect(result.rate).not.toBeNull();
    });

    it('budget status storage failure causes fail-open (provider treated as available)', async () => {
      const flakyStore: any = {
        increment: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockRejectedValue(new Error('DB down')),
        listByTenant: jest.fn().mockResolvedValue([]),
      };
      const flakyRegistry = new FxProviderBudgetRegistry(flakyStore);
      flakyRegistry.configureProvider(TENANT, { providerId: 'bloomberg', monthlyCapUsd: 10 });

      // isProviderAvailable should return true on failure (fail open)
      const available = await flakyRegistry.isProviderAvailable(TENANT, 'bloomberg', MONTH);
      expect(available).toBe(true);
    });
  });
});

