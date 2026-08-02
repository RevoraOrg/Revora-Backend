# DB Pool Saturation as Horizontal Autoscaling Signal

**Owner:** Backend Platform Team (on-call: #revora-backend)  
**Last Updated:** 2026-08-02

---

## Overview

Revora's workload is database-bound: under load, the first resource to saturate
is almost always the PostgreSQL connection pool, not the CPU of the API pod.
CPU-based autoscaling therefore misses the true bottleneck — an API pod can sit
at 20% CPU while a hundred requests queue behind the pool's connection limit.

This document describes the `db.pool.waiters` / `db.pool.utilization` metrics
that expose DB-pool contention as an OpenMetrics feed for the autoscaler, the
target thresholds the runbook assumes, the horizontal scaling guidance (HPA /
KEDA), and the alert rules that should accompany the autoscaler.

## Metrics

Both metrics are **gauges** refreshed synchronously from the pg pool counters
on every scrape. They are set explicitly on each scrape, so the series stays
**defined (value 0) even when the pool is completely idle** — an autoscaler can
always distinguish "healthy idle" from "missing metric".

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `db.pool.waiters` | gauge | `pool="primary"` \| `pool="replica"` | Number of clients currently waiting to acquire a connection (queued behind the pool's `max`). |
| `db.pool.utilization` | gauge | `pool="primary"` \| `pool="replica"` | Ratio of in-use connections to the pool's configured `max`, clamped to `[0, 1]`. |

`utilization` is computed as `active / max` where `active = totalCount - idleCount`.
When a pool is created without an explicit `max`, the helper assumes the default
pool size (10).

### Example Scrape Output

```
# HELP db.pool.waiters Number of clients waiting to acquire a database connection
# TYPE db.pool.waiters gauge
db.pool.waiters{pool="primary"} 0 1754121600
# TYPE db.pool.utilization gauge
db.pool.utilization{pool="primary"} 0.8 1754121600
```

## Endpoint

- **URL**: `GET /metrics/db-pool`
- **Format**: OpenMetrics text format v1.0.0 (`application/openmetrics-text; version=1.0.0; charset=utf-8`)
- **Authentication**: Bearer token via `createMetricsAuthMiddleware()` — the same
  scrape-auth guard as `GET /metrics` (see
  [`prometheus-metrics-endpoint.md`](./prometheus-metrics-endpoint.md))

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" \
     http://localhost:4000/metrics/db-pool
```

The response contains only the `db.pool.*` families, so a Prometheus scrape
config can point directly at this endpoint without a metric_relabel drop list.

### Security Assumptions

1. `METRICS_TOKEN` must be set in production; scrapes without a valid bearer
   token are rejected with 401 (see `createMetricsAuthMiddleware` in `src/app.ts`).
2. Only aggregate pool counters are emitted — no connection strings, queries,
   or PII can appear in the labels. Labels are sanitized by `MetricsCollector`
   (PII filtering + cardinality limit).
3. The handler never issues queries: all values come from pg's synchronous
   in-process counters (`totalCount`, `idleCount`, `waitingCount`), so scraping
   cannot add load to the database it is observing.

## Target Thresholds (Runbook)

| Signal | Target | Meaning |
|--------|--------|---------|
| `db.pool.utilization` | `<= 0.7` sustained | Pool has headroom; autoscaler holds at current replicas. |
| `db.pool.utilization` | `> 0.7` for 2 min | Pool approaching capacity — scale out (add a replica). |
| `db.pool.waiters` | `0` | All clients acquire connections immediately. |
| `db.pool.waiters` | `> 0` for 1 min | Clients are queueing — the pool is the bottleneck. Scale out immediately. |

A `waiters > 0` reading is a **leading** indicator: queueing starts before the
pool reaches full utilization, and queued requests directly translate into
p99 latency spikes and connection-timeout errors (`connectionTimeoutMillis`).

## Horizontal Autoscaling Guidance

### Option A: Prometheus Adapter + Kubernetes HPA (recommended)

Configure a scrape job for the `db-pool` endpoint, then reference the metrics
from an HPA. The example below scales the API deployment on **utilization**
(the capacity signal) with `waiters` acting as a hard cap that forces an
additional replica as soon as queueing begins.

Scrape config (add to the existing `revora-backend` job or a dedicated job):

```yaml
scrape_configs:
  - job_name: 'revora-backend-db-pool'
    scrape_interval: 15s
    scrape_timeout: 10s
    scheme: http
    authorization:
      type: Bearer
      credentials: '<METRICS_TOKEN>'
    metrics_path: /metrics/db-pool
    static_configs:
      - targets: ['revora-backend.default.svc.cluster.local:4000']
```

HPA definition:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: revora-api-db-pool
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: revora-api
  minReplicas: 3
  maxReplicas: 12
  metrics:
    - type: External
      external:
        metric:
          name: db_pool_utilization
          selector:
            matchLabels:
              pool: primary
        target:
          type: AverageValue
          averageValue: "0.7"          # scale out above 70% pool utilization
    - type: External
      external:
        metric:
          name: db_pool_waiters
          selector:
            matchLabels:
              pool: primary
        target:
          type: AverageValue
          averageValue: "0"            # any sustained queueing scales out
```

> **Note:** the Prometheus adapter maps the OpenMetrics/Prometheus name
> `db.pool.utilization` to the external metric name `db_pool_utilization`
> (dots are converted to underscores). Adjust the mapping to match the
> adapter's config if a custom name is preferred.

### Option B: KEDA

KEDA can trigger directly on a Prometheus query against the scrape target:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: revora-api-db-pool
spec:
  scaleTargetRef:
    name: revora-api
  minReplicaCount: 3
  maxReplicaCount: 12
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc:9090
        query: >-
          clamp_min(
            db_pool_utilization{pool="primary"}
            + 0.15 * (db_pool_waiters{pool="primary"} > 0),
            0
          )
        threshold: "0.7"
```

### Autoscaling Best Practices

1. **Base the primary metric on utilization, not waiters alone** — waiters is
   binary under light load (0 until the pool saturates); utilization gives the
   autoscaler a smooth gradient to follow.
2. **Scale down slowly.** Add a stabilization window (e.g. 5–10 min) to the
   HPA so pool churn does not oscillate replica counts.
3. **Do not scale beyond the database.** Increasing API replicas beyond the
   point where Postgres `max_connections` is the constraint just moves the
   queue. Monitor `db.pool.waiters` on the database side and cap replicas
   accordingly.
4. **Combine with CPU.** Keep a CPU-based metric as a secondary signal for
   CPU-bound (non-pool) hot paths. DB-pool scaling covers the database-bound
   path; CPU covers everything else.

## Alert Rules Example

Add these rules to the Prometheus alerting rules file for the backend. Both
alerts must be registered in the runbook mapping table
([`docs/runbooks/README.md`](./runbooks/README.md)) — CI enforces this via
`npm run validate:alert-mappings`.

```yaml
groups:
  - name: revora-db-pool.rules
    rules:
      - alert: DbPoolWaitersHigh
        expr: sum by (pool) (db_pool_waiters) > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "DB pool queueing detected ({{ $labels.pool }})"
          description: >-
            {{ $value }} client(s) are waiting to acquire a {{ $labels.pool }}
            database connection for over 1 minute. The connection pool is the
            bottleneck — check pg_stat_activity for stuck queries and confirm
            the autoscaler has scaled out.

      - alert: DbPoolUtilizationHigh
        expr: db_pool_utilization{pool="primary"} > 0.7
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "DB pool utilization above 70% ({{ $labels.pool }})"
          description: >-
            {{ $labels.pool }} pool is at {{ $value | humanizePercentage }}
            utilization for 5 minutes. Expected autoscaler reaction; escalate
            if utilization exceeds 90% or waiters climb above 0.
```

## Troubleshooting

### Autoscaler never scales out despite high CPU

CPU scaling misses DB-pool contention. Confirm the db-pool metrics exist and
are scraped:

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:4000/metrics/db-pool
# look for db_pool_waiters{pool="primary"} and db_pool_utilization{pool="primary"}
```

### Metric series absent

The series is defined on every scrape (0 when idle). If it is missing
entirely, either the endpoint is unreachable (check scrape auth, network
policy, `METRICS_TOKEN`) or the deployment predates this feature.

### Waiters > 0 but utilization < 1

Expected transiently under bursts: clients queue even while existing
connections are still being released. If it persists > 1 minute, investigate
long-running transactions (`pg_stat_activity`), not just pool sizing.

### Scrape returns 401

`METRICS_TOKEN` mismatch or missing header. See
[`prometheus-metrics-endpoint.md`](./prometheus-metrics-endpoint.md) for token
setup.

## Related Code

- `src/db/pool.ts` — `getDbPoolSaturation`, `getPrimaryPoolSaturation`,
  `getReplicaPoolSaturation` (synchronous pool counters)
- `src/lib/metrics.ts` — `MetricsCollector.collectDbPoolSaturation` (gauge emission)
- `src/middleware/metricsMiddleware.ts` — `createDbPoolMetricsHandler` (OpenMetrics handler)
- `src/app.ts` — `GET /metrics/db-pool` route mounted behind `createMetricsAuthMiddleware`

## Related Documentation

- [Prometheus Metrics Endpoint](./prometheus-metrics-endpoint.md)
- [Metrics & Logging Baseline](./metrics-and-logging-baseline.md)
- [Incident Response Playbook — Alert-to-Runbook Mapping](./runbooks/README.md)
