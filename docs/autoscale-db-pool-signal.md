# DB Pool Saturation as Autoscaling Signal

**Issue:** [#712](https://github.com/RevoraOrg/Revora-Backend/issues/712) — Autoscaling triggers: DB pool saturation as horizontal-scale signal  
**Status:** Implemented

---

## Overview

CPU-based HPA misses the real bottleneck when the Node event loop is fine but
the PostgreSQL connection pool is saturated (clients queued on `pool.connect()`).
This feature exports two gauges on every `/metrics` scrape:

| Metric | Type | Meaning |
|--------|------|---------|
| `db.pool.waiters` | gauge | Clients waiting for a free pool connection |
| `db.pool.utilization` | gauge | `totalCount / maxConnections` in `[0, 1]` |

Both series are **always defined**, including when the pool is idle
(`waiters=0`, `utilization=0`), so the autoscaler never sees a missing metric.

Scrapes are guarded by metrics auth (`METRICS_TOKEN` / internal token middleware).

---

## Architecture

```
GET /metrics  ──(auth)──►  createPrometheusHandler(metrics, pool)
                              │
                              ├─ metrics.updatePoolSaturationMetrics(pool)
                              │     db.pool.waiters
                              │     db.pool.utilization
                              └─ metrics.exportPrometheus()
```

---

## Configuration

| Variable | Role |
|----------|------|
| `METRICS_TOKEN` | Required in production for scrape auth |
| Pool `max` (pg `Pool` option) | Denominator for utilization (default 10 in `src/db/pool.ts`) |

---

## HPA guidance

Target **pool waiters** (or utilization) rather than (or in addition to) CPU.

### Suggested thresholds

| Signal | Warning | Scale-out |
|--------|---------|-----------|
| `db.pool.waiters` | `> 0` for 2m | `> 2` for 1m |
| `db.pool.utilization` | `> 0.7` for 5m | `> 0.85` for 2m |

### Example Kubernetes HPA (custom metrics / Prometheus adapter)

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: revora-api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: revora-api
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Pods
      pods:
        metric:
          name: db_pool_waiters
        target:
          type: AverageValue
          averageValue: "1"
    - type: Pods
      pods:
        metric:
          name: db_pool_utilization
        target:
          type: AverageValue
          # 0.75 → scale before hard saturation
          averageValue: "750m"
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
```

> Note: utilization is a ratio in `[0,1]`. Some adapters prefer milliratio
> (`750m` = 0.75). Confirm your metrics-adapter scaling.

### Example Prometheus alert rules

```yaml
groups:
  - name: revora-db-pool
    rules:
      - alert: DbPoolWaiters
        expr: db_pool_waiters > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "DB pool has waiting clients"
          description: "{{ $value }} clients waiting for a connection"

      - alert: DbPoolSaturation
        expr: db_pool_utilization > 0.85
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "DB pool utilization above 85%"
```

---

## Security assumptions

1. `/metrics` is behind scrape auth — pool gauges are not publicly readable.
2. Metric labels contain no PII (no connection strings, user IDs, or SQL).
3. Utilization is a closed ratio; waiters is a non-negative integer.

---

## Edge cases

| Scenario | Behaviour |
|----------|-----------|
| Pool idle | Both gauges published as `0` |
| Pool not passed to handler | Both gauges published as `0` |
| `totalCount > max` | Utilization clamped to `1` |
| `max == 0` | Utilization = `0` |

---

## Testing

```bash
npx jest src/lib/metrics.test.ts --testNamePattern="updatePoolSaturationMetrics" --forceExit
```

---

## Related files

| File | Role |
|------|------|
| `src/lib/metrics.ts` | `updatePoolSaturationMetrics()` |
| `src/middleware/metricsMiddleware.ts` | Refresh gauges on scrape |
| `src/db/pool.ts` | Primary pool source |
| `src/app.ts` | Wires pool into `/metrics` |
| `docs/autoscale-db-pool-signal.md` | This runbook |
