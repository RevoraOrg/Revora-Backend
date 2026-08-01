/**
 * ReplicaLagMonitor
 *
 * @notice Polls a cross-region read replica and drives lag-aware read routing
 *         for issue #715.
 *
 * @dev When measured lag exceeds `lagThresholdMs` the monitor marks the replica
 *      unhealthy and `readQuery()` in `pool.ts` steers SELECT traffic to the
 *      primary, emitting `db.replica.route_primary`.  When lag drops back below
 *      the SLO the replica is marked healthy again (recovery) and
 *      `db.replica.recovered` is incremented so operators can see the restore.
 *
 * Design constraints:
 * - The monitor runs out-of-band; it never blocks query execution.
 * - Routing is applied **per-query**, not per-connection.
 * - Polling errors are treated conservatively: the replica is considered
 *   unhealthy until a successful measurement re-establishes a known-good state.
 * - The class is injectable (accepts a pool factory) so tests can supply a
 *   fake pool without touching real network resources.
 *
 * Security assumptions:
 * - `REPLICA_DB_URL` must never be logged; it is consumed by the pg Pool and
 *   never echoed back into error messages or metrics labels.
 * - Metric labels contain no PII — only aggregate routing decisions.
 *
 * @module db/replicaLagMonitor
 */

import { Pool, PoolClient } from 'pg';
import { globalMetrics } from '../lib/metrics';
import { globalLogger } from '../lib/logger';

const logger = globalLogger.child({ service: 'replica-lag-monitor' });

/**
 * SQL that returns current replication lag in milliseconds.
 *
 * `pg_last_wal_replay_lsn` is NULL on the primary (not in recovery), which
 * means this query returns NULL when accidentally run against the primary —
 * the caller treats NULL as "replica unavailable" and routes to primary.
 *
 * On a standby the expression evaluates to the wall-clock delay between the
 * last WAL record received and the current time, expressed in ms.
 */
const LAG_QUERY = `
  SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000
    AS lag_ms
`;

export interface ReplicaLagMonitorOptions {
  /** Connection string for the read replica. */
  replicaUrl: string;
  /**
   * Lag threshold in milliseconds.  When measured lag >= threshold the replica
   * is considered SLO-breached and reads are steered to the primary.
   * @default 5000
   */
  lagThresholdMs?: number;
  /**
   * Polling interval in milliseconds.
   * @default 5000
   */
  pollIntervalMs?: number;
  /**
   * Optional factory that creates the replica Pool.  Defaults to `new Pool()`.
   * Inject a fake in unit tests.
   */
  poolFactory?: (url: string) => Pool;
  /**
   * Optional MetricsCollector override.  Defaults to `globalMetrics`.
   */
  metrics?: Pick<typeof globalMetrics, 'incrementCounter' | 'setGauge'>;
}

/**
 * Internal state exposed via `getStatus()` for routing decisions and health
 * endpoints.
 */
export interface ReplicaLagStatus {
  /** Whether the replica is reachable and within SLO. */
  healthy: boolean;
  /** Last measured lag in milliseconds, or null if never polled successfully. */
  lastLagMs: number | null;
  /** ISO-8601 timestamp of last successful poll, or null. */
  lastCheckedAt: string | null;
  /** ISO-8601 timestamp of last poll error, or null. */
  lastErrorAt: string | null;
  /** Number of consecutive poll failures since last healthy measurement. */
  consecutiveErrors: number;
}

export class ReplicaLagMonitor {
  private readonly lagThresholdMs: number;
  private readonly pollIntervalMs: number;
  private readonly metrics: Pick<typeof globalMetrics, 'incrementCounter' | 'setGauge'>;

  private replicaPool: Pool;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  private status: ReplicaLagStatus = {
    healthy: false, // conservative default — assume unhealthy until first poll
    lastLagMs: null,
    lastCheckedAt: null,
    lastErrorAt: null,
    consecutiveErrors: 0,
  };

