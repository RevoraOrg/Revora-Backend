import { SessionRepository } from '../db/repositories/sessionRepository';
import { MetricsCollector } from '../lib/metrics';
import { globalLogger } from '../lib/logger';
import { env } from '../config/env';

/**
 * Service to manage the scheduled compaction of session storage.
 * It deletes revoked or expired session rows older than the retention window,
 * and vacuums the table to reclaim space.
 */
export class SessionCompactionService {
  private intervalId?: NodeJS.Timeout;

  constructor(
    private readonly sessionRepo: SessionRepository,
    private readonly metricsCollector?: MetricsCollector
  ) {}

  /**
   * Starts the scheduled compaction job
   * @param intervalMs Interval in milliseconds (default: 24 hours)
   */
  start(intervalMs: number = 24 * 60 * 60 * 1000): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    
    // Run immediately on start
    this.runCompaction().catch(err => {
      globalLogger.error('Initial session compaction failed', { error: err });
    });

    // Schedule periodic runs
    this.intervalId = setInterval(() => {
      this.runCompaction().catch(err => {
        globalLogger.error('Scheduled session compaction failed', { error: err });
      });
    }, intervalMs);
    
    globalLogger.info('Session compaction service started', { 
      intervalMs,
      retentionDays: env.SESSION_RETENTION_DAYS 
    });
  }

  /**
   * Stops the scheduled compaction job
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
   */
  async runCompaction(batchSize: number = 1000): Promise<{ deletedCount: number }> {
    const startTime = Date.now();
    let totalDeleted = 0;
    
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - env.SESSION_RETENTION_DAYS);

      globalLogger.info('Running session compaction', { cutoffDate: cutoffDate.toISOString(), batchSize });

      // Calculate lag from retention boundary before deleting
      let lagDays = 0;
      const oldestDate = await this.sessionRepo.getOldestCompactedSessionDate(cutoffDate);
      if (oldestDate) {
        const diffMs = cutoffDate.getTime() - oldestDate.getTime();
        lagDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      }

      // Delete in bounded batches
      let deletedInBatch = 0;
      do {
        deletedInBatch = await this.sessionRepo.purgeOlderThan(cutoffDate, batchSize);
        totalDeleted += deletedInBatch;
      } while (deletedInBatch === batchSize);
      
      if (totalDeleted > 0) {
        // Run vacuum to reclaim space
        globalLogger.info('Vacuuming sessions table after compaction');
        await this.sessionRepo.vacuumSessions();
      }

      const duration = Date.now() - startTime;
      
      globalLogger.info('Session compaction complete', {
        deletedCount: totalDeleted,
        lagDays,
        durationMs: duration,
      });

      if (this.metricsCollector) {
        this.metricsCollector.incrementCounter('session.compaction.rows', { status: 'success' }, totalDeleted);
        this.metricsCollector.recordHistogram('session.compaction.retention_lag_days', lagDays, { status: 'success' });
        this.metricsCollector.recordHistogram('session.compaction.duration_ms', duration, { status: 'success' });
      }

      return { deletedCount: totalDeleted };
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
