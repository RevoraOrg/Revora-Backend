# FX Quorum / Variance Guard

## Problem

The FX rate pipeline (`src/services/providerHealthScorer.ts`) aggregates several upstream
rate providers through `FxProviderRouter`, which **silently returns the first healthy
provider's quote**. When two or more providers disagree by more than a variance threshold
this hides a data-integrity bug: a single misbehaving or compromised provider can feed a
wildly wrong rate into a conversion, a ledger post, or a payout — with no signal that
anything was wrong.

## Solution

Add a **quorum rule**: at least `k` of `n` configured providers must report a rate within a
relative `tolerance` of a consensus reference. When the quorum is **not** met the run is
**blocked** (a `503` is raised), ops are **paged** with the divergent rates, a
`fx_quorum_failed_total` counter is emitted, and the event is written to the **audit trail**.

### Components

| File | Responsibility |
| --- | --- |
| `src/services/fxQuorumEvaluator.ts` | `FxQuorumEvaluator` (pure, framework-free quorum math), `FxQuorumFailedError`, `FxQuorumAlerting` (pager + audit). |
| `src/services/providerHealthScorer.ts` | `FxProviderRouter` now optionally takes an `FxQuorumEvaluator` and enforces the guard in the rate-fetch pipeline. |
| `src/services/tenantSettingsService.ts` | Tenant-configurable quorum thresholds with dual-control propose/approve and full audit. |
| `src/lib/decimal.ts` | **Fix**: `Decimal.toString()` produced invalid strings for negative values (e.g. `"0.00-5"` instead of `"-0.0005"`), which silently corrupted deviation math. Corrected. |
| `src/services/fxQuorumEvaluator.test.ts`, `src/services/fxProviderRouter.quorum.test.ts`, `src/services/tenantSettingsService.fxQuorum.test.ts` | Tests. |

### Quorum math

1. Gather every configured provider's quote for the pair (in parallel; a throwing provider
   counts as an outage / `null`).
2. Keep the `valid` (non-`null`) rates. If none, quorum cannot be reached → block + page.
3. Compute the **consensus reference** from the valid mids. Default `median` (robust to a
   single outlier); `mean` is selectable.
4. A provider is **in consensus** when `|rate − reference| / reference ≤ tolerance`.
5. Quorum is met when `inConsensusCount ≥ k` **and** `valid ≥ minValidProviders`
   (default `minValidProviders = k`).
6. On success, return an **aggregated consensus rate** (median of `bid`/`ask`/`mid` across the
   in-consensus providers, most-recent timestamp, smallest `ttlMs`).
7. On failure, throw `FxQuorumFailedError` after emitting metrics, logging, and paging.

### Why median, and why relative tolerance?

- **Median** of the in-consensus quotes is used as the returned rate and as the divergence
  reference so a lone outlier cannot become the chosen quote.
- A **relative** tolerance (`|v − ref| / ref`) is the correct model for FX rates, which span
  many orders of magnitude across currency pairs.

## Configuration

```ts
import { FxQuorumEvaluator, FxQuorumAlerting } from './services/fxQuorumEvaluator';

const evaluator = new FxQuorumEvaluator(
  { k: 2, tolerance: 0.005 },                 // 2 of N within 0.5 %
  {
    metrics,                                  // MetricsCollector
    logger,                                   // Logger
    pager: (failure) => alerting.handle(failure),
  },
);

const alerting = new FxQuorumAlerting(
  (failure) => pagerOps(failure),             // your paging integration
  auditRepo,                                  // optional SecurityAuditRepository
  { tenantId, actorId },
);

// Wire into the rate-fetch pipeline:
const router = new FxProviderRouter(providers, scorer, evaluator);
// FxConversionEngine(router, ...) now blocks on quorum failure automatically.
```

| Field | Meaning | Default |
| --- | --- | --- |
| `k` | Min providers that must agree within tolerance | required |
| `tolerance` | Relative tolerance (e.g. `0.005` = 0.5%) | required |
| `reference` | `'median'` (default) or `'mean'` | `'median'` |
| `minValidProviders` | Floor on valid quotes required to pass | `k` |
| `allowReducedQuorum` | Trust a single configured provider | `true` |

### Edge cases (all covered by tests)

- **Single provider outage**: N−1 within tolerance with `k ≤ N−1` → quorum met.
- **Total outage** (all `null`): quorum cannot be reached → blocked + paged.
- **Fewer than 2 providers** with `allowReducedQuorum` (default): the lone provider is
  trusted (nothing to disagree with). Set `allowReducedQuorum: false` to force a failure
  when quorum is impossible.
- **`k > n` / `k > valid`**: quorum can never be reached → blocked + paged (surfaces
  misconfiguration).
- **`tolerance = 0`**: requires exact agreement.

## Tenant-configurable thresholds (with audit)

Thresholds can be overridden per tenant through dual-control (proposer ≠ approver) and are
fully audited, mirroring the existing sanctions-threshold flow:

```ts
await svc.proposeFxQuorumConfig(tenantId, 3, 0.002, proposerId, 'tighter guard');
await svc.approveFxQuorumConfig(tenantId, approverId);   // collusion-guarded
const cfg = await resolveFxQuorumConfig(svc, tenantId);   // merges over platform defaults
```

`propose`/`approve`/`reject` each write an `AuditEvent` (`fx_quorum_config_change_*`).
Additionally, every quorum **failure** writes a `SECURITY_VIOLATION` / `BLOCKED` audit event
via `FxQuorumAlerting` that includes the divergent rates.

## Metrics

| Metric | Type | When |
| --- | --- | --- |
| `fx_quorum_evaluated_total` | counter | every evaluation |
| `fx_quorum_passed_total` | counter | quorum satisfied |
| `fx_quorum_failed_total` | counter | **quorum failed** (divergence) |
| `fx_quorum_in_consensus` | gauge | # providers in consensus (last eval) |
| `fx_quorum_divergence_ratio` | gauge | max relative deviation (last eval) |

> Note: the issue referenced `fx.quorum.failed`. The codebase's `MetricsCollector` sanitises
> metric names to `a-zA-Z0-9_:` and the existing FX metrics use underscores, so the emitted
> name is `fx_quorum_failed_total`.

## Security assumptions

- Provider ids and currency pairs are treated as **untrusted labels** and sanitised before
  use in metric labels or logs.
- No secrets, PII, or credentials are emitted in metrics, logs, or the pager payload — only
  provider ids, the pair, numeric rates, and the deviation.
- The pager callback is wrapped so a failing pager never crashes the caller.
