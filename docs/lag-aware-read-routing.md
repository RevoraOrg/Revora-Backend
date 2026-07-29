# Lag-Aware DB Read Routing

**Owner:** Backend Platform Team  
**Issue:** #527 — Multi-region failover: cross-region replica lag SLO with automatic read routing  
**Status:** Implemented

---

## Overview

Cross-region read replicas can lag beyond the RPO target during large writes or
network partitions. This feature adds **lag-aware read routing** that
automatically steers read queries to the **primary** when the replica lag
exceeds the configurable SLO threshold, then restores replica routing once lag
recovers.

The switch is recorded in the `db.replica.route_primary` counter metric so
alert rules and dashboards can detect SLO breaches.

---

## Architecture

```
                ┌───────────────────────────────────────────────────┐
                │                 Application Layer                  │
                │                                                     │
                │   readQuery("SELECT …")                            │
                └───────────────┬───────────────────────────────────┘
                                │
                    ┌───────────▼─────────────────┐
                    │  Routing Decision (per-query)│
                    │  lagMonitor.isReplicaHealthy │
                    └───────────┬─────────────────┘
               healthy          │           unhealthy / no replica
                    ┌───────────▼──┐         ┌──────────────────────┐
                    │  Replica Pool│         │     Primary Pool      │
                    │  (read-only) │         │  (read/write)         │
                    └──────────────┘         │  + emit counter       │
                                             └──────────────────────┘

                ┌──────────────────────────────────────────────────┐
                │  Background: ReplicaLagMonitor                    │
                │  Polls replica every REPLICA_POLL_INTERVAL_MS    │
                │  Compares lag_ms against REPLICA_LAG_THRESHOLD_MS │
                └──────────────────────────────────────────────────┘
```

### Key design decisions

| Decision | Rationale |
|----------|-----------|
| Per-query routing (not per-connection) | A single request can mix writes (always primary) and reads (replica when healthy). |
| Conservative default (start unhealthy) | Prevents routing to the replica before the first poll completes. |
| Poll errors → unhealthy | Network errors are treated the same as high lag — reads fall back to primary. |
| Recovery is automatic | Once lag drops below the threshold the monitor marks the replica healthy and reads resume without operator intervention. |
| No blocking on routing path | The lag monitor runs in a background interval; routing decisions are a synchronous flag read. |

---

## Configuration

| Environment variable | Default | Description |
|----------------------|---------|-------------|
| `DATABASE_URL` | — | Primary read/write connection string (required in production). |
| `REPLICA_DB_URL` | — | Replica connection string. **Omit to disable replica routing entirely.** |
| `REPLICA_LAG_THRESHOLD_MS` | `5000` | Lag SLO in milliseconds. Reads route to primary when `lag_ms >= threshold`. |
| `REPLICA_POLL_INTERVAL_MS` | `5000` | How often (ms) the monitor queries the replica for current lag. |

### Minimal example (`.env`)

```dotenv
DATABASE_URL=postgresql://user:pass@primary-host/revora
REPLICA_DB_URL=postgresql://user:pass@replica-host/revora
REPLICA_LAG_THRESHOLD_MS=5000
REPLICA_POLL_INTERVAL_MS=5000
```

---

## API

### `readQuery(sql, params?)`

```typescript
import { readQuery } from './src/db/pool';

// Automatically routes to replica (if healthy) or primary (if SLO breached)
const { rows } = await readQuery<User>(
  'SELECT id, email FROM users WHERE id = $1',
  [userId],
);
```

Use `pool.query()` directly for **writes**, DDL, and anything that must reach
the primary:

```typescript
import { pool } from './src/db/pool';

await pool.query(
  'INSERT INTO investments (user_id, amount) VALUES ($1, $2)',
  [userId, amount],
);
```

### `ReplicaLagMonitor`

Low-level service used by `pool.ts`; typically not consumed directly.

```typescript
import { ReplicaLagMonitor } from './src/db/replicaLagMonitor';

const monitor = new ReplicaLagMonitor({
  replicaUrl: process.env.REPLICA_DB_URL!,
  lagThresholdMs: 5_000,
  pollIntervalMs: 5_000,
});

await monitor.start();

// In your request handler:
if (monitor.isReplicaHealthy()) {
  // use replica pool
} else {
  // use primary pool
}

// Graceful shutdown:
await monitor.stop();
```

