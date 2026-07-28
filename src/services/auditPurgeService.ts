import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { MetricsCollector } from '../lib/metrics';
import { globalLogger } from '../lib/logger';
import { env } from '../config/env';

/**
 * Service to manage the scheduled purging of audit logs based on retention policy.
 * Active legal-hold labels cause matching periods to be skipped (see retention_labels).
 */
export class AuditPurgeService {
  private intervalId?: NodeJS.Timeout;

  constructor(
    private readonly auditLogRepo: AuditLogRepository,
    private readonly metricsCollector?: MetricsCollector
  ) {}

  /**
   * Starts the scheduled purge job
   * @param intervalMs Interval in milliseconds (default: 24 hours)
   */
  start(intervalMs: number = 24 * 60 * 60 * 1000): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
    
    // Run immediately on start
    this.runPurge().catch(err => {
      globalLogger.error('Initial audit purge failed', { error: err });
    });

    // Schedule periodic runs
    this.intervalId = setInterval(() => {
      this.runPurge().catch(err => {
        globalLogger.error('Scheduled audit purge failed', { error: err });
      });
    }, intervalMs);
    
    globalLogger.info('Audit purge service started', { 
      intervalMs,
      retentionDays: env.AUDIT_RETENTION_DAYS 
    });
  }

  /**
   * Stops the scheduled purge job
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      globalLogger.info('Audit purge service stopped');
    }
  }

  /**
   * Executes a single purge cycle.
   * Legal-hold periods are never deleted here; they only become eligible after
   * a dual-controlled release and on a subsequent cycle.
   */
  async runPurge(): Promise<{ deletedCount: number; skippedHoldCount: number }> {
    const startTime = Date.now();
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - env.AUDIT_RETENTION_DAYS);

      globalLogger.info('Running audit log purge', { cutoffDate: cutoffDate.toISOString() });

      const { deletedCount, skippedHoldCount } = await this.auditLogRepo.purgeBefore(cutoffDate);
      
      const duration = Date.now() - startTime;
      
      globalLogger.info('Audit log purge complete', {
        deletedCount,
        skippedHoldCount,
        durationMs: duration,
      });

      if (this.metricsCollector) {
        this.metricsCollector.incrementCounter('audit_logs_purged_total', { status: 'success' }, deletedCount);
        this.metricsCollector.incrementCounter(
          'purge.skipped_hold',
          { status: 'success' },
          skippedHoldCount,
          'Audit/ledger rows skipped because their period is under legal hold',
        );
        this.metricsCollector.recordHistogram('audit_purge_duration_ms', duration, { status: 'success' });
      }

      return { deletedCount, skippedHoldCount };
    } catch (error) {
      const duration = Date.now() - startTime;
      if (this.metricsCollector) {
        this.metricsCollector.incrementCounter('audit_purge_errors_total', { status: 'error' });
        this.metricsCollector.recordHistogram('audit_purge_duration_ms', duration, { status: 'error' });
      }
      throw error;
    }
  }
}
