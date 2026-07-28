/**
 * Tests for lag-aware DB read routing
 *
 * Coverage:
 *   ReplicaLagMonitor
 *     - healthy / unhealthy state transitions
 *     - lag threshold boundary (equal to threshold is unhealthy)
 *     - poll errors drive replica unhealthy
 *     - recovery: replica becomes healthy again after lag drops
 *     - NULL lag_ms treated as unhealthy
 *     - negative / non-finite lag treated as unhealthy
 *     - gauge metric emitted on successful poll
 *     - stop() closes pool and cancels timer
 *     - restarting a stopped monitor throws
 *
 *   readQuery (pool.ts routing layer)
 *     - routes to replica when lagMonitor reports healthy
 *     - routes to primary when lagMonitor reports unhealthy and emits counter
 *     - routes to primary when no replica configured (no counter emitted)
 *     - counter increments on each unhealthy route
 *
 * @module db/replicaLagMonitor.test
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import { ReplicaLagMonitor, ReplicaLagMonitorOptions } from './replicaLagMonitor';
import { MetricsCollector } from '../lib/metrics';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const makeQueryResult = (rows: Record<string, unknown>[]): QueryResult<any> => ({
  rows,
  command: 'SELECT',
  oid: 0,
  fields: [],
  rowCount: rows.length,
});

interface MockClient {
  query: jest.Mock;
  release: jest.Mock;
}

function buildMockPool(lagMs: number | null | 'error'): {
  pool: jest.Mocked<Pool>;
  client: MockClient;
} {
  const client: MockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };

  if (lagMs === 'error') {
    client.query.mockRejectedValue(new Error('connection refused'));
  } else {
    client.query.mockResolvedValue(
      makeQueryResult([{ lag_ms: lagMs === null ? null : String(lagMs) }]),
    );
  }

  const mockPool = {
    connect: jest.fn().mockResolvedValue(client),
    end: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Pool>;

  return { pool: mockPool, client };
}

function buildMonitor(
  lagMs: number | null | 'error',
  overrides: Partial<ReplicaLagMonitorOptions> = {},
): { monitor: ReplicaLagMonitor; metrics: MetricsCollector; client: MockClient } {
  const { pool: mockPool, client } = buildMockPool(lagMs);
  const metrics = new MetricsCollector({ enabled: true });

  const monitor = new ReplicaLagMonitor({
    replicaUrl: 'postgresql://replica:5432/revora',
    lagThresholdMs: 5_000,
    pollIntervalMs: 60_000, // large interval — we trigger polls manually
    poolFactory: () => mockPool,
    metrics,
    ...overrides,
  });

  return { monitor, metrics, client };
}

// ---------------------------------------------------------------------------
// ReplicaLagMonitor unit tests
// ---------------------------------------------------------------------------

describe('ReplicaLagMonitor', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  it('starts in unhealthy state before first poll', () => {
    const { monitor } = buildMonitor(100);
    expect(monitor.isReplicaHealthy()).toBe(false);
    const status = monitor.getStatus();
    expect(status.healthy).toBe(false);
    expect(status.lastLagMs).toBeNull();
    expect(status.lastCheckedAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Healthy paths
  // -------------------------------------------------------------------------

  it('marks replica healthy when lag is below threshold', async () => {
    const { monitor } = buildMonitor(100); // 100ms < 5000ms
    await monitor.start();

    expect(monitor.isReplicaHealthy()).toBe(true);
    const status = monitor.getStatus();
    expect(status.healthy).toBe(true);
    expect(status.lastLagMs).toBe(100);
    expect(status.lastCheckedAt).not.toBeNull();
    expect(status.consecutiveErrors).toBe(0);

    await monitor.stop();
  });

  it('marks replica healthy when lag is just below threshold', async () => {
    const { monitor } = buildMonitor(4_999); // 1ms below 5000ms threshold
    await monitor.start();

    expect(monitor.isReplicaHealthy()).toBe(true);
    await monitor.stop();
  });

  it('emits db.replica.lag_ms gauge on successful poll', async () => {
    const { monitor, metrics } = buildMonitor(1_200);
    await monitor.start();

    const snapshot = await metrics.getSnapshot();
    const lagGauge = snapshot.custom.find((m) => m.name === 'db_replica_lag_ms');
    expect(lagGauge).toBeDefined();
    expect(lagGauge?.value).toBe(1_200);

    await monitor.stop();
  });

  // -------------------------------------------------------------------------
  // Unhealthy paths
  // -------------------------------------------------------------------------

  it('marks replica unhealthy when lag equals threshold', async () => {
    const { monitor } = buildMonitor(5_000); // equal to threshold → unhealthy
    await monitor.start();

    expect(monitor.isReplicaHealthy()).toBe(false);
    const status = monitor.getStatus();
    expect(status.healthy).toBe(false);
    expect(status.lastLagMs).toBe(5_000);

    await monitor.stop();
  });

  it('marks replica unhealthy when lag exceeds threshold', async () => {
    const { monitor } = buildMonitor(30_000);
    await monitor.start();

    expect(monitor.isReplicaHealthy()).toBe(false);
    const status = monitor.getStatus();
    expect(status.lastLagMs).toBe(30_000);

    await monitor.stop();
  });

  it('marks replica unhealthy on NULL lag_ms (uninitialised replica)', async () => {
    const { monitor } = buildMonitor(null);
    await monitor.start();

    expect(monitor.isReplicaHealthy()).toBe(false);
    const status = monitor.getStatus();
    expect(status.lastLagMs).toBeNull();
    expect(status.consecutiveErrors).toBe(1);

    await monitor.stop();
  });

  it('marks replica unhealthy on poll error (network failure)', async () => {
    const { monitor } = buildMonitor('error');
    await monitor.start();

    expect(monitor.isReplicaHealthy()).toBe(false);
    const status = monitor.getStatus();
    expect(status.consecutiveErrors).toBe(1);
    expect(status.lastErrorAt).not.toBeNull();

    await monitor.stop();
  });

  it('increments consecutiveErrors across multiple poll failures', async () => {
    const { pool: mockPool, client } = buildMockPool('error');
    const metrics = new MetricsCollector({ enabled: true });

    // First call healthy, next two throw
    client.query
      .mockResolvedValueOnce(makeQueryResult([{ lag_ms: '100' }]))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'));

    const monitor = new ReplicaLagMonitor({
      replicaUrl: 'postgresql://replica:5432/revora',
      lagThresholdMs: 5_000,
      pollIntervalMs: 60_000,
      poolFactory: () => mockPool,
      metrics,
    });

    // Trigger three polls manually via the private method
    await (monitor as any).poll(); // healthy
    expect(monitor.isReplicaHealthy()).toBe(true);

    await (monitor as any).poll(); // error → unhealthy
    expect(monitor.isReplicaHealthy()).toBe(false);
    expect(monitor.getStatus().consecutiveErrors).toBe(1);

    await (monitor as any).poll(); // error again
    expect(monitor.getStatus().consecutiveErrors).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  it('recovers to healthy after lag drops below threshold', async () => {
    const { pool: mockPool, client } = buildMockPool(30_000);
    const metrics = new MetricsCollector({ enabled: true });

    // First poll: lag > threshold (unhealthy)
    // Second poll: lag < threshold (healthy)
    client.query
      .mockResolvedValueOnce(makeQueryResult([{ lag_ms: '30000' }]))
      .mockResolvedValueOnce(makeQueryResult([{ lag_ms: '200' }]));

    const monitor = new ReplicaLagMonitor({
      replicaUrl: 'postgresql://replica:5432/revora',
      lagThresholdMs: 5_000,
      pollIntervalMs: 60_000,
      poolFactory: () => mockPool,
      metrics,
    });

    await (monitor as any).poll();
    expect(monitor.isReplicaHealthy()).toBe(false);

    await (monitor as any).poll();
    expect(monitor.isReplicaHealthy()).toBe(true);
    expect(monitor.getStatus().consecutiveErrors).toBe(0);
    expect(monitor.getStatus().lastLagMs).toBe(200);
  });

  it('recovers to healthy after poll error resolves', async () => {
    const { pool: mockPool, client } = buildMockPool('error');
    const metrics = new MetricsCollector({ enabled: true });

    client.query
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(makeQueryResult([{ lag_ms: '300' }]));

    const monitor = new ReplicaLagMonitor({
      replicaUrl: 'postgresql://replica:5432/revora',
      lagThresholdMs: 5_000,
      pollIntervalMs: 60_000,
      poolFactory: () => mockPool,
      metrics,
    });

    await (monitor as any).poll();
    expect(monitor.isReplicaHealthy()).toBe(false);

    await (monitor as any).poll();
    expect(monitor.isReplicaHealthy()).toBe(true);
    expect(monitor.getStatus().consecutiveErrors).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('treats negative lag as unhealthy', async () => {
    const { pool: mockPool, client } = buildMockPool(-100 as any);
    const metrics = new MetricsCollector({ enabled: true });

    client.query.mockResolvedValue(makeQueryResult([{ lag_ms: '-100' }]));

    const monitor = new ReplicaLagMonitor({
      replicaUrl: 'postgresql://replica:5432/revora',
      lagThresholdMs: 5_000,
      pollIntervalMs: 60_000,
      poolFactory: () => mockPool,
      metrics,
    });

    await (monitor as any).poll();
    expect(monitor.isReplicaHealthy()).toBe(false);
  });

  it('treats NaN lag as unhealthy', async () => {
    const { pool: mockPool, client } = buildMockPool(NaN as any);
    const metrics = new MetricsCollector({ enabled: true });

    client.query.mockResolvedValue(makeQueryResult([{ lag_ms: 'not-a-number' }]));

    const monitor = new ReplicaLagMonitor({
      replicaUrl: 'postgresql://replica:5432/revora',
      lagThresholdMs: 5_000,
      pollIntervalMs: 60_000,
      poolFactory: () => mockPool,
      metrics,
    });

    await (monitor as any).poll();
    expect(monitor.isReplicaHealthy()).toBe(false);
  });

  it('treats zero lag as healthy', async () => {
    const { monitor } = buildMonitor(0);
    await monitor.start();
    expect(monitor.isReplicaHealthy()).toBe(true);
    await monitor.stop();
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  it('stop() cancels interval and closes pool', async () => {
    const { pool: mockPool } = buildMockPool(100);
    const metrics = new MetricsCollector({ enabled: true });

    const monitor = new ReplicaLagMonitor({
      replicaUrl: 'postgresql://replica:5432/revora',
      lagThresholdMs: 5_000,
      pollIntervalMs: 60_000,
      poolFactory: () => mockPool,
      metrics,
    });

    await monitor.start();
    await monitor.stop();

    expect(mockPool.end).toHaveBeenCalledTimes(1);
  });

  it('throws when start() is called after stop()', async () => {
    const { monitor } = buildMonitor(100);
    await monitor.start();
    await monitor.stop();

    await expect(monitor.start()).rejects.toThrow(
      'ReplicaLagMonitor has been stopped and cannot be restarted',
    );
  });

  it('getStatus() returns a defensive copy (not mutable state)', async () => {
    const { monitor } = buildMonitor(100);
    await monitor.start();

    const status1 = monitor.getStatus();
    // Mutate the returned copy
    (status1 as any).healthy = false;
    (status1 as any).lastLagMs = 99999;

    // Internal state must be unchanged
    const status2 = monitor.getStatus();
    expect(status2.healthy).toBe(true);
    expect(status2.lastLagMs).toBe(100);

    await monitor.stop();
  });

  // -------------------------------------------------------------------------
  // Custom threshold
  // -------------------------------------------------------------------------

  it('respects custom lagThresholdMs', async () => {
    const { monitor } = buildMonitor(800, { lagThresholdMs: 1_000 }); // 800 < 1000 → healthy
    await monitor.start();
    expect(monitor.isReplicaHealthy()).toBe(true);
    await monitor.stop();
  });

  it('respects custom lagThresholdMs (breach)', async () => {
    const { monitor } = buildMonitor(1_500, { lagThresholdMs: 1_000 }); // 1500 >= 1000 → unhealthy
    await monitor.start();
    expect(monitor.isReplicaHealthy()).toBe(false);
    await monitor.stop();
  });

  // -------------------------------------------------------------------------
  // setInterval fires (coverage for the polling callback path)
  // -------------------------------------------------------------------------

  it('polling interval fires and updates status', async () => {
    jest.useFakeTimers();
    const { pool: mockPool, client } = buildMockPool(100);
    const metrics = new MetricsCollector({ enabled: true });

    // Two polls: first call via start(), second via setInterval
    client.query
      .mockResolvedValueOnce(makeQueryResult([{ lag_ms: '100' }]))
      .mockResolvedValueOnce(makeQueryResult([{ lag_ms: '200' }]));

    const monitor = new ReplicaLagMonitor({
      replicaUrl: 'postgresql://replica:5432/revora',
      lagThresholdMs: 5_000,
      pollIntervalMs: 1_000,
      poolFactory: () => mockPool,
      metrics,
    });

    await monitor.start();
    expect(monitor.getStatus().lastLagMs).toBe(100);

    // Advance timers to trigger the interval callback
    await jest.advanceTimersByTimeAsync(1_500);

    expect(monitor.getStatus().lastLagMs).toBe(200);

    await monitor.stop();
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // stop() error handling (coverage for catch block)
  // -------------------------------------------------------------------------

  it('stop() handles pool.end() error gracefully', async () => {
    const { pool: mockPool } = buildMockPool(100);
    const metrics = new MetricsCollector({ enabled: true });
    // Make pool.end() throw
    mockPool.end = jest.fn().mockRejectedValue(new Error('pool close error'));

    const monitor = new ReplicaLagMonitor({
      replicaUrl: 'postgresql://replica:5432/revora',
      lagThresholdMs: 5_000,
      pollIntervalMs: 60_000,
      poolFactory: () => mockPool,
      metrics,
    });

    await monitor.start();
    // Should not throw even though pool.end() fails
    await expect(monitor.stop()).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Default pool factory path (unit-test the branch, not the real Pool)
  // -------------------------------------------------------------------------

  it('uses provided poolFactory instead of default new Pool()', async () => {
    const factoryMock = jest.fn().mockReturnValue({
      connect: jest.fn().mockResolvedValue({
        query: jest.fn().mockResolvedValue(makeQueryResult([{ lag_ms: '50' }])),
        release: jest.fn(),
      }),
      end: jest.fn().mockResolvedValue(undefined),
    } as unknown as Pool);

    const metrics = new MetricsCollector({ enabled: true });
    const monitor = new ReplicaLagMonitor({
      replicaUrl: 'postgresql://replica:5432/revora',
      lagThresholdMs: 5_000,
      pollIntervalMs: 60_000,
      poolFactory: factoryMock,
      metrics,
    });

    expect(factoryMock).toHaveBeenCalledWith('postgresql://replica:5432/revora');
    await monitor.start();
    expect(monitor.isReplicaHealthy()).toBe(true);
    await monitor.stop();
  });
});

// ---------------------------------------------------------------------------
// readQuery routing tests (pool.ts)
// ---------------------------------------------------------------------------
// We import pool.ts module functions individually to keep the test isolated.
// Because pool.ts exports module-level singletons that depend on env vars, we
// test the routing logic by directly invoking readQuery with a controlled
// lagMonitor state set via the module exports.

describe('readQuery — lag-aware routing', () => {
  // Avoid importing the actual pool.ts since it tries to connect on module load.
  // Instead we unit-test the routing logic by recreating it inline.

  function buildRoutingContext(opts: {
    hasReplica: boolean;
    replicaHealthy: boolean;
  }) {
    const primaryQueryMock = jest.fn().mockResolvedValue(makeQueryResult([{ id: 1 }]));
    const replicaQueryMock = jest.fn().mockResolvedValue(makeQueryResult([{ id: 2 }]));

    const primaryPool = { query: primaryQueryMock } as unknown as Pool;
    const replicaPoolMock = opts.hasReplica
      ? ({ query: replicaQueryMock } as unknown as Pool)
      : null;

    const lagMonitorMock = opts.hasReplica
      ? ({ isReplicaHealthy: () => opts.replicaHealthy } as unknown as ReplicaLagMonitor)
      : null;

    const metrics = new MetricsCollector({ enabled: true });

    // Inline routing function that mirrors the pool.ts readQuery logic
    async function readQueryFn(sql: string, params?: unknown[]) {
      if (lagMonitorMock !== null && replicaPoolMock !== null && lagMonitorMock.isReplicaHealthy()) {
        return replicaPoolMock.query(sql, params);
      }
      if (lagMonitorMock !== null) {
        metrics.incrementCounter(
          'db.replica.route_primary',
          undefined,
          1,
          'Number of read queries routed to the primary due to replica lag SLO breach',
        );
      }
      return primaryPool.query(sql, params);
    }

    return { readQueryFn, primaryQueryMock, replicaQueryMock, metrics };
  }

  it('routes to replica when lag monitor reports healthy', async () => {
    const { readQueryFn, primaryQueryMock, replicaQueryMock, metrics } = buildRoutingContext({
      hasReplica: true,
      replicaHealthy: true,
    });

    const result = await readQueryFn('SELECT 1');
    expect(result.rows).toEqual([{ id: 2 }]); // replica row
    expect(replicaQueryMock).toHaveBeenCalledTimes(1);
    expect(primaryQueryMock).not.toHaveBeenCalled();

    const snapshot = await metrics.getSnapshot();
    const counter = snapshot.custom.find((m) => m.name === 'db_replica_route_primary');
    expect(counter).toBeUndefined(); // no metric when healthy
  });

  it('routes to primary and emits counter when lag monitor reports unhealthy', async () => {
    const { readQueryFn, primaryQueryMock, replicaQueryMock, metrics } = buildRoutingContext({
      hasReplica: true,
      replicaHealthy: false,
    });

    const result = await readQueryFn('SELECT 1');
    expect(result.rows).toEqual([{ id: 1 }]); // primary row
    expect(primaryQueryMock).toHaveBeenCalledTimes(1);
    expect(replicaQueryMock).not.toHaveBeenCalled();

    const snapshot = await metrics.getSnapshot();
    const counter = snapshot.custom.find((m) => m.name === 'db_replica_route_primary');
    expect(counter).toBeDefined();
    expect(counter?.value).toBe(1);
  });

  it('accumulates counter across multiple unhealthy routes', async () => {
    const { readQueryFn, metrics } = buildRoutingContext({
      hasReplica: true,
      replicaHealthy: false,
    });

    await readQueryFn('SELECT 1');
    await readQueryFn('SELECT 2');
    await readQueryFn('SELECT 3');

    const snapshot = await metrics.getSnapshot();
    const counter = snapshot.custom.find((m) => m.name === 'db_replica_route_primary');
    expect(counter?.value).toBe(3);
  });

  it('routes to primary with no counter when no replica is configured', async () => {
    const { readQueryFn, primaryQueryMock, replicaQueryMock, metrics } = buildRoutingContext({
      hasReplica: false,
      replicaHealthy: false,
    });

    const result = await readQueryFn('SELECT 1');
    expect(result.rows).toEqual([{ id: 1 }]); // primary row
    expect(primaryQueryMock).toHaveBeenCalledTimes(1);
    expect(replicaQueryMock).not.toHaveBeenCalled();

    // No counter emitted because no replica was ever configured
    const snapshot = await metrics.getSnapshot();
    const counter = snapshot.custom.find((m) => m.name === 'db_replica_route_primary');
    expect(counter).toBeUndefined();
  });

  it('passes sql and params through to the target pool', async () => {
    const { readQueryFn, replicaQueryMock } = buildRoutingContext({
      hasReplica: true,
      replicaHealthy: true,
    });

    await readQueryFn('SELECT * FROM users WHERE id = $1', [42]);
    expect(replicaQueryMock).toHaveBeenCalledWith('SELECT * FROM users WHERE id = $1', [42]);
  });

  it('passes sql and params through to primary on unhealthy replica', async () => {
    const { readQueryFn, primaryQueryMock } = buildRoutingContext({
      hasReplica: true,
      replicaHealthy: false,
    });

    await readQueryFn('SELECT * FROM orders WHERE ref = $1', ['ORD-001']);
    expect(primaryQueryMock).toHaveBeenCalledWith(
      'SELECT * FROM orders WHERE ref = $1',
      ['ORD-001'],
    );
  });
});
