/**
 * ReconciliationScheduler unit tests
 *
 * Coverage targets (aligned with ≥ 95 % requirement):
 * ┌─────────────────────────────────────────────────────────────┬────────┐
 * │ Scenario                                                    │ tested │
 * ├─────────────────────────────────────────────────────────────┼────────┤
 * │ Per-offering cadence: every active offering reconciled      │   ✓    │
 * │ Inactive offerings skipped                                  │   ✓    │
 * │ Missed-run resume: period starts from last run completedAt  │   ✓    │
 * │ No prior run: period starts from lookbackMs ago             │   ✓    │
 * │ Alarm raised when run is imbalanced                         │   ✓    │
 * │ Alarm clears on subsequent balanced run                     │   ✓    │
 * │ Cardinality cap: overflow label for offerings > cap         │   ✓    │
 * │ Failed reconciliation raises alarm, recorded as error       │   ✓    │
 * │ Run summary persisted with correct fields                   │   ✓    │
 * │ Counter incremented only when discrepancies exist           │   ✓    │
 * │ Balanced run does NOT increment discrepancy counter         │   ✓    │
 * │ Multiple offerings: independent alarm/counter per label     │   ✓    │
 * └─────────────────────────────────────────────────────────────┴────────┘
 */

import {
  ReconciliationScheduler,
  InMemoryReconciliationRunStore,
  ReconciliationRunSummary,
  SchedulerOffering,
} from './reconciliationScheduler';
import { MetricsCollector } from '../lib/metrics';
import { ReconciliationResult } from './revenueReconciliationService';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal balanced ReconciliationResult. */
function balancedResult(offeringId: string): ReconciliationResult {
  return {
    offeringId,
    periodStart: new Date('2026-04-01'),
    periodEnd: new Date('2026-04-30'),
    isBalanced: true,
    discrepancies: [],
    summary: {
      totalRevenueReported: '1000.00',
      totalPayouts: '1000.00',
      discrepancyAmount: '0.00',
      investorCount: 5,
      payoutsProcessed: 5,
      payoutsFailed: 0,
    },
    checkedAt: new Date(),
  };
}

/** Build an imbalanced ReconciliationResult with one discrepancy. */
function imbalancedResult(offeringId: string): ReconciliationResult {
  return {
    offeringId,
    periodStart: new Date('2026-04-01'),
    periodEnd: new Date('2026-04-30'),
    isBalanced: false,
    discrepancies: [
      {
        type: 'REVENUE_MISMATCH',
        severity: 'error',
        message: 'Revenue mismatch',
        details: {},
        offeringId,
      },
    ],
    summary: {
      totalRevenueReported: '1000.00',
      totalPayouts: '950.00',
      discrepancyAmount: '50.00',
      investorCount: 5,
      payoutsProcessed: 4,
      payoutsFailed: 1,
    },
    checkedAt: new Date(),
  };
}

/** Minimal mock RevenueReconciliationService. */
function makeService(
  impl: (
    offeringId: string,
    periodStart: Date,
    periodEnd: Date
  ) => Promise<ReconciliationResult> = async (id) => balancedResult(id)
) {
  return { reconcile: jest.fn(impl) } as any;
}

