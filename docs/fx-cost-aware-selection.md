# FX Cost-Aware Provider Selection

## Overview

Some FX rate providers (e.g. Bloomberg, Refinitiv) are more accurate but charge
per API call.  This feature adds **cost-aware provider selection** that:

- Tracks per-provider API spend on a per-tenant, per-calendar-month basis.
- Automatically degrades to cheaper alternatives when a provider's monthly
  budget cap is approached or exceeded.
- Emits the `fx.provider.spend_month` gauge so dashboards can track live spend
  against caps.
- **Never blocks distributions** — a zero-cost fallback provider is mandatory.

---

## Architecture

```
FxConversionEngine
      │
      │  getRate(from, to)
      ▼
CostAwareRateSelector          ← selects the best affordable provider
      │
      ├── CostedRateProvider[]  ← sorted by accuracy (descending)
      │     ├── bloomberg  ($0.05/call, rank 100)
      │     ├── refinitiv  ($0.02/call, rank 80)
      │     └── ecb        ($0.00/call, rank 50) ← mandatory free tier
      │
      └── FxProviderBudgetRegistry
                │
                └── SpendStore  (InMemorySpendStore or Postgres-backed)
```

### Key files

| File | Purpose |
|---|---|
| `src/services/fxProviderBudgetRegistry.ts` | Per-tenant monthly spend tracking and budget cap enforcement |
| `src/services/fxCostAwareSelector.ts` | Provider selection logic with degradation and metric emission |
| `src/services/fxCostAwareSelection.test.ts` | Comprehensive test suite (≥95% coverage) |

---

## Provider Selection Algorithm

1. Sort all providers by `accuracyRank` descending (most-accurate first).
2. For each provider (most-accurate → least-accurate):
   - **Skip** if budget is **exhausted** (`spend ≥ cap`).
   - **Skip** if budget is **near the limit** (`spend ≥ cap × degradationThreshold`)
     *and* a cheaper non-exhausted provider exists below.
   - Otherwise **select** this provider.
3. Call `getRate(from, to)` on the selected provider.
4. Record the call cost in `FxProviderBudgetRegistry`.
5. Emit Prometheus metrics.

> **Invariant:** If all paid providers are exhausted, the free (`costUsdPerCall: 0`)
> provider is always used.  The selector constructor enforces the presence of at
> least one free provider at startup.

---

## Emitted Metrics

| Metric | Type | Description |
|---|---|---|
| `fx.provider.spend_month` | Gauge | Accumulated spend in USD for a provider in the current month. Labels: `provider_id`. |
| `fx.provider.degraded_total` | Counter | Times a cheaper provider was used due to budget pressure. Labels: `provider_id`. |
| `fx.provider.selection_total` | Counter | Total provider selection attempts. Labels: `provider_id`. |

---

## Configuration

### 1. Configure provider budgets per tenant

```typescript
import { FxProviderBudgetRegistry, InMemorySpendStore } from './services/fxProviderBudgetRegistry';

const store = new InMemorySpendStore(); // replace with Postgres in production
const registry = new FxProviderBudgetRegistry(store);

// Set a $500/month cap for the bloomberg provider for tenant "acme"
registry.configureProvider('acme', {
  providerId: 'bloomberg',
  monthlyCapUsd: 500,
  degradationThreshold: 0.9, // degrade when 90% of cap is used
});

registry.configureProvider('acme', {
  providerId: 'refinitiv',
  monthlyCapUsd: 200,
  degradationThreshold: 0.85,
});
// ecb (free) needs no budget config
```

### 2. Create the selector

```typescript
import { CostAwareRateSelector } from './services/fxCostAwareSelector';

const selector = new CostAwareRateSelector(
  [
    {
      providerId: 'bloomberg',
      provider: bloombergProvider,
      costUsdPerCall: 0.05,
      accuracyRank: 100,
    },
    {
      providerId: 'refinitiv',
      provider: refinitivProvider,
      costUsdPerCall: 0.02,
      accuracyRank: 80,
    },
    {
      // REQUIRED: at least one free provider to guarantee availability
      providerId: 'ecb',
      provider: ecbProvider,
      costUsdPerCall: 0,
      accuracyRank: 50,
    },
  ],
  registry,
  { metrics }
);
```

