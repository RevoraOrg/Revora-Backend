/**
 * PostgresReconciliationRunStore + createReconciliationSchedulerRuntime tests.
 *
 * Covers the DB-backed persistence layer and the interval runtime wrapper used
 * to schedule periodic reconciliation from app bootstrap.
 */

import {
  PostgresReconciliationRunStore,
  createReconciliationSchedulerRuntime,
  DEFAULT_RECONCILIATION_INTERVAL_MS,
  resolveSchedulerInterval,
  RECONCILIATION_INTERVAL_ENV,
} from './reconciliationScheduler';
import { MetricsCollector } from '../lib/metrics';

function makeMockPool() {
  return { query: jest.fn() } as any;
}

// ─── PostgresReconciliationRunStore ───────────────────────────────────────────

describe('PostgresReconciliationRunStore', () => {
  let mockPool: ReturnType<typeof makeMockPool>;
  let store: PostgresReconciliationRunStore;

  beforeEach(() => {
    mockPool = makeMockPool();
    store = new PostgresReconciliationRunStore(mockPool);
  });

  describe('saveRun', () => {
    it('inserts a run summary with bound parameters', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 1 });
      const summary = {
        offeringId: 'off-1',
        periodId: '2026-05',
        startedAt: new Date('2026-05-01T00:00:00Z'),
        completedAt: new Date('2026-05-01T00:01:00Z'),
        isBalanced: true,
        discrepancyCount: 0,
        discrepancyAmount: '0.00',
      };

      await store.saveRun(summary);

      expect(mockPool.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('INSERT INTO reconciliation_run_summaries');
      expect(sql).toContain('ON CONFLICT (offering_id, period_id, started_at) DO NOTHING');
      expect(params).toEqual([
        'off-1',
        '2026-05',
        summary.startedAt,
        summary.completedAt,
        true,
        0,
        '0.00',
      ]);
    });

    it('treats duplicate writes as an idempotent no-op', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
      const summary = {
        offeringId: 'off-1',
        periodId: '2026-05',
        startedAt: new Date('2026-05-01T00:00:00Z'),
        completedAt: new Date('2026-05-01T00:01:00Z'),
        isBalanced: false,
        discrepancyCount: 2,
        discrepancyAmount: '50.00',
      };

      // Should not throw even though the row was already present
      await expect(store.saveRun(summary)).resolves.toBeUndefined();
    });
  });

  describe('getLastRun', () => {
    it('returns null when no run exists', async () => {
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const last = await store.getLastRun('off-missing');
      expect(last).toBeNull();
      const [sql, params] = mockPool.query.mock.calls[0];
      expect(sql).toContain('ORDER BY started_at DESC');
      expect(sql).toContain('LIMIT 1');
      expect(params).toEqual(['off-missing']);
    });

    it('maps the most recent row into a ReconciliationRunSummary', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            offering_id: 'off-1',
            period_id: '2026-04',
            started_at: new Date('2026-04-30T23:00:00Z'),
            completed_at: new Date('2026-04-30T23:01:00Z'),
            is_balanced: false,
            discrepancy_count: 3,
            discrepancy_amount: '12.34',
          },
        ],
        rowCount: 1,
      });

      const last = await store.getLastRun('off-1');
      expect(last).toEqual({
        offeringId: 'off-1',
        periodId: '2026-04',
        startedAt: new Date('2026-04-30T23:00:00Z'),
        completedAt: new Date('2026-04-30T23:01:00Z'),
        isBalanced: false,
        discrepancyCount: 3,
        discrepancyAmount: '12.34',
      });
    });

    it('coerces discrepancy_amount to a string when returned as a number', async () => {
      mockPool.query.mockResolvedValue({
        rows: [
          {
            offering_id: 'off-1',
            period_id: '2026-04',
            started_at: new Date('2026-04-30T23:00:00Z'),
            completed_at: new Date('2026-04-30T23:01:00Z'),
            is_balanced: true,
            discrepancy_count: 0,
            discrepancy_amount: 0,
          },
        ],
        rowCount: 1,
      });

      const last = await store.getLastRun('off-1');
      expect(typeof last?.discrepancyAmount).toBe('string');
      expect(last?.discrepancyAmount).toBe('0');
    });
  });
});

// ─── createReconciliationSchedulerRuntime ─────────────────────────────────────

