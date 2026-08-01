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
// Credential rotation
// ---------------------------------------------------------------------------

/**
 * Configuration for database credential rotation.
 */
export interface PoolCredentialConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

/**
 * Callback invoked after credential rotation completes (success or failure).
 */
export type CredentialsRotatedCallback = (
  event: 'rotated' | 'failed',
  details: { timestamp: string; error?: string },
) => void;

const rotationListeners: CredentialsRotatedCallback[] = [];

/**
 * Register a callback to be notified of credential rotation events.
 */
export function onCredentialsRotated(cb: CredentialsRotatedCallback): void {
  rotationListeners.push(cb);
}

/** Remove all credential rotation listeners (useful in test teardown). */
export function clearRotationListeners(): void {
  rotationListeners.length = 0;
}

function notifyListeners(
  event: 'rotated' | 'failed',
  details: { error?: string },
): void {
  const payload = { timestamp: new Date().toISOString(), ...details };
  for (const cb of rotationListeners) {
    try { cb(event, payload); } catch { /* swallow */ }
  }
}

/**
 * Rotate the primary database pool credentials at runtime.
 *
 * Creates a fresh pool with the supplied credentials, smoke-tests it,
 * then swaps the exported `pool` reference. The old pool is drained
 * gracefully (5 s delay) before closing.
 *
 * Guardrails:
 *  - Gated on `DB_ROTATION_ENABLED=true` (no-op otherwise).
 *  - Counter `db.pool.credential_rotation` incremented on success.
 *  - Counter `db.pool.credential_rotation_failed` + listener on failure.
 *
 * @example
 * await rotatePoolCredentials({ password: process.env.NEW_DB_PASSWORD });
 */
export async function rotatePoolCredentials(
  config: PoolCredentialConfig,
): Promise<void> {
  if (process.env.DB_ROTATION_ENABLED !== 'true') {
    return;
  }

  const newPool = new Pool({
    host: config.host ?? process.env.DB_HOST ?? 'localhost',
    port: config.port ?? Number(process.env.DB_PORT ?? 5432),
    database: config.database ?? process.env.DB_NAME ?? 'revora',
    user: config.user ?? process.env.DB_USER ?? 'postgres',
    password: config.password ?? process.env.DB_PASSWORD ?? '',
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 2_000,
  });

  // Smoke-test: verify new credentials with a lightweight query
  try {
    await newPool.query('SELECT 1');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    globalMetrics.incrementCounter(
      'db.pool.credential_rotation_failed', undefined, 1,
      'Number of failed credential rotation attempts',
    );
    notifyListeners('failed', { error: message });
    await newPool.end().catch(() => {});
    throw new Error(`Credential rotation failed: ${message}`);
  }

  // Swap pools — keep old alive for in-flight queries
  const oldPool = pool;
  (pool as Pool) = newPool;

  setTimeout(() => { oldPool.end().catch(() => {}); }, 5_000);

  globalMetrics.incrementCounter(
    'db.pool.credential_rotation', undefined, 1,
    'Number of successful credential rotation events',
  );
  notifyListeners('rotated', {});
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
