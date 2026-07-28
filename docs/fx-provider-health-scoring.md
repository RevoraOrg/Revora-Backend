# FX Provider Health Scoring

Automatic demotion and promotion of FX rate providers based on rolling success rate, p95 latency, and rate staleness.

---

## Overview

Before this feature, all FX rate providers were treated as equally reliable regardless of their current error rate or response times. A single degraded provider could silently corrupt conversions or cause unnecessary request failures.

The health-scoring system tracks each provider's behaviour over a configurable rolling window and:

- **Demotes** a provider from primary rotation when its metrics cross a demotion threshold.
- **Promotes** it back only after a recovery window has elapsed and metrics cross a (higher) promotion threshold.
- **Falls back** to demoted providers rather than hard-failing, so degraded providers still act as last-resort backups.

---

## Key Components

| Class | File | Responsibility |
|---|---|---|
| `ProviderHealthScorer` | `src/services/providerHealthScorer.ts` | Tracks rolling metrics; enforces demotion/promotion logic |
| `ScoredRateProvider` | same | Wraps a `RateProvider`; records every call result into the scorer |
| `FxProviderRouter` | same | Routes `getRate` calls; prefers healthy providers; falls back to demoted ones |

---

## Architecture

```
FxConversionEngine
        │
        └─▶ FxProviderRouter.getRate(from, to)
                │
                ├─▶ Phase 1 – healthy providers (in declaration order)
                │       └─▶ ScoredRateProvider("primary") → inner.getRate()
                │                                          → scorer.record(…)
                │
                └─▶ Phase 2 – demoted providers (fallback only)
                        └─▶ ScoredRateProvider("backup") → inner.getRate()
                                                          → scorer.record(…)
```

Every call through `ScoredRateProvider` records:

- `success` — whether a non-null rate was returned
- `latencyMs` — wall-clock call duration
- `rateAgeMs` — how stale the returned rate is (`Date.now() - rate.timestamp`)
- `timestamp` — when the call was made

---

## Demotion Triggers

A provider is demoted when **any** of the following is true over the rolling window:

| Metric | Default demotion threshold | Default promotion threshold |
|---|---|---|
| Success rate | < 80 % | ≥ 90 % |
| p95 latency | > 5 000 ms | ≤ 2 000 ms |
| Mean rate age | > 30 000 ms | ≤ 15 000 ms |

Demotion does not fire until `minCallsForEvaluation` (default 10) calls have been recorded. This prevents false positives on cold start.

---

## Oscillation Prevention (Hysteresis)

Two mechanisms prevent rapid flip-flopping:

**1. Asymmetric thresholds** — The threshold to leave primary rotation (demotion) is lower than the threshold to re-enter it (promotion). A provider at 85 % success rate will not be promoted back if the demotion threshold is 80 % and the promotion threshold is 90 %.

**2. Mandatory recovery window** — After demotion, a provider cannot be promoted for at least `recoveryWindowMs` (default 60 000 ms). This gives genuinely unhealthy providers time to stabilise before being re-evaluated.

```
           demotionSuccessRate (80%)
                    │
── HEALTHY ─────────┤──────────────────── metrics improve
                    │        ▲
                    │        │ promotionSuccessRate (90%)
── DEMOTED ─────────┼────────┘
                    │
              recoveryWindowMs must elapse
              before promotion is checked
```

---

## Observability

### Metrics (Prometheus gauges/counters)

| Metric | Type | Description |
|---|---|---|
| `fx_provider_health_score` | gauge | Rolling success rate (0.0–1.0) per provider |
| `fx_provider_status` | gauge | `1` = primary, `0` = demoted |
| `fx_provider_latency_p95_ms` | gauge | p95 call latency in ms |
| `fx_provider_calls_total` | counter | Total calls per provider |
| `fx_provider_demotions_total` | counter | Total demotion events |
| `fx_provider_promotions_total` | counter | Total promotion events |

