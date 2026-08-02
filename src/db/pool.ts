/**
 * Database Connection Pools — primary + optional cross-region replica
 *
 * Exports:
 *   - `pool`        – primary read/write pool (always used for writes)
 *   - `replicaPool` – read replica pool (may be null when no replica is configured)
 *   - `readQuery`   – lag-aware query helper:
 *                       • routes SELECT queries to the replica when it is
 *                         healthy (lag < SLO threshold)
 *                       • falls back to the primary and emits
 *                         `db.replica.route_primary` when the replica lags
 *                         beyond the SLO or is unavailable
 *
 * Routing is applied per-query, not per-connection, so a single request can
 * mix writes (primary) and reads (replica or primary, depending on lag).
 *
 * Environment variables:
 *   DATABASE_URL            – primary connection string (required in production)
 *   REPLICA_DB_URL          – replica connection string (optional; omit to
 *                             disable replica routing entirely)
 *   REPLICA_LAG_THRESHOLD_MS – lag SLO in ms (default: 5 000)
 *   REPLICA_POLL_INTERVAL_MS – monitor polling interval in ms (default: 5 000)
 *
 * Security assumptions:
 *   - Connection strings are consumed by pg and never logged.
 *   - Metric labels contain no PII.
 *
 * @module db/pool
 */

import { Pool, QueryResult, QueryResultRow } from 'pg';
import { globalMetrics } from '../lib/metrics';
import { ReplicaLagMonitor } from './replicaLagMonitor';

// ---------------------------------------------------------------------------
// Primary pool
// ---------------------------------------------------------------------------

/**
 * Primary read/write pool.  All writes and DDL must go through this pool.
 * Also used as the fallback for reads when the replica is unhealthy.
 */
export const pool = new Pool({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME ?? 'revora',
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? '',
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
});

// ---------------------------------------------------------------------------
// Replica pool + lag monitor (optional)
// ---------------------------------------------------------------------------

/**
 * Read replica pool.  `null` when `REPLICA_DB_URL` is not set.
 */
export let replicaPool: Pool | null = null;

/**
 * Lag monitor instance.  `null` when no replica is configured.
 * Exported for testing and graceful-shutdown hooks.
 */
export let lagMonitor: ReplicaLagMonitor | null = null;

const replicaUrl = process.env.REPLICA_DB_URL;

if (replicaUrl) {
  replicaPool = new Pool({
    connectionString: replicaUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });

  lagMonitor = new ReplicaLagMonitor({
    replicaUrl,
    lagThresholdMs: Number(process.env.REPLICA_LAG_THRESHOLD_MS ?? 5_000),
    pollIntervalMs: Number(process.env.REPLICA_POLL_INTERVAL_MS ?? 5_000),
  });

  // Start the background polling loop; errors are swallowed inside the monitor.
  void lagMonitor.start();
}

// ---------------------------------------------------------------------------
// Lag-aware read routing helper
// ---------------------------------------------------------------------------

/**
 * Execute a read (SELECT) query with lag-aware routing.
 *
 * Routing logic (per-query):
 *   1. If no replica is configured  → primary
 *   2. If replica lag monitor reports healthy → replica pool
 *   3. Otherwise (lag ≥ SLO OR poll error) → primary + emit
 *      `db.replica.route_primary` counter
 *
 * For writes use `pool.query()` directly; this helper is intended exclusively
 * for read-only queries.
 *
 * @param sql    Parameterised SQL string
 * @param params Optional bound parameters
 * @returns      Standard pg `QueryResult`
 *
 * @example
 * ```typescript
 * const { rows } = await readQuery<User>('SELECT * FROM users WHERE id = $1', [userId]);
 * ```
 */
export async function readQuery<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  // Determine target pool
  if (lagMonitor !== null && replicaPool !== null && lagMonitor.isReplicaHealthy()) {
    return replicaPool.query<T>(sql, params);
  }

  // Replica unavailable or SLO breached — route to primary
  if (lagMonitor !== null) {
    // Only emit when a replica is configured but currently unhealthy
    globalMetrics.incrementCounter(
      'db.replica.route_primary',
      undefined,
      1,
      'Number of read queries routed to the primary due to replica lag SLO breach',
    );
  }

  return pool.query<T>(sql, params);
}

// ---------------------------------------------------------------------------
// Pool saturation snapshot (autoscaling signal)
// ---------------------------------------------------------------------------

/**
 * Synchronous snapshot of a pg Pool's saturation state.
 *
 * This is the source of the `db.pool.waiters` and `db.pool.utilization`
 * autoscaling gauges exported as OpenMetrics from `GET /metrics/db-pool`.
 * All values are read from the pool's internal counters, so no queries are
 * issued and a scrape can never block on the database.
 */
export interface DbPoolSaturation {
  /** Number of clients currently waiting to acquire a connection. */
  waiters: number;
  /** Total connections currently open in the pool. */
  total: number;
  /** Connections currently idle and available for checkout. */
  idle: number;
  /** Connections currently checked out (in use). */
  active: number;
  /** Maximum number of connections the pool is configured to open. */
  max: number;
  /**
   * Ratio of in-use connections to `max`, clamped to [0, 1].
   * Defined as 0 when `max` is 0 (pool configured without a size limit),
   * so the metric stays defined even when the pool is idle.
   */
  utilization: number;
}

/** Fallback when a pool was created without an explicit `max` option. */
const DEFAULT_POOL_MAX = 10;

/**
 * Compute a saturation snapshot for any pg Pool without issuing queries.
 *
 * `waitingCount` is the number of clients queued behind the pool's connection
 * limit — a leading indicator of DB-pool contention.  `utilization` expresses
 * how close the pool is to its configured capacity, which is the signal
 * horizontal autoscaling should react to (CPU alone misses pool saturation).
 *
 * @param target The pg Pool to snapshot.
 * @returns Synchronous saturation snapshot.
 */
export function getDbPoolSaturation(target: Pool): DbPoolSaturation {
  const waiters = target.waitingCount;
  const total = target.totalCount;
  const idle = target.idleCount;
  const active = Math.max(0, total - idle);
  const max = target.options?.max ?? DEFAULT_POOL_MAX;

  const utilization = max > 0 ? Math.min(1, Math.max(0, active / max)) : 0;

  return { waiters, total, idle, active, max, utilization };
}

/**
 * Saturation snapshot for the primary read/write pool.
 */
export function getPrimaryPoolSaturation(): DbPoolSaturation {
  return getDbPoolSaturation(pool);
}

/**
 * Saturation snapshot for the optional read replica pool.
 * Returns `null` when no replica is configured.
 */
export function getReplicaPoolSaturation(): DbPoolSaturation | null {
  return replicaPool ? getDbPoolSaturation(replicaPool) : null;
}

// ---------------------------------------------------------------------------
// Graceful shutdown helper
// ---------------------------------------------------------------------------

/**
 * Close all database pools and stop the lag monitor.
 * Call this during graceful shutdown (SIGTERM handler).
 */
export async function closeAllPools(): Promise<void> {
  if (lagMonitor) {
    await lagMonitor.stop();
  }
  const closeOps: Promise<void>[] = [pool.end()];
  if (replicaPool) {
    closeOps.push(replicaPool.end());
  }
  await Promise.all(closeOps);
}
