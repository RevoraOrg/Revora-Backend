# Lag-Aware DB Read Routing

**Issue:** [#715](https://github.com/RevoraOrg/Revora-Backend/issues/715) — Multi-region failover: cross-region replica lag SLO with automatic read routing  
**Status:** Implemented

---

## Overview

Cross-region read replicas can lag beyond the RPO target during large writes or
network partitions. This feature adds **lag-aware read routing** that
automatically steers read queries to the **primary** when the replica lag
exceeds the configurable SLO threshold, then restores replica routing once lag
recovers.

The switch is recorded in the `db.replica.route_primary` counter metric so
alert rules and dashboards can detect SLO breaches. Recovery emits
`db.replica.recovered`.

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
| `DATABASE_URL` / `DB_*` | — | Primary read/write connection (required in production). |
| `REPLICA_DB_URL` | — | Replica connection string. **Omit to disable replica routing entirely.** |
| `REPLICA_LAG_THRESHOLD_MS` | `5000` | Lag SLO in milliseconds. Reads route to primary when `lag_ms >= threshold`. |
| `REPLICA_POLL_INTERVAL_MS` | `5000` | How often (ms) the monitor queries the replica for current lag. |

Declared in `src/config/env.ts` and consumed by `src/db/pool.ts`.

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
the primary.

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
// …
await monitor.stop();
```

---

## Metrics

| Metric | Type | When |
|--------|------|------|
| `db.replica.route_primary` | counter | Each read steered to primary due to unhealthy replica |
| `db.replica.recovered` | counter | Lag drops below SLO and replica routing resumes |
| `db.replica.lag_ms` | gauge | Current lag on every successful poll |

> `db.replica.route_primary` is **not** emitted when no replica is configured.

**Suggested alert:**

```promql
increase(db_replica_route_primary[5m]) > 0
```

---

## Security assumptions

1. `REPLICA_DB_URL` is never logged, echoed in errors, or included in metric labels.
2. Metric labels contain no PII.
3. Poll errors redact connection strings before logging.
4. Conservative default (unhealthy before first poll) prevents routing to an unverified replica.

---

## Edge cases and failure modes

| Scenario | Behaviour |
|----------|-----------|
| Replica never configured | `readQuery` always targets the primary; no counter emitted. |
| First poll not yet complete | Replica treated as unhealthy. |
| Poll returns `NULL` lag | Treated as unhealthy. |
| Lag exactly equals threshold | Treated as unhealthy (`lag_ms >= threshold`). |
| Negative / NaN lag | Treated as unhealthy. |
| Replica pool connection timeout | Poll error → unhealthy; next successful poll restores health. |
| `start()` after `stop()` | Throws — create a new instance. |

---

## Testing

```bash
npx jest src/db/replicaLagMonitor.test.ts --forceExit
```

Covers healthy/unhealthy transitions, threshold boundary, NULL/invalid lag,
poll errors, **recovery after lag drops**, recovery metric, and per-query
routing to primary vs replica.

---

## Related files

| File | Purpose |
|------|---------|
| `src/db/replicaLagMonitor.ts` | Background lag polling service |
| `src/db/pool.ts` | Pool singletons + `readQuery` routing helper |
| `src/db/replicaLagMonitor.test.ts` | Unit tests |
| `src/config/env.ts` | `REPLICA_*` environment schema |
| `src/lib/metrics.ts` | Metrics collector |