### 3. Use in FxConversionEngine

```typescript
// Wrap the selector as a RateProvider
const costAwareProvider: RateProvider = {
  getRate: (from, to) =>
    selector.selectRate(tenantId, from, to).then((r) => r.rate),
};

const engine = new FxConversionEngine(costAwareProvider, { metrics });
```

### 4. Emit spend gauges on a schedule

```typescript
// Every 60 seconds, emit gauge for all providers that have spend this month
setInterval(() => selector.emitSpendGauges(tenantId), 60_000);
```

---

## Budget Storage

### Development / testing

`InMemorySpendStore` is provided for local development and tests.  It is
non-durable and not safe for multi-replica deployments.

### Production

Implement the `SpendStore` interface against a durable backend:

```typescript
export interface SpendStore {
  increment(tenantId: string, providerId: string, monthKey: string, amountUsd: number): Promise<void>;
  get(tenantId: string, providerId: string, monthKey: string): Promise<number>;
  listByTenant(tenantId: string, monthKey: string): Promise<SpendRecord[]>;
}
```

**Recommended Postgres implementation:**

```sql
-- schema
CREATE TABLE fx_provider_spend (
  tenant_id    TEXT        NOT NULL,
  provider_id  TEXT        NOT NULL,
  month_key    CHAR(7)     NOT NULL,  -- 'YYYY-MM'
  spend_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider_id, month_key)
);

-- atomic increment
INSERT INTO fx_provider_spend (tenant_id, provider_id, month_key, spend_usd)
VALUES ($1, $2, $3, $4)
ON CONFLICT (tenant_id, provider_id, month_key)
DO UPDATE SET spend_usd = fx_provider_spend.spend_usd + EXCLUDED.spend_usd,
              updated_at = now();
```

Use `SELECT FOR UPDATE` or advisory locks if strict serialisation is required.

---

## Security Assumptions

1. **`tenantId` is pre-authenticated.** The registry and selector perform no
   authentication; they inherit the trust of the calling layer.

2. **Cost values are operator-defined.** `costUsdPerCall` is set in code, not
   derived from external inputs, preventing cost-manipulation attacks.

3. **Fail-open on storage errors.** If the spend store is unreachable, the
   registry returns "available" for all providers so distributions are never
   blocked.  Operators should alert on storage errors separately.

4. **Metric labels carry no PII.** Only `provider_id` (not `tenant_id`) is
   used as a metric label to keep cardinality low and prevent PII exposure.

5. **Negative spend increments are rejected.** `InMemorySpendStore.increment`
   and `FxProviderBudgetRegistry.recordSpend` both throw `RangeError` on
   negative values to prevent underflow manipulation.

6. **Budget caps are hard limits, not soft advice.** When `isExhausted` is
   `true`, the selector never sends traffic to that provider regardless of
   operator intent.

---

## Abuse / Failure Paths

| Scenario | Behaviour |
|---|---|
| All paid providers exhausted | Free (`ecb`) provider selected; no error |
| Spend store unreachable | Fail-open: all providers treated as available |
| Provider API error / timeout | `rate` is `null`; cost still recorded; caller handles null |
| Negative spend attempt | `RangeError` thrown immediately |
| No budget config for provider | Treated as "always available" (open budget) |
| Degradation threshold > cap | `RangeError` at `configureProvider` time |
| Missing free provider at startup | `Error` thrown in `CostAwareRateSelector` constructor |
| Provider with negative cost | `RangeError` thrown in `CostAwareRateSelector` constructor |

---

## Testing

```bash
# Run only cost-aware selection tests
npx jest src/services/fxCostAwareSelection.test.ts --coverage

# Run the full FX service suite
npx jest src/services/fxConversionEngine.test.ts src/services/fxCostAwareSelection.test.ts --coverage
```

Test coverage target: **≥ 95%** on `fxProviderBudgetRegistry.ts` and
`fxCostAwareSelector.ts`.

---

## Changelog

| Date | Change |
|---|---|
| 2026-07-28 | Initial implementation of cost-aware FX provider selection |
