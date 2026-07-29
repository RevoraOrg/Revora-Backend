/**
 * ReconciliationScheduler
 *
 * Runs RevenueReconciliationService.reconcile() on a scheduled cadence for every
 * active offering. Persists each run summary, emits Prometheus-compatible metrics,
 * and raises/clears a dead-letter alarm gauge when discrepancies breach the
 * configured tolerance.
 *
 * @see ../../docs/architecture/distribution-reconciliation.md
 *      End-to-end architecture map (sequence diagram + state machine).
 * @see ../docs/prometheus-metrics-endpoint.md
 * @see ../docs/metrics-and-logging-baseline.md
 *
 * Metric naming
 * ─────────────
 * reconciliation_discrepancy_total  counter  {offering_id}  Running sum of
 *   discrepancies detected across all scheduler-triggered runs for an offering.
 *
 * reconciliation_alarm_open         gauge    {offering_id}  1 while the latest
 *   run found imbalanced results, 0 once a subsequent balanced run clears it.
 *
 * Cardinality cap
 * ───────────────
 * Only the first `cardinalityLimit` (default 50) offerings receive individual
 * labels. Overflow offerings are bucketed under offering_id="overflow" to keep
 * total time-series count bounded and respect MetricsCollector's maxCardinality.
 *
 * Alarm semantics
 * ───────────────
 * An alarm opens (gauge → 1) when a run's reconciliation result is NOT balanced.
 * It clears automatically (gauge → 0) the first time a subsequent run for that
 * same offering IS balanced. No manual intervention required.
 */

import { Logger, globalLogger } from '../lib/logger';
import { MetricsCollector } from '../lib/metrics';
import {
  RevenueReconciliationService,
  ReconciliationResult,
} from './revenueReconciliationService';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal offering shape the scheduler needs. */
export interface SchedulerOffering {
  id: string;
  status?: string;
}

/** Repository interface for active-offering discovery. */
export interface ActiveOfferingRepository {
  listAll(): Promise<SchedulerOffering[]>;
}

/** Persisted record of a single scheduler-triggered reconciliation run. */
export interface ReconciliationRunSummary {
  offeringId: string;
  /** Opaque period identifier, e.g. ISO-month "2026-05" or UUID of revenue report. */
  periodId: string;
  startedAt: Date;
  completedAt: Date;
  isBalanced: boolean;
  discrepancyCount: number;
  discrepancyAmount: string;
}

/** Storage interface for run summaries (keyed by offeringId + periodId + startedAt). */
export interface ReconciliationRunStore {
  saveRun(summary: ReconciliationRunSummary): Promise<void>;
  getLastRun(offeringId: string): Promise<ReconciliationRunSummary | null>;
}

export interface ReconciliationSchedulerOptions {
  /**
   * How far back from "now" to open the reconciliation window on each scheduled
   * tick when no previous run exists. Default: 30 days.
   */
  lookbackMs?: number;
  /** Discrepancy tolerance forwarded to RevenueReconciliationService. Default: 0.01. */
  tolerance?: number;
  /**
   * Maximum number of offerings that receive individually-labelled metrics.
   * Offerings beyond this cap are counted under offering_id="overflow".
   * Default: 50.
   */
  cardinalityLimit?: number;
  logger?: Logger;
}

export interface SchedulerRunResult {
  attempted: number;
  successful: number;
  failed: number;
  alarmRaised: number;
  alarmCleared: number;
  errors: Array<{ offeringId: string; error: string }>;
}

// ─── Statuses considered "active" for scheduling purposes ─────────────────────
const ACTIVE_STATUSES = new Set(['open', 'active', 'processing', 'closed']);

// ─── Metric names ─────────────────────────────────────────────────────────────
const METRIC_DISCREPANCY_TOTAL = 'reconciliation_discrepancy_total';
const METRIC_ALARM_OPEN = 'reconciliation_alarm_open';

// ─── ReconciliationScheduler ──────────────────────────────────────────────────

export class ReconciliationScheduler {
  private readonly lookbackMs: number;
  private readonly tolerance: number;
  private readonly cardinalityLimit: number;
  private readonly logger: Logger;

  constructor(
    private readonly reconciliationService: RevenueReconciliationService,
    private readonly offeringRepo: ActiveOfferingRepository,
    private readonly runStore: ReconciliationRunStore,
    private readonly metrics: MetricsCollector,
    options: ReconciliationSchedulerOptions = {}
  ) {
    this.lookbackMs = options.lookbackMs ?? 30 * 24 * 60 * 60 * 1000;
    this.tolerance = options.tolerance ?? 0.01;
    this.cardinalityLimit = options.cardinalityLimit ?? 50;
    this.logger = options.logger ?? globalLogger;
  }