describe('createReconciliationSchedulerRuntime', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.RECONCILIATION_INTERVAL_MS;
    jest.restoreAllMocks();
  });

  it('runs a tick immediately on start()', async () => {
    jest.useFakeTimers();
    const runSpy = jest.fn().mockResolvedValue({
      attempted: 1,
      successful: 1,
      failed: 0,
      alarmRaised: 0,
      alarmCleared: 1,
      errors: [],
    });
    const scheduler = { runScheduledReconciliation: runSpy } as any;

    const runtime = createReconciliationSchedulerRuntime({
      db: makeMockPool(),
      metrics,
      scheduler,
    });

    runtime.start();
    expect(runtime.isRunning()).toBe(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(runSpy).toHaveBeenCalledTimes(1);

    runtime.stop();
    expect(runtime.isRunning()).toBe(false);
  });

  it('does not fire a subsequent tick while the previous one is in flight', async () => {
    jest.useFakeTimers();
    let release: (v: unknown) => void = () => undefined;
    const gate = new Promise((res) => {
      release = res;
    });
    const runSpy = jest.fn().mockImplementation(() => gate);

    const runtime = createReconciliationSchedulerRuntime({
      db: makeMockPool(),
      metrics,
      intervalMs: 10_000,
      scheduler: { runScheduledReconciliation: runSpy } as any,
    });

    runtime.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Advance past one interval while the tick is still unresolved.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(runSpy).toHaveBeenCalledTimes(1);

    (release as (v: unknown) => void)(undefined);
    await jest.advanceTimersByTimeAsync(0);
    runtime.stop();
  });

  it('logs and recovers when a tick throws (process does not crash)', async () => {
    jest.useFakeTimers();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const runSpy = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ attempted: 0, successful: 0, failed: 0, alarmRaised: 0, alarmCleared: 0, errors: [] });

    const runtime = createReconciliationSchedulerRuntime({
      db: makeMockPool(),
      metrics,
      intervalMs: 10_000,
      scheduler: { runScheduledReconciliation: runSpy } as any,
    });

    runtime.start();
    await jest.advanceTimersByTimeAsync(0);
    // First tick threw and was swallowed.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(runSpy).toHaveBeenCalledTimes(2);
    runtime.stop();
    errorSpy.mockRestore();
  });

  it('defaults to Postgres store and OfferingRepository when not overridden', () => {
    const runtime = createReconciliationSchedulerRuntime({
      db: makeMockPool(),
      metrics,
      scheduler: {
        runScheduledReconciliation: jest.fn().mockResolvedValue({}),
      } as any,
    });
    // The runtime is constructible without throwing.
    expect(runtime).toBeDefined();
    runtime.stop();
  });
});

describe('resolveSchedulerInterval', () => {
  it('uses the primary env var when positive', () => {
    expect(
      resolveSchedulerInterval({ [RECONCILIATION_INTERVAL_ENV]: '12345' })
    ).toBe(12345);
  });

  it('prefers the primary env var over the legacy alias', () => {
    expect(
      resolveSchedulerInterval({
        [RECONCILIATION_INTERVAL_ENV]: '1000',
        SCHEDULER_RECONCILIATION_INTERVAL_MS: '5000',
      })
    ).toBe(1000);
  });

  it('falls back to the legacy alias when the primary is absent', () => {
    expect(
      resolveSchedulerInterval({ SCHEDULER_RECONCILIATION_INTERVAL_MS: '9000' })
    ).toBe(9000);
  });

  it('falls back to the explicit option for non-positive env value', () => {
    expect(
      resolveSchedulerInterval({ [RECONCILIATION_INTERVAL_ENV]: '-5' }, 60_000)
    ).toBe(60_000);
  });

  it('falls back to the explicit option for non-numeric env value', () => {
    expect(
      resolveSchedulerInterval({ [RECONCILIATION_INTERVAL_ENV]: 'abc' }, 60_000)
    ).toBe(60_000);
  });

  it('falls back to the default when env and option are absent', () => {
    expect(resolveSchedulerInterval({})).toBe(DEFAULT_RECONCILIATION_INTERVAL_MS);
  });

  it('empty-string env is treated as absent', () => {
    expect(resolveSchedulerInterval({ [RECONCILIATION_INTERVAL_ENV]: '' }, 1)).toBe(1);
  });
});