/** Minimal mock OfferingRepository. */
function makeOfferingRepo(offerings: SchedulerOffering[]) {
  return { listAll: jest.fn().mockResolvedValue(offerings) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReconciliationScheduler', () => {
  let metrics: MetricsCollector;
  let store: InMemoryReconciliationRunStore;

  beforeEach(() => {
    // Disable PII detection so offering-id short labels pass through unredacted.
    metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    store = new InMemoryReconciliationRunStore();
  });

  // ── Per-offering cadence ────────────────────────────────────────────────────

  describe('per-offering cadence', () => {
    it('reconciles every active offering in a single tick', async () => {
      const offerings: SchedulerOffering[] = [
        { id: 'aaaa0000-0000-0000-0000-000000000001', status: 'active' },
        { id: 'bbbb0000-0000-0000-0000-000000000002', status: 'open' },
        { id: 'cccc0000-0000-0000-0000-000000000003', status: 'closed' },
      ];
      const service = makeService();
      const scheduler = new ReconciliationScheduler(
        service,
        makeOfferingRepo(offerings),
        store,
        metrics
      );

      const result = await scheduler.runScheduledReconciliation();

      expect(result.attempted).toBe(3);
      expect(result.successful).toBe(3);
      expect(result.failed).toBe(0);
      expect(service.reconcile).toHaveBeenCalledTimes(3);
    });

    it('skips offerings whose status is not active-like', async () => {
      const offerings: SchedulerOffering[] = [
        { id: 'aaaa0000-0000-0000-0000-000000000001', status: 'active' },
        { id: 'dddd0000-0000-0000-0000-000000000004', status: 'draft' },
        { id: 'eeee0000-0000-0000-0000-000000000005', status: 'cancelled' },
      ];
      const service = makeService();
      const scheduler = new ReconciliationScheduler(
        service,
        makeOfferingRepo(offerings),
        store,
        metrics
      );

      const result = await scheduler.runScheduledReconciliation();

      expect(result.attempted).toBe(1);
      expect(service.reconcile).toHaveBeenCalledTimes(1);
      expect(service.reconcile).toHaveBeenCalledWith(
        'aaaa0000-0000-0000-0000-000000000001',
        expect.any(Date),
        expect.any(Date),
        expect.any(Object)
      );
    });

    it('treats offerings with no status field as active', async () => {
      const offerings: SchedulerOffering[] = [
        { id: 'aaaa0000-0000-0000-0000-000000000001' }, // no status
      ];
      const service = makeService();
      const scheduler = new ReconciliationScheduler(
        service,
        makeOfferingRepo(offerings),
        store,
        metrics
      );

      const result = await scheduler.runScheduledReconciliation();
      expect(result.attempted).toBe(1);
      expect(service.reconcile).toHaveBeenCalledTimes(1);
    });

    it('persists a run summary for each reconciled offering', async () => {
      const offerings: SchedulerOffering[] = [
        { id: 'aaaa0000-0000-0000-0000-000000000001', status: 'active' },
        { id: 'bbbb0000-0000-0000-0000-000000000002', status: 'active' },
      ];
      const scheduler = new ReconciliationScheduler(
        makeService(),
        makeOfferingRepo(offerings),
        store,
        metrics
      );

      await scheduler.runScheduledReconciliation();

      const runs = store.getAllRuns();
      expect(runs).toHaveLength(2);
      const ids = runs.map((r) => r.offeringId).sort();
      expect(ids).toEqual([
        'aaaa0000-0000-0000-0000-000000000001',
        'bbbb0000-0000-0000-0000-000000000002',
      ]);
    });
  });

  // ── Missed-run resume ───────────────────────────────────────────────────────

  describe('missed-run resume', () => {
    it('uses last run completedAt as the new period start (no gap)', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const pastCompletedAt = new Date('2026-03-01T12:00:00Z');

      // Seed a previous run
      await store.saveRun({
        offeringId,
        periodId: '2026-02',
        startedAt: new Date('2026-03-01T11:59:00Z'),
        completedAt: pastCompletedAt,
        isBalanced: true,
        discrepancyCount: 0,
        discrepancyAmount: '0.00',
      });

      const service = makeService();
      const scheduler = new ReconciliationScheduler(
        service,
        makeOfferingRepo([{ id: offeringId, status: 'active' }]),
        store,
        metrics
      );

      await scheduler.runScheduledReconciliation();

      // The period start forwarded to reconcile() must be the previous completedAt
      const [, periodStartArg] = service.reconcile.mock.calls[0];
      expect((periodStartArg as Date).getTime()).toBe(pastCompletedAt.getTime());
    });

    it('uses lookbackMs when no previous run exists', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const lookbackMs = 7 * 24 * 60 * 60 * 1000; // 7 days

      const service = makeService();
      const scheduler = new ReconciliationScheduler(
        service,
        makeOfferingRepo([{ id: offeringId, status: 'active' }]),
        store,
        metrics,
        { lookbackMs }
      );

      const before = Date.now();
      await scheduler.runScheduledReconciliation();
      const after = Date.now();

      const [, periodStartArg, periodEndArg] = service.reconcile.mock.calls[0];
      const start = (periodStartArg as Date).getTime();
      const end = (periodEndArg as Date).getTime();

      // period end ≈ now
      expect(end).toBeGreaterThanOrEqual(before);
      expect(end).toBeLessThanOrEqual(after);
      // period start ≈ now - lookbackMs
      expect(start).toBeGreaterThanOrEqual(before - lookbackMs - 100);
      expect(start).toBeLessThanOrEqual(after - lookbackMs + 100);
    });

    it('correctly advances the window on a second tick (no overlapping period)', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const service = makeService();
      const scheduler = new ReconciliationScheduler(
        service,
        makeOfferingRepo([{ id: offeringId, status: 'active' }]),
        store,
        metrics,
        { lookbackMs: 30 * 24 * 60 * 60 * 1000 }
      );

      // First tick
      await scheduler.runScheduledReconciliation();
      const [, , firstEnd] = service.reconcile.mock.calls[0];

      // Second tick
      await scheduler.runScheduledReconciliation();
      const [, secondStart] = service.reconcile.mock.calls[1];

      // Second window must start no earlier than the first window's end
      expect((secondStart as Date).getTime()).toBeGreaterThanOrEqual(
        (firstEnd as Date).getTime() - 100 // small clock skew tolerance
      );
    });
  });

  // ── Alarm semantics ─────────────────────────────────────────────────────────

  describe('alarm semantics', () => {
    it('sets reconciliation_alarm_open=1 when a run is imbalanced', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const scheduler = new ReconciliationScheduler(
        makeService(async (id) => imbalancedResult(id)),
        makeOfferingRepo([{ id: offeringId, status: 'active' }]),
        store,
        metrics
      );

      const result = await scheduler.runScheduledReconciliation();

      expect(result.alarmRaised).toBe(1);
      expect(result.alarmCleared).toBe(0);

      const snapshot = await metrics.getSnapshot();
      const alarmPoint = snapshot.custom.find(
        (p) => p.name === 'reconciliation_alarm_open'
      );
      expect(alarmPoint?.value).toBe(1);
    });

    it('sets reconciliation_alarm_open=0 on a subsequent balanced run (alarm clears)', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const offering = [{ id: offeringId, status: 'active' }];

      // Tick 1: imbalanced → alarm opens
      const scheduler1 = new ReconciliationScheduler(
        makeService(async (id) => imbalancedResult(id)),
        makeOfferingRepo(offering),
        store,
        metrics
      );
      await scheduler1.runScheduledReconciliation();

      // Tick 2: balanced → alarm clears
      const scheduler2 = new ReconciliationScheduler(
        makeService(async (id) => balancedResult(id)),
        makeOfferingRepo(offering),
        store,
        metrics
      );
      const result2 = await scheduler2.runScheduledReconciliation();

      expect(result2.alarmRaised).toBe(0);
      expect(result2.alarmCleared).toBe(1);

      const snapshot = await metrics.getSnapshot();
      const alarmPoint = snapshot.custom.find(
        (p) => p.name === 'reconciliation_alarm_open'
      );
      expect(alarmPoint?.value).toBe(0);
    });

    it('does not raise alarm when run is balanced from the start', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const scheduler = new ReconciliationScheduler(
        makeService(async (id) => balancedResult(id)),
        makeOfferingRepo([{ id: offeringId, status: 'active' }]),
        store,
        metrics
      );

      const result = await scheduler.runScheduledReconciliation();

      expect(result.alarmRaised).toBe(0);
      expect(result.alarmCleared).toBe(1);
    });

    it('raises alarm when reconcile() throws', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const service = {
        reconcile: jest.fn().mockRejectedValue(new Error('DB timeout')),
      } as any;
      const scheduler = new ReconciliationScheduler(
        service,
        makeOfferingRepo([{ id: offeringId, status: 'active' }]),
        store,
        metrics
      );

      const result = await scheduler.runScheduledReconciliation();

      expect(result.failed).toBe(1);
      expect(result.alarmRaised).toBe(1);
      expect(result.errors[0].error).toContain('DB timeout');

      const snapshot = await metrics.getSnapshot();
      const alarmPoint = snapshot.custom.find(
        (p) => p.name === 'reconciliation_alarm_open'
      );
      expect(alarmPoint?.value).toBe(1);
    });

    it('maintains separate alarm state per offering', async () => {
      const offerings: SchedulerOffering[] = [
        { id: 'aaaa0000-0000-0000-0000-000000000001', status: 'active' },
        { id: 'bbbb0000-0000-0000-0000-000000000002', status: 'active' },
      ];

      // aaaa → imbalanced, bbbb → balanced
      const service = makeService(async (id) =>
        id.startsWith('aaaa') ? imbalancedResult(id) : balancedResult(id)
      );
      const scheduler = new ReconciliationScheduler(
        service,
        makeOfferingRepo(offerings),
        store,
        metrics
      );

      const result = await scheduler.runScheduledReconciliation();

      expect(result.alarmRaised).toBe(1);
      expect(result.alarmCleared).toBe(1);
    });
  });

  // ── Metrics counters ────────────────────────────────────────────────────────

  describe('reconciliation_discrepancy_total counter', () => {
    it('increments by discrepancy count when discrepancies found', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const scheduler = new ReconciliationScheduler(
        makeService(async (id) => imbalancedResult(id)),
        makeOfferingRepo([{ id: offeringId, status: 'active' }]),
        store,
        metrics
      );

      await scheduler.runScheduledReconciliation();

      const snapshot = await metrics.getSnapshot();
      const counter = snapshot.custom.find(
        (p) => p.name === 'reconciliation_discrepancy_total'
      );
      // imbalancedResult() produces 1 discrepancy
      expect(counter?.value).toBe(1);
    });

    it('does NOT increment the counter when run is balanced', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const scheduler = new ReconciliationScheduler(
        makeService(async (id) => balancedResult(id)),
        makeOfferingRepo([{ id: offeringId, status: 'active' }]),
        store,
        metrics
      );

      await scheduler.runScheduledReconciliation();

      const snapshot = await metrics.getSnapshot();
      const counter = snapshot.custom.find(
        (p) => p.name === 'reconciliation_discrepancy_total'
      );
      expect(counter).toBeUndefined();
    });

    it('accumulates across multiple imbalanced ticks', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const offering = [{ id: offeringId, status: 'active' }];

      for (let i = 0; i < 3; i++) {
        const scheduler = new ReconciliationScheduler(
          makeService(async (id) => imbalancedResult(id)),
          makeOfferingRepo(offering),
          store,
          metrics
        );
        await scheduler.runScheduledReconciliation();
      }

      const snapshot = await metrics.getSnapshot();
      const counter = snapshot.custom.find(
        (p) => p.name === 'reconciliation_discrepancy_total'
      );
      // 1 discrepancy × 3 ticks = 3
      expect(counter?.value).toBe(3);
    });
  });

  // ── Cardinality cap ─────────────────────────────────────────────────────────

  describe('cardinality cap', () => {
    it('labels offerings beyond the cap as "overflow"', async () => {
      const cardinalityLimit = 2;
      // 4 offerings — first 2 get individual labels, last 2 go to "overflow"
      const offerings: SchedulerOffering[] = [
        { id: 'aaaa0000-0000-0000-0000-000000000001', status: 'active' },
        { id: 'bbbb0000-0000-0000-0000-000000000002', status: 'active' },
        { id: 'cccc0000-0000-0000-0000-000000000003', status: 'active' },
        { id: 'dddd0000-0000-0000-0000-000000000004', status: 'active' },
      ];

      // Make all runs imbalanced so we can detect which labels were emitted
      const scheduler = new ReconciliationScheduler(
        makeService(async (id) => imbalancedResult(id)),
        makeOfferingRepo(offerings),
        store,
        metrics,
        { cardinalityLimit }
      );

      await scheduler.runScheduledReconciliation();

      const snapshot = await metrics.getSnapshot();
      const alarmPoints = snapshot.custom.filter(
        (p) => p.name === 'reconciliation_alarm_open'
      );

      const labels = alarmPoints.map((p) => p.labels?.offering_id).sort();
      // "aaaa" and "bbbb" are within cap; cccc and dddd → "overflow"
      // Note: two offerings share "overflow" so only one gauge entry for "overflow"
      expect(labels).toContain('aaaa0000');
      expect(labels).toContain('bbbb0000');
      expect(labels).toContain('overflow');
      expect(labels).not.toContain('cccc0000');
      expect(labels).not.toContain('dddd0000');
    });

    it('correctly uses the first UUID segment as the short label', async () => {
      const offeringId = 'abcd1234-5678-0000-0000-000000000001';
      const scheduler = new ReconciliationScheduler(
        makeService(async (id) => imbalancedResult(id)),
        makeOfferingRepo([{ id: offeringId, status: 'active' }]),
        store,
        metrics,
        { cardinalityLimit: 10 }
      );

      await scheduler.runScheduledReconciliation();

      const snapshot = await metrics.getSnapshot();
      const alarmPoint = snapshot.custom.find(
        (p) => p.name === 'reconciliation_alarm_open'
      );
      // Short label = first segment of UUID = "abcd1234"
      expect(alarmPoint?.labels?.offering_id).toBe('abcd1234');
    });
  });

  // ── Run summary persistence ──────────────────────────────────────────────────

  describe('InMemoryReconciliationRunStore', () => {
    it('saves and retrieves the most recent run for an offering', async () => {
      const summary1: ReconciliationRunSummary = {
        offeringId: 'off-1',
        periodId: '2026-03',
        startedAt: new Date('2026-03-31T23:00:00Z'),
        completedAt: new Date('2026-03-31T23:01:00Z'),
        isBalanced: true,
        discrepancyCount: 0,
        discrepancyAmount: '0.00',
      };
      const summary2: ReconciliationRunSummary = {
        ...summary1,
        periodId: '2026-04',
        startedAt: new Date('2026-04-30T23:00:00Z'),
        completedAt: new Date('2026-04-30T23:01:00Z'),
        isBalanced: false,
        discrepancyCount: 2,
        discrepancyAmount: '50.00',
      };

      await store.saveRun(summary1);
      await store.saveRun(summary2);

      const last = await store.getLastRun('off-1');
      expect(last?.periodId).toBe('2026-04');
      expect(last?.isBalanced).toBe(false);
    });

    it('returns null when no run exists for the offering', async () => {
      const last = await store.getLastRun('nonexistent-offering');
      expect(last).toBeNull();
    });

    it('does not overwrite a newer run with an older one', async () => {
      const newerRun: ReconciliationRunSummary = {
        offeringId: 'off-1',
        periodId: '2026-05',
        startedAt: new Date('2026-05-31T00:00:00Z'),
        completedAt: new Date('2026-05-31T00:01:00Z'),
        isBalanced: true,
        discrepancyCount: 0,
        discrepancyAmount: '0.00',
      };
      const olderRun: ReconciliationRunSummary = {
        ...newerRun,
        periodId: '2026-04',
        startedAt: new Date('2026-04-30T00:00:00Z'),
        completedAt: new Date('2026-04-30T00:01:00Z'),
      };

      await store.saveRun(newerRun);
      await store.saveRun(olderRun); // should not overwrite

      const last = await store.getLastRun('off-1');
      expect(last?.periodId).toBe('2026-05');
    });

    it('handles independent runs for different offerings', async () => {
      const runA: ReconciliationRunSummary = {
        offeringId: 'off-A',
        periodId: '2026-05',
        startedAt: new Date('2026-05-31T00:00:00Z'),
        completedAt: new Date('2026-05-31T00:01:00Z'),
        isBalanced: false,
        discrepancyCount: 1,
        discrepancyAmount: '10.00',
      };
      const runB: ReconciliationRunSummary = {
        ...runA,
        offeringId: 'off-B',
        isBalanced: true,
        discrepancyCount: 0,
        discrepancyAmount: '0.00',
      };

      await store.saveRun(runA);
      await store.saveRun(runB);

      const lastA = await store.getLastRun('off-A');
      const lastB = await store.getLastRun('off-B');

      expect(lastA?.isBalanced).toBe(false);
      expect(lastB?.isBalanced).toBe(true);
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles an empty offering list gracefully', async () => {
      const scheduler = new ReconciliationScheduler(
        makeService(),
        makeOfferingRepo([]),
        store,
        metrics
      );

      const result = await scheduler.runScheduledReconciliation();
      expect(result.attempted).toBe(0);
      expect(result.successful).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('continues processing other offerings when one fails', async () => {
      const offerings: SchedulerOffering[] = [
        { id: 'aaaa0000-0000-0000-0000-000000000001', status: 'active' },
        { id: 'bbbb0000-0000-0000-0000-000000000002', status: 'active' },
      ];

      const service = makeService(async (id) => {
        if (id.startsWith('aaaa')) throw new Error('RPC timeout');
        return balancedResult(id);
      });

      const scheduler = new ReconciliationScheduler(
        service,
        makeOfferingRepo(offerings),
        store,
        metrics
      );

      const result = await scheduler.runScheduledReconciliation();

      expect(result.attempted).toBe(2);
      expect(result.successful).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].offeringId).toBe('aaaa0000-0000-0000-0000-000000000001');
    });

    it('forwards the configured tolerance to reconciliationService.reconcile()', async () => {
      const offeringId = 'aaaa0000-0000-0000-0000-000000000001';
      const service = makeService();
      const customTolerance = 0.001;

      const scheduler = new ReconciliationScheduler(
        service,
        makeOfferingRepo([{ id: offeringId, status: 'active' }]),
        store,
        metrics,
        { tolerance: customTolerance }
      );

      await scheduler.runScheduledReconciliation();

      const [, , , opts] = service.reconcile.mock.calls[0];
      expect((opts as any).tolerance).toBe(customTolerance);
    });
  });
});