  /**
   * Run one reconciliation tick across all active offerings.
   *
   * Called by a cron or interval mechanism (e.g. node-cron, setInterval).
   * Safe to call concurrently — each offering is processed sequentially within
   * a single tick, so there are no inter-call races for the same offering.
   */
  async runScheduledReconciliation(): Promise<SchedulerRunResult> {
    this.logger.info('ReconciliationScheduler: starting scheduled tick');

    const allOfferings = await this.offeringRepo.listAll();
    const active = allOfferings.filter(
      (o) => !o.status || ACTIVE_STATUSES.has(o.status)
    );

    this.logger.info(
      `ReconciliationScheduler: ${active.length} active offering(s) to reconcile`
    );

    const result: SchedulerRunResult = {
      attempted: active.length,
      successful: 0,
      failed: 0,
      alarmRaised: 0,
      alarmCleared: 0,
      errors: [],
    };

    for (let idx = 0; idx < active.length; idx++) {
      const offering = active[idx];
      // Label for metrics — use first segment of UUID to stay below PII threshold
      // while still being identifiable in dashboards; overflow if above cap.
      const metricLabel =
        idx < this.cardinalityLimit
          ? this.shortLabel(offering.id)
          : 'overflow';

      try {
        const { periodStart, periodEnd } = await this.determinePeriod(offering.id);
        const startedAt = new Date();

        this.logger.info('ReconciliationScheduler: reconciling offering', {
          offeringId: offering.id,
          periodStart,
          periodEnd,
        });

        const reconcileResult = await this.reconciliationService.reconcile(
          offering.id,
          periodStart,
          periodEnd,
          { tolerance: this.tolerance }
        );

        const completedAt = new Date();

        // Persist run summary
        const summary: ReconciliationRunSummary = {
          offeringId: offering.id,
          periodId: this.periodId(periodStart),
          startedAt,
          completedAt,
          isBalanced: reconcileResult.isBalanced,
          discrepancyCount: reconcileResult.discrepancies.length,
          discrepancyAmount: reconcileResult.summary.discrepancyAmount,
        };
        await this.runStore.saveRun(summary);

        // Emit metrics
        this.emitMetrics(metricLabel, reconcileResult, result);

        result.successful++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('ReconciliationScheduler: offering run failed', {
          offeringId: offering.id,
          error: message,
        });
        result.failed++;
        result.errors.push({ offeringId: offering.id, error: message });

        // Keep alarm open (or raise it) if this run errored — treat an error as
        // an unresolved discrepancy so the dead-letter alarm fires.
        this.metrics.setGauge(
          METRIC_ALARM_OPEN,
          1,
          { offering_id: metricLabel },
          'Dead-letter alarm: 1 when reconciliation found discrepancies or errored'
        );
        result.alarmRaised++;
      }
    }

    this.logger.info('ReconciliationScheduler: tick complete', result);
    return result;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Determine the reconciliation window for an offering.
   *
   * If a previous run exists the window starts from that run's completedAt
   * timestamp (so no gaps between runs — "missed run resumes").
   * Otherwise the window starts `lookbackMs` ago.
   */
  private async determinePeriod(
    offeringId: string
  ): Promise<{ periodStart: Date; periodEnd: Date }> {
    const lastRun = await this.runStore.getLastRun(offeringId);
    const periodEnd = new Date();
    const periodStart = lastRun
      ? lastRun.completedAt
      : new Date(periodEnd.getTime() - this.lookbackMs);
    return { periodStart, periodEnd };
  }

  /** Emit reconciliation_discrepancy_total and reconciliation_alarm_open. */
  private emitMetrics(
    label: string,
    reconcileResult: ReconciliationResult,
    runResult: SchedulerRunResult
  ): void {
    const labels = { offering_id: label };

    if (reconcileResult.discrepancies.length > 0) {
      this.metrics.incrementCounter(
        METRIC_DISCREPANCY_TOTAL,
        labels,
        reconcileResult.discrepancies.length,
        'Total reconciliation discrepancies detected by the scheduled job'
      );
    }

    if (!reconcileResult.isBalanced) {
      // Open (or keep open) the dead-letter alarm.
      this.metrics.setGauge(
        METRIC_ALARM_OPEN,
        1,
        labels,
        'Dead-letter alarm: 1 when reconciliation found discrepancies or errored'
      );
      runResult.alarmRaised++;
    } else {
      // Clear the alarm — a balanced run always silences any prior alarm.
      this.metrics.setGauge(METRIC_ALARM_OPEN, 0, labels);
      runResult.alarmCleared++;
    }
  }

  /**
   * Produce a short, non-PII label from an offering ID.
   * Uses the first 8 hex characters of a UUID (before the first "-") so the
   * value does not match the full UUID regex that MetricsCollector filters out.
   */
  private shortLabel(offeringId: string): string {
    return offeringId.split('-')[0] ?? offeringId.slice(0, 8);
  }

  /** Stable period identifier from a Date (ISO-month precision). */
  private periodId(date: Date): string {
    return date.toISOString().slice(0, 7); // e.g. "2026-05"
  }
}

// ─── InMemoryReconciliationRunStore ───────────────────────────────────────────

/**
 * In-memory implementation of ReconciliationRunStore.
 * Suitable for tests and single-instance deployments. For multi-instance
 * production use, replace with the PostgreSQL-backed store driven by the
 * 013_create_reconciliation_run_summaries.sql migration.
 */
export class InMemoryReconciliationRunStore implements ReconciliationRunStore {
  // Key: offeringId → most-recent run summary
  private readonly store = new Map<string, ReconciliationRunSummary>();

  async saveRun(summary: ReconciliationRunSummary): Promise<void> {
    const existing = this.store.get(summary.offeringId);
    if (!existing || summary.startedAt >= existing.startedAt) {
      this.store.set(summary.offeringId, summary);
    }
  }

  async getLastRun(offeringId: string): Promise<ReconciliationRunSummary | null> {
    return this.store.get(offeringId) ?? null;
  }

  /** Exposed for testing / inspection. */
  getAllRuns(): ReconciliationRunSummary[] {
    return [...this.store.values()];
  }
}