  constructor(private readonly opts: ReplicaLagMonitorOptions) {
    this.lagThresholdMs = opts.lagThresholdMs ?? 5_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.metrics = opts.metrics ?? globalMetrics;

    const factory = opts.poolFactory ?? ((url: string) =>
      new Pool({
        connectionString: url,
        max: 2, // minimal pool — only used for lag checks
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 3_000,
      })
    );
    this.replicaPool = factory(opts.replicaUrl);
  }

  /**
   * Start the background polling loop.
   *
   * Performs an immediate first poll so callers can inspect `getStatus()`
   * synchronously after `await start()`.
   */
  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error('ReplicaLagMonitor has been stopped and cannot be restarted');
    }
    // Perform initial poll before scheduling the interval
    await this.poll();

    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  /**
   * Stop the polling loop and close the replica pool.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await this.replicaPool.end();
    } catch (err) {
      logger.warn('Error closing replica pool during stop', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Return the current replica lag status without triggering a new poll.
   */
  getStatus(): Readonly<ReplicaLagStatus> {
    return { ...this.status };
  }

  /**
   * Returns `true` when the replica is healthy and reads should be routed
   * there.  Returns `false` when reads must be steered to the primary.
   */
  isReplicaHealthy(): boolean {
    return this.status.healthy;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Execute a single lag measurement and update internal state.
   * All errors are swallowed — the caller is an interval callback.
   */
  private async poll(): Promise<void> {
    let client: PoolClient | null = null;
    try {
      client = await this.replicaPool.connect();
      const result = await client.query<{ lag_ms: string | null }>(LAG_QUERY);

      const rawLag = result.rows[0]?.lag_ms;

      // NULL means either the replica has never replayed any WAL (just
      // promoted / freshly set up) or this is the primary.  Treat as healthy
      // only if we have a numeric value within the threshold.
      if (rawLag === null || rawLag === undefined) {
        this.markUnhealthy(null, 'lag_ms returned NULL — replica may be uninitialised or is the primary');
        return;
      }

      const lagMs = parseFloat(rawLag);

      if (!isFinite(lagMs) || lagMs < 0) {
        this.markUnhealthy(null, `Unexpected lag value: ${rawLag}`);
        return;
      }

      // Emit gauge metric regardless of health decision
      this.metrics.setGauge(
        'db.replica.lag_ms',
        lagMs,
        undefined,
        'Current replication lag in milliseconds',
      );

      if (lagMs >= this.lagThresholdMs) {
        this.markUnhealthy(lagMs, `Lag ${lagMs}ms >= threshold ${this.lagThresholdMs}ms`);
      } else {
        this.markHealthy(lagMs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Redact connection strings from log output
      const safeMsg = msg.replace(/postgresql:\/\/[^\s]*/gi, 'postgresql://[REDACTED]');
      this.markUnhealthy(null, `Poll error: ${safeMsg}`);
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  private markHealthy(lagMs: number): void {
    const wasUnhealthy = !this.status.healthy;
    this.status = {
      healthy: true,
      lastLagMs: lagMs,
      lastCheckedAt: new Date().toISOString(),
      lastErrorAt: this.status.lastErrorAt,
      consecutiveErrors: 0,
    };

    if (wasUnhealthy) {
      logger.info('Replica lag recovered — resuming replica read routing', {
        lagMs,
        thresholdMs: this.lagThresholdMs,
      });
      // Surface recovery so dashboards can distinguish "still breached" from
      // "just restored" without relying solely on the lag gauge.
      this.metrics.incrementCounter(
        'db.replica.recovered',
        undefined,
        1,
        'Number of times replica lag recovered below SLO and read routing resumed',
      );
    }
  }

  private markUnhealthy(lagMs: number | null, reason: string): void {
    const wasHealthy = this.status.healthy;
    this.status = {
      healthy: false,
      lastLagMs: lagMs,
      lastCheckedAt: lagMs !== null ? new Date().toISOString() : this.status.lastCheckedAt,
      lastErrorAt: new Date().toISOString(),
      consecutiveErrors: this.status.consecutiveErrors + 1,
    };

    if (wasHealthy) {
      logger.warn('Replica lag SLO breached — steering reads to primary', {
        reason,
        thresholdMs: this.lagThresholdMs,
      });
    }
  }
}
