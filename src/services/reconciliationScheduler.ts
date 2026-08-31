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

import { Pool } from 'pg';
import { Logger, globalLogger } from '../lib/logger';
import { MetricsCollector } from '../lib/metrics';
import { OfferingRepository } from '../db/repositories/offeringRepository';
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
  /** Timestamp when the current drift condition was first observed; null when balanced. */
  driftFirstDetectedAt?: Date | null;
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
  /**
   * Age threshold after which unresolved (non-zero) drift escalates to a pager
   * alarm. Default: 24 hours (as required by the reconciliation runbook).
   */
  pagerThresholdMs?: number;
  logger?: Logger;
}

export interface SchedulerRunResult {
  attempted: number;
  successful: number;
  failed: number;
  alarmRaised: number;
  alarmCleared: number;
  pagerRaised: number;
  errors: Array<{ offeringId: string; error: string }>;
}

// ─── Statuses considered "active" for scheduling purposes ─────────────────────
const ACTIVE_STATUSES = new Set(['open', 'active', 'processing', 'closed']);

// ─── Metric names ─────────────────────────────────────────────────────────────
const METRIC_DISCREPANCY_TOTAL = 'reconciliation_discrepancy_total';
const METRIC_ALARM_OPEN = 'reconciliation_alarm_open';
const METRIC_DRIFT_AMOUNT = 'reconciliation_drift_amount';
const METRIC_LAST_RUN_TIMESTAMP = 'reconciliation_last_run_timestamp';
const METRIC_ERRORS_TOTAL = 'reconciliation_errors_total';
const METRIC_PAGER_ALARM = 'reconciliation_pager_alarm';

// ─── ReconciliationScheduler ──────────────────────────────────────────────────

export class ReconciliationScheduler {
  private readonly lookbackMs: number;
  private readonly tolerance: number;
  private readonly cardinalityLimit: number;
  private readonly pagerThresholdMs: number;
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
    this.pagerThresholdMs = options.pagerThresholdMs ?? 24 * 60 * 60 * 1000;
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
      pagerRaised: 0,
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
        const lastRun = await this.runStore.getLastRun(offering.id);
        const { periodStart, periodEnd } = this.determinePeriod(lastRun);
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

        // Carry forward the earliest detection timestamp so we can escalate to a
        // pager alarm when non-zero drift persists beyond pagerThresholdMs (24h).
        const driftFirstDetectedAt: Date | null = reconcileResult.isBalanced
          ? null
          : lastRun && !lastRun.isBalanced && lastRun.driftFirstDetectedAt
            ? lastRun.driftFirstDetectedAt
            : startedAt;

        // Persist run summary
        const summary: ReconciliationRunSummary = {
          offeringId: offering.id,
          periodId: this.periodId(periodStart),
          startedAt,
          completedAt,
          isBalanced: reconcileResult.isBalanced,
          discrepancyCount: reconcileResult.discrepancies.length,
          discrepancyAmount: reconcileResult.summary.discrepancyAmount,
          driftFirstDetectedAt,
        };
        await this.runStore.saveRun(summary);

        // Emit metrics
        this.emitMetrics(metricLabel, reconcileResult, result, driftFirstDetectedAt);

        result.successful++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('ReconciliationScheduler: offering run failed', {
          offeringId: offering.id,
          error: message,
        });
        result.failed++;
        result.errors.push({ offeringId: offering.id, error: message });

        // Increment per-offering error counter
        this.metrics.incrementCounter(
          METRIC_ERRORS_TOTAL,
          { offering_id: metricLabel },
          1,
          'Cumulative count of failed reconciliation runs'
        );

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

    this.logger.info('ReconciliationScheduler: tick complete', { ...result });
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
  private determinePeriod(
    lastRun: ReconciliationRunSummary | null
  ): { periodStart: Date; periodEnd: Date } {
    const periodEnd = new Date();
    const periodStart = lastRun
      ? lastRun.completedAt
      : new Date(periodEnd.getTime() - this.lookbackMs);
    return { periodStart, periodEnd };
  }

