import { SessionRepository } from '../db/repositories/sessionRepository';
import { MetricsCollector } from '../lib/metrics';
import { globalLogger } from '../lib/logger';
import { env } from '../config/env';

const DEFAULT_BATCH_SIZE = 1000;

export interface CompactionResult {
  deletedCount: number;
  /** Days the oldest retained eligible row sits behind the retention boundary. */
  lagDays: number;
  /** True when the run stopped because it reached the per-run row cap. */
  capHit: boolean;
}

/**
 * Service to manage the scheduled compaction of session storage.
 *
 * Revoked and expired session rows older than the retention window are deleted
 * in bounded batches, then the table is vacuumed to reclaim space.
 *
 * Security/correctness assumptions:
 * - The retention boundary is always computed with the DATABASE clock
 *   (`NOW() - retention`), never the application clock. A bad-clock event on
 *   the app server therefore cannot push the boundary forward and cause the
 *   job to delete rows that have not actually aged past retention.
 * - The SQL predicate only matches rows whose `expires_at` or `revoked_at` is
 *   behind the boundary, so active sessions (future `expires_at`, no
 *   `revoked_at`) can never be deleted.
 * - A per-run row cap (`SESSION_COMPACTION_MAX_ROWS_PER_RUN`, default
 *   100_000) bounds how many rows a single cycle may delete. If an anomaly
 *   makes an enormous number of rows suddenly look eligible, only a fixed,
 *   recoverable number are removed per run and the `cap_hit` metric fires.
 *
 * Metrics emitted:
 *  - `session.compaction.rows`              counter  rows deleted per run
 *  - `session.compaction.retention_lag_days` histogram  lag of the oldest
 *    eligible row behind the retention boundary
 *  - `session.compaction.duration_ms`       histogram  run duration
 *  - `session.compaction.errors_total`      counter  failed runs
 *  - `session.compaction.cap_hit`           counter  run hit the per-run cap
 */
export class SessionCompactionService {
  private intervalId?: NodeJS.Timeout;

  constructor(
    private readonly sessionRepo: SessionRepository,
    private readonly metricsCollector?: MetricsCollector,
  ) {}

  /**
   * Starts the scheduled compaction job.
   * @param intervalMs Interval in milliseconds (default: 24 hours)
   */
  start(intervalMs: number = 24 * 60 * 60 * 1000): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    // Run immediately on start, then on the schedule.
    this.runCompaction().catch(err => {
      globalLogger.error('Initial session compaction failed', { error: err });
    });

    this.intervalId = setInterval(() => {
      this.runCompaction().catch(err => {
        globalLogger.error('Scheduled session compaction failed', { error: err });
      });
    }, intervalMs);

    globalLogger.info('Session compaction service started', {
      intervalMs,
      retentionDays: env.SESSION_RETENTION_DAYS,
      maxRowsPerRun: env.SESSION_COMPACTION_MAX_ROWS_PER_RUN,
    });
  }

  /**
   * Stops the scheduled compaction job.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      globalLogger.info('Session compaction service stopped');
    }
  }

  /**
   * Executes a single compaction cycle.
   *
   * @param batchSize Max rows deleted per DELETE statement (bounded to avoid
   *   long-held locks).
   * @param maxRowsPerRun Hard cap on rows deleted in one cycle; an anomaly can
   *   never wipe the table in a single run.
   */
  async runCompaction(
    batchSize: number = DEFAULT_BATCH_SIZE,
    maxRowsPerRun: number = env.SESSION_COMPACTION_MAX_ROWS_PER_RUN,
  ): Promise<CompactionResult> {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new Error(`batchSize must be a positive integer, got ${batchSize}`);
    }
    if (!Number.isInteger(maxRowsPerRun) || maxRowsPerRun <= 0) {
      throw new Error(`maxRowsPerRun must be a positive integer, got ${maxRowsPerRun}`);
    }

    const startTime = Date.now();
    const retentionDays = env.SESSION_RETENTION_DAYS;
    let totalDeleted = 0;
    let capHit = false;

    try {
      globalLogger.info('Running session compaction', {
        retentionDays,
        batchSize,
        maxRowsPerRun,
      });

      // Lag from the retention boundary: how far past the boundary the oldest
      // eligible row sits. The boundary matches the DB-clock boundary used by
      // the purge, so the two stay consistent.
      let lagDays = 0;
      const oldestDate = await this.sessionRepo.getOldestCompactedSessionDate(retentionDays);
      if (oldestDate) {
        const boundaryMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const diffMs = boundaryMs - oldestDate.getTime();
        lagDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      }

      // Delete in bounded batches. Stop once the per-run cap is reached so a
      // bad-clock event (or any anomaly) cannot delete the whole table in one
      // cycle; the remaining rows stay behind for the next run.
      while (totalDeleted < maxRowsPerRun) {
        const remaining = maxRowsPerRun - totalDeleted;
        const size = Math.min(batchSize, remaining);
        const deletedInBatch = await this.sessionRepo.purgeOlderThan(retentionDays, size);
        totalDeleted += deletedInBatch;
        if (deletedInBatch < size) break;
      }
      capHit = totalDeleted >= maxRowsPerRun;

      if (totalDeleted > 0) {
        // Reclaim space after bulk deletion. VACUUM cannot run inside a
        // transaction block, so it is executed on its own connection.
        globalLogger.info('Vacuuming sessions table after compaction');
        await this.sessionRepo.vacuumSessions();
      }

      const duration = Date.now() - startTime;

      if (capHit) {
        globalLogger.warn(
          'Session compaction reached per-run cap; more rows remain eligible',
          { deletedCount: totalDeleted, maxRowsPerRun },
        );
      }

      globalLogger.info('Session compaction complete', {
        deletedCount: totalDeleted,
        lagDays,
        capHit,
        durationMs: duration,
      });

      if (this.metricsCollector) {
        this.metricsCollector.incrementCounter('session.compaction.rows', { status: 'success' }, totalDeleted);
        this.metricsCollector.recordHistogram('session.compaction.retention_lag_days', lagDays, { status: 'success' });
        this.metricsCollector.recordHistogram('session.compaction.duration_ms', duration, { status: 'success' });
        if (capHit) {
          this.metricsCollector.incrementCounter('session.compaction.cap_hit', { status: 'warning' });
        }
      }

      return { deletedCount: totalDeleted, lagDays, capHit };
    } catch (error) {
      const duration = Date.now() - startTime;
      if (this.metricsCollector) {
        this.metricsCollector.incrementCounter('session.compaction.errors_total', { status: 'error' });
        this.metricsCollector.recordHistogram('session.compaction.duration_ms', duration, { status: 'error' });
      }
      throw error;
    }
  }
}