All metrics are labelled with `provider=<providerId>`.

### Structured logs

Demotion fires a `WARN` log:

```json
{
  "level": "WARN",
  "message": "FX provider demoted from primary rotation",
  "provider": "primary",
  "successRate": 0.72,
  "latencyP95Ms": 6200,
  "meanRateAgeMs": 4500,
  "windowSize": 100
}
```

Promotion fires an `INFO` log with the same shape.

### State-change callbacks

```typescript
scorer.onStateChange((event, snapshot) => {
  // event: 'demoted' | 'promoted'
  // snapshot: ProviderHealthSnapshot
  alerting.fire(`provider_${event}`, snapshot);
});
```

---

## Configuration Reference

```typescript
new ProviderHealthScorer({
  // Rolling window size (number of calls retained per provider)
  windowSize: 100,

  // Minimum calls before evaluation starts (prevents cold-start false positives)
  minCallsForEvaluation: 10,

  // Success rate thresholds (must satisfy: promotion > demotion for hysteresis)
  demotionSuccessRate: 0.80,
  promotionSuccessRate: 0.90,

  // p95 latency thresholds (set to Infinity to disable)
  demotionLatencyP95Ms: 5_000,
  promotionLatencyP95Ms: 2_000,

  // Mean rate staleness thresholds (set to Infinity to disable)
  demotionRateAgeMs: 30_000,
  promotionRateAgeMs: 15_000,

  // Mandatory cooldown after demotion before promotion is considered
  recoveryWindowMs: 60_000,
});
```

---

## Quick-Start Usage

```typescript
import { FxConversionEngine } from './fxConversionEngine';
import {
  ProviderHealthScorer,
  ScoredRateProvider,
  FxProviderRouter,
} from './providerHealthScorer';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';

const metrics = new MetricsCollector({ enabled: true });
const logger  = new Logger();

const scorer = new ProviderHealthScorer(
  { demotionSuccessRate: 0.80, promotionSuccessRate: 0.90 },
  metrics,
  logger
);

// Wire up alert callback
scorer.onStateChange((event, snapshot) => {
  if (event === 'demoted') {
    logger.warn('ALERT: FX provider demoted', { provider: snapshot.providerId });
  }
});

// Wrap upstream providers
const primary   = new ScoredRateProvider('primary',   upstreamA, scorer);
const secondary = new ScoredRateProvider('secondary', upstreamB, scorer);

// Router picks healthy providers first; falls back to demoted ones
const router = new FxProviderRouter([primary, secondary], scorer);

// Pass router directly to the conversion engine
const engine = new FxConversionEngine(router, { metrics });
```

---

## Security Assumptions

- **Label injection** — Provider IDs are sanitised (alphanumeric + `-_`, max 64 chars) before use in metric labels. Callers cannot inject arbitrary Prometheus label content.
- **No PII in metrics/logs** — Currency pairs and provider names only; no user-identifying data.
- **Process-local state** — The scorer maintains in-memory state per process. In a multi-replica deployment, each replica scores independently. External coordination (e.g., Redis) would be required for globally consistent demotion across replicas.
- **Callback isolation** — Exceptions thrown inside state-change callbacks are caught and suppressed so that a misbehaving alert integration cannot crash the scorer.

---

## Test Coverage

`src/services/providerHealthScorer.test.ts` — 52 test cases covering:

- Construction validation (hysteresis config guard)
- `minCallsForEvaluation` gate
- Demotion on each of the three signals independently
- Promotion hysteresis (stuck between thresholds stays demoted)
- Mandatory recovery window
- Rolling window eviction
- Borderline metrics do not cause oscillation
- At most one `demoted` callback per unhealthy streak
- All six metric names emitted correctly
- `ScoredRateProvider` — success, null return, thrown exception, latency and age recording
- `FxProviderRouter` — healthy-first routing, demoted-fallback, all-null fallback
- Integration: auto-demotion through repeated null returns via `ScoredRateProvider`