---

## Metrics

### `db.replica.route_primary` (counter)

Incremented **once per query** that is routed to the primary because the
replica lag monitor reported the replica as unhealthy (lag ≥ SLO or poll
error).

> Not emitted when no replica is configured — that is normal operation, not
> an SLO breach.

**Suggested alert rule (Prometheus / CloudWatch):**

```promql
increase(db_replica_route_primary[5m]) > 0
```

Fire an alert if any reads were rerouted to the primary in the last 5 minutes.

### `db.replica.lag_ms` (gauge)

Set on every successful poll to the current replication lag in milliseconds.
Use this for dashboards and trend analysis.

---

## Health check integration

The existing `/health` endpoint (`src/routes/health.ts`) exposes database
health. To surface replica lag status, add the following to the health
response object:

```typescript
replicaLag: lagMonitor?.getStatus() ?? null,
```

This exposes:

| Field | Type | Description |
|-------|------|-------------|
| `healthy` | boolean | Whether replica is within SLO |
| `lastLagMs` | number \| null | Most recent lag measurement |
| `lastCheckedAt` | string \| null | ISO-8601 timestamp of last successful poll |
| `lastErrorAt` | string \| null | ISO-8601 timestamp of last poll error |
| `consecutiveErrors` | number | How many polls have failed in a row |

---

## Security assumptions

1. `REPLICA_DB_URL` is consumed by the pg Pool constructor and is never
   logged, echoed in error messages, or included in metric labels.
2. Metric labels contain no PII — only aggregate routing decisions and numeric
   lag values.
3. The replica pool uses the same SSL settings as the primary (inherited from
   the pg Pool defaults and the connection string).
4. Poll errors are swallowed at the logging layer with connection strings
   redacted; they do not surface in HTTP responses.
5. The monitor's conservative default (unhealthy before first poll) prevents
   routing to a replica that has not yet been verified.

---

## Edge cases and failure modes

| Scenario | Behaviour |
|----------|-----------|
| Replica never configured | `readQuery` always targets the primary; no counter emitted. |
| First poll not yet complete | Replica is treated as unhealthy (conservative default). |
| Poll returns `NULL` lag | Treated as unhealthy — replica may be uninitialised or is the primary. |
| Lag exactly equals threshold | Treated as unhealthy (`lag_ms >= threshold`). |
| Negative / NaN lag value | Treated as unhealthy. |
| Replica pool connection timeout | Poll error → unhealthy; next successful poll restores health. |
| `stop()` called before `start()` | No-op; safe. |
| `start()` called after `stop()` | Throws `Error('…cannot be restarted')` — create a new instance. |
| Concurrent polls | `setInterval` callbacks execute sequentially in Node.js event loop; no locking required. |

---

## Testing

```bash
# Run only the lag-routing tests
npx jest src/db/replicaLagMonitor.test.ts --coverage

# Run full suite
npm test
```

Tests cover:

- Initial unhealthy state
- Healthy / unhealthy transitions across the threshold boundary
- Lag equal to threshold (unhealthy)
- NULL and invalid lag values
- Poll errors (network / connection failures)
- Recovery after lag drops
- Recovery after poll errors resolve
- `consecutiveErrors` accumulation
- Gauge metric emission on successful poll
- Counter metric emission on unhealthy route
- No counter emitted when no replica configured
- `stop()` closes the pool and cancels the interval
- Restart-after-stop throws
- `getStatus()` returns a defensive copy

---

## Related files

| File | Purpose |
|------|---------|
| `src/db/replicaLagMonitor.ts` | Background lag polling service |
| `src/db/pool.ts` | Pool singletons + `readQuery` routing helper |
| `src/db/replicaLagMonitor.test.ts` | Comprehensive unit tests |
| `src/lib/metrics.ts` | `MetricsCollector` used for `db.replica.*` metrics |
| `src/config/env.ts` | Environment variable definitions |
| `docs/runbooks/multi-region-failover.md` | Operational runbook for region failover |
