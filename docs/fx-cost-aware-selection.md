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
                └── SpendStore  (PgSpendStore in production; memory for local/test)
```

### Key files

| File | Purpose |
|---|---|
| `src/services/fxProviderBudgetRegistry.ts` | Per-tenant monthly spend tracking and budget cap enforcement |
| `src/services/pgSpendStore.ts` | Atomic, durable PostgreSQL spend storage and startup store selection |
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
import { FxProviderBudgetRegistry } from './services/fxProviderBudgetRegistry';
import { createFxProviderSpendStore } from './services/pgSpendStore';

// FX_PROVIDER_SPEND_STORE selects the backend at application startup.
const store = createFxProviderSpendStore(env.FX_PROVIDER_SPEND_STORE, pool);
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

`PgSpendStore` uses the shared primary PostgreSQL pool and persists spend rows
between restarts. At startup, `FX_PROVIDER_SPEND_STORE` selects `postgres` or
`memory`; it defaults to `postgres`, and configuration validation rejects
`memory` in production. Set it to `memory` only for local development or tests.
Apply the migrations before serving FX requests.

The migration creates `fx_provider_spend` with a unique
`(tenant_id, provider_id, month_key)` key. Each positive increment is one
parameterized `INSERT ... ON CONFLICT DO UPDATE`, so PostgreSQL serializes
concurrent increments on the same budget row without lost updates. Zero-cost
calls do not create rows. PostgreSQL `NUMERIC` values are converted to numbers
when read to satisfy the existing `SpendStore` interface.

Database query errors propagate from the store; the existing registry's
provider-selection policy fails open on storage failures so conversions are not
blocked. A database outage can therefore allow paid-provider spend that is not
recorded; alert on database/store errors if strict spend enforcement is needed.

`tenantId` is trusted input from the authenticated caller; this store does not
perform tenant authorization. The database connection must be restricted to
trusted service code, queries are parameterized, and the schema constrains
month keys to valid `YYYY-MM` values.

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

5. **Invalid spend increments are rejected.** In-memory and PostgreSQL stores
   reject negative or non-finite amounts with `RangeError`; the registry also
   rejects negative amounts to prevent underflow manipulation.

6. **Budget caps are selection guidance during storage outages.** With a
   persisted balance, the selector avoids a provider at its cap; established
   fail-open behavior can exceed the cap while storage is unavailable.

7. **PostgreSQL is mandatory in production.** Startup validation rejects the
   non-durable memory backend in production.

---

## Abuse / Failure Paths

| Scenario | Behaviour |
|---|---|
| All paid providers exhausted | Free (`ecb`) provider selected; no error |
| Spend store unreachable | Fail-open: all providers treated as available |
| Provider API error / timeout | `rate` is `null`; cost still recorded; caller handles null |
| Negative spend attempt | `RangeError` thrown immediately |
| Concurrent increments for one tenant/provider/month | Atomic row upsert; no updates are lost |
| Database unavailable during a read | Error reaches the registry, whose provider policy fails open |
| No budget config for provider | Treated as "always available" (open budget) |
| Degradation threshold > cap | `RangeError` at `configureProvider` time |
| Missing free provider at startup | `Error` thrown in `CostAwareRateSelector` constructor |
| Provider with negative cost | `RangeError` thrown in `CostAwareRateSelector` constructor |

---

## Testing

```bash
# Run only cost-aware selection tests
npx jest src/services/fxCostAwareSelection.test.ts --coverage

# Run PostgreSQL spend-store unit and gated integration tests
npx jest src/services/pgSpendStore.test.ts src/services/pgSpendStore.integration.test.ts --coverage=false

# Run the full FX service suite
npx jest src/services/fxConversionEngine.test.ts src/services/fxCostAwareSelection.test.ts --coverage
```

Test coverage target: **≥ 95%** on `fxProviderBudgetRegistry.ts` and
`fxCostAwareSelector.ts`.

---

## Changelog

| Date | Change |
|---|---|
| 2026-11-23 | Added durable PostgreSQL spend storage and atomic concurrent increments |
| 2026-07-28 | Initial implementation of cost-aware FX provider selection |
