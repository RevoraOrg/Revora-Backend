/**
 * Periodic audit log integrity verification with metrics and alarms.
 */

import { Pool } from 'pg';
import { globalMetrics } from '../lib/metrics';
import { globalLogger, Logger } from '../lib/logger';
import {
  AuditIntegrityResult,
  verifyAuditLogIntegrity,
} from './auditHashChain';
import { AuditWitnessPublisher } from './auditWitnessPublisher';
import { MockWitnessClient } from './witnessClient';

export interface AuditIntegritySchedulerOptions {
  /** Verification interval in milliseconds (default: 24 hours). */
  intervalMs?: number;
  /** Run verification immediately on start. */
  runOnStart?: boolean;
  /** Optional logger override. */
  logger?: Logger;
  /** Optional metrics collector override. */
  metrics?: typeof globalMetrics;
  /** Optional witness publisher override. */
  witnessPublisher?: AuditWitnessPublisher;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class AuditIntegrityScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly logger: Logger;
  private readonly metrics: typeof globalMetrics;
  private readonly witnessPublisher: AuditWitnessPublisher;

  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly options: AuditIntegritySchedulerOptions = {},
  ) {
    this.logger = options.logger ?? globalLogger;
    this.metrics = options.metrics ?? globalMetrics;
    this.witnessPublisher = options.witnessPublisher ?? new AuditWitnessPublisher(pool, new MockWitnessClient(), {
      logger: this.logger,
      metrics: this.metrics,
    });
  }

  /** Start periodic verification (nightly by default). */
  start(): void {
    if (this.timer) return;

    const intervalMs = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;

    if (this.options.runOnStart) {
      void this.runVerification();
    }

    this.timer = setInterval(() => {
      void this.runVerification();
    }, intervalMs);

    this.logger.info('Audit integrity scheduler started', {
      intervalMs,
      component: 'audit-integrity-scheduler',
    });
  }

  /** Stop periodic verification. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single integrity verification pass. */
  async runVerification(): Promise<AuditIntegrityResult> {
    if (this.running) {
      this.logger.warn('Audit integrity verification already in progress', {
        component: 'audit-integrity-scheduler',
      });
      return {
        valid: true,
        totalRows: 0,
        verifiedRows: 0,
        durationMs: 0,
        headHash: null,
      };
    }

    this.running = true;
    try {
      const result = await verifyAuditLogIntegrity(this.pool);
      this.recordMetrics(result);

      if (result.valid) {
        this.logger.info('Audit log integrity verification passed', {
          component: 'audit-integrity-scheduler',
          totalRows: result.totalRows,
          verifiedRows: result.verifiedRows,
          durationMs: result.durationMs,
          headHash: result.headHash,
        });

        if (result.headHash) {
          // Publish the root hash to the public witness in the background
          // (Errors are caught internally and won't fail the scheduler)
          void this.witnessPublisher.publishLatest(result.headHash);
        }
      } else {
        this.raiseAlarm(result);
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.metrics.incrementCounter('audit_integrity_verification_errors_total');
      this.metrics.setGauge('audit_integrity_valid', 0);
      this.logger.error('Audit integrity verification failed to run', {
        component: 'audit-integrity-scheduler',
        error: message,
      });
      throw error;
    } finally {
      this.running = false;
    }
  }

  private recordMetrics(result: AuditIntegrityResult): void {
    this.metrics.setGauge(
      'audit_integrity_valid',
      result.valid ? 1 : 0,
      undefined,
      '1 when audit hash chain verification last passed, 0 on failure',
    );
    this.metrics.setGauge(
      'audit_integrity_rows_verified',
      result.verifiedRows,
      undefined,
      'Number of audit rows verified in the last integrity check',
    );
    this.metrics.recordHistogram(
      'audit_integrity_verification_duration_ms',
      result.durationMs,
      undefined,
      'Duration of audit log hash chain verification',
    );

    if (!result.valid) {
      this.metrics.incrementCounter('audit_integrity_failures_total', {
        failure_type: result.failure?.type ?? 'unknown',
      });
    } else {
      this.metrics.incrementCounter('audit_integrity_success_total');
    }
  }

  private raiseAlarm(result: AuditIntegrityResult): void {
    const failure = result.failure;
    this.logger.error('ALARM: Audit log integrity verification failed', {
      component: 'audit-integrity-scheduler',
      severity: 'critical',
      alarm: 'audit_log_integrity_failure',
      totalRows: result.totalRows,
      verifiedRows: result.verifiedRows,
      failureType: failure?.type,
      failureRowId: failure?.rowId,
      failureIndex: failure?.index,
      message: failure?.message,
    });
  }
}

/** Factory for application bootstrap. */
export function createAuditIntegrityScheduler(
  pool: Pick<Pool, 'query'>,
  options?: AuditIntegritySchedulerOptions,
): AuditIntegrityScheduler {
  return new AuditIntegrityScheduler(pool, options);
}