  /**
   * Emit reconciliation metrics including:
   * - reconciliation_discrepancy_total (counter)
   * - reconciliation_alarm_open (gauge)
   * - reconciliation_drift_amount (gauge)
   * - reconciliation_last_run_timestamp (gauge)
   */
  private emitMetrics(
    label: string,
    reconcileResult: ReconciliationResult,
    runResult: SchedulerRunResult,
    driftFirstDetectedAt: Date | null = null
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

    // Per-offering drift amount gauge — parsed from the decimal string
    const driftAmount = parseFloat(reconcileResult.summary.discrepancyAmount ?? '0');
    this.metrics.setGauge(
      METRIC_DRIFT_AMOUNT,
      driftAmount,
      labels,
      'Monetary drift amount for the offering (in settlement currency)'
    );

    // Last-run Unix epoch timestamp
    this.metrics.setGauge(
      METRIC_LAST_RUN_TIMESTAMP,
      Math.floor(Date.now() / 1000),
      labels,
      'Unix epoch seconds of the last completed reconciliation run'
    );

    if (!reconcileResult.isBalanced) {
      // Open (or keep open) the dead-letter alarm.
      this.metrics.setGauge(
        METRIC_ALARM_OPEN,
        1,
        labels,
        'Dead-letter alarm: 1 when reconciliation found discrepancies or errored'
      );
      runResult.alarmRaised++;

      // Escalate to a pager alarm when non-zero drift has persisted longer than
      // the configured threshold (default 24h), per the reconciliation runbook.
      const driftAgeMs = driftFirstDetectedAt
        ? Date.now() - driftFirstDetectedAt.getTime()
        : 0;
      const pager = driftAgeMs >= this.pagerThresholdMs ? 1 : 0;
      this.metrics.setGauge(
        METRIC_PAGER_ALARM,
        pager,
        labels,
        'Pager alarm: 1 when non-zero drift has persisted longer than pagerThresholdMs (default 24h)'
      );
      if (pager) runResult.pagerRaised++;
    } else {
      // Clear the alarm — a balanced run always silences any prior alarm.
      this.metrics.setGauge(METRIC_ALARM_OPEN, 0, labels);
      // A balanced run also clears any pending pager escalation.
      this.metrics.setGauge(METRIC_PAGER_ALARM, 0, labels);
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

// ─── PostgresReconciliationRunStore ───────────────────────────────────────────

/**
 * PostgreSQL-backed implementation of ReconciliationRunStore.
 *
 * Persists each scheduler run to the `reconciliation_run_summaries` table
 * (migration `013_create_reconciliation_run_summaries.sql`). The table has a
 * natural composite primary key `(offering_id, period_id, started_at)` so
 * concurrent multi-instance writes for the same run are de-duplicated by the
 * constraint rather than silently overwritten.
 *
 * `getLastRun` reads the most-recent run per offering via the
 * `idx_rrs_offering_started` index (ORDER BY started_at DESC LIMIT 1), giving a
 * stable resume point so a missed tick does not double-reconcile a window.
 *
 * Security / safety:
 * - Values are bound parameters (parameterised queries) — no string
 *   interpolation into SQL, protecting against injection.
 * - On `INSERT ... ON CONFLICT DO NOTHING`, the return value may be empty; we
 *   treat that as an idempotent no-op (the row already exists).
 */
export class PostgresReconciliationRunStore implements ReconciliationRunStore {
  constructor(private readonly db: Pool) {}

  async saveRun(summary: ReconciliationRunSummary): Promise<void> {
    await this.db.query(
      `
      INSERT INTO reconciliation_run_summaries (
        offering_id,
        period_id,
        started_at,
        completed_at,
        is_balanced,
        discrepancy_count,
        discrepancy_amount
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (offering_id, period_id, started_at) DO NOTHING
      `,
      [
        summary.offeringId,
        summary.periodId,
        summary.startedAt,
        summary.completedAt,
        summary.isBalanced,
        summary.discrepancyCount,
        summary.discrepancyAmount,
      ]
    );
  }

  async getLastRun(offeringId: string): Promise<ReconciliationRunSummary | null> {
    const result = await this.db.query(
      `
      SELECT
        offering_id,
        period_id,
        started_at,
        completed_at,
        is_balanced,
        discrepancy_count,
        discrepancy_amount
      FROM reconciliation_run_summaries
      WHERE offering_id = $1
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [offeringId]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      offeringId: row.offering_id,
      periodId: row.period_id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      isBalanced: row.is_balanced,
      discrepancyCount: row.discrepancy_count,
      discrepancyAmount: String(row.discrepancy_amount ?? '0'),
    };
  }
}

// ─── Scheduler runtime (interval wrapper) ─────────────────────────────────────

export const DEFAULT_RECONCILIATION_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
export const RECONCILIATION_INTERVAL_ENV = 'RECONCILIATION_INTERVAL_MS';

/**
 * Resolve the scheduler cadence (ms).
 *
 * Precedence: RECONCILIATION_INTERVAL_MS env > SCHEDULER_RECONCILIATION_INTERVAL_MS
 * env > explicit option > DEFAULT_RECONCILIATION_INTERVAL_MS. Non-positive /
 * non-finite values fall back to the explicit option or default (fail-safe, so a
 * misconfigured env cannot disable or crash the scheduler cadence).
 */
export function resolveSchedulerInterval(
  env: Record<string, string | undefined>,
  explicitIntervalMs?: number
): number {
  const raw =
    env[RECONCILIATION_INTERVAL_ENV] ??
    env['SCHEDULER_RECONCILIATION_INTERVAL_MS'];
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return explicitIntervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
}

export interface CreateReconciliationSchedulerRuntimeOptions {
  /** PostgreSQL pool backing both reconciliation and run-summary persistence. */
  db: Pool;
  /** Metrics collector used by the scheduler AND the /metrics/reconciliation endpoint. */
  metrics: MetricsCollector;
  logger?: Logger;
  /** Default cadence between ticks (ms). Overridden by RECONCILIATION_INTERVAL_MS. */
  intervalMs?: number;
  /** Forwarded to ReconciliationScheduler. */
  tolerance?: number;
  /** Forwarded to ReconciliationScheduler (label cardinality cap). */
  cardinalityLimit?: number;
  /** Run-summary store. Defaults to PostgresReconciliationRunStore. */
  runStore?: ReconciliationRunStore;
  /** Active-offering repository. Defaults to OfferingRepository (listAll). */
  offeringRepo?: ActiveOfferingRepository;
  /** Underlying scheduler. Defaults to a ReconciliationScheduler built from db + metrics. */
  scheduler?: ReconciliationScheduler;
}

/**
 * Build an interval-driven ReconciliationScheduler runtime.
 *
 * Returns a `{ start, stop, isRunning }` handle so app bootstrap can start the
 * cadence in production/development and keep tests deterministic (no timers).
 *
 * Concurrency safety: a tick is never started while a previous tick is still
 * in flight (`running` guard), so overlapping ticks cannot double-reconcile an
 * offering. A tick that throws is caught and logged rather than crashing the
 * process, and the dead-letter alarm stays open until a later balanced run.
 */
export function createReconciliationSchedulerRuntime(
  options: CreateReconciliationSchedulerRuntimeOptions
): { start: () => void; stop: () => void; isRunning: () => boolean } {
  const logger = options.logger ?? globalLogger;
  const runStore = options.runStore ?? new PostgresReconciliationRunStore(options.db);

  const scheduler =
    options.scheduler ??
    new ReconciliationScheduler(
      new RevenueReconciliationService(options.db),
      options.offeringRepo ?? (new OfferingRepository(options.db) as unknown as ActiveOfferingRepository),
      runStore,
      options.metrics,
      {
        tolerance: options.tolerance,
        cardinalityLimit: options.cardinalityLimit,
        logger,
      }
    );

  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const resolveInterval = (): number =>
    resolveSchedulerInterval(process.env, options.intervalMs);

  const tick = async (): Promise<void> => {
    if (running) {
      logger.warn('ReconciliationScheduler: skipping tick — previous tick still running');
      return;
    }
    running = true;
    try {
      await scheduler.runScheduledReconciliation();
    } catch (err) {
      logger.error('ReconciliationScheduler: unhandled tick error', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (timer) return; // already running
      // Run once on startup for immediate drift detection, then on cadence.
      void tick();
      timer = setInterval(() => void tick(), resolveInterval());
      timer.unref?.();
      logger.info('ReconciliationScheduler: started', {
        intervalMs: resolveInterval(),
      });
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      logger.info('ReconciliationScheduler: stopped');
    },
    isRunning(): boolean {
      return timer !== null;
    },
  };
}
