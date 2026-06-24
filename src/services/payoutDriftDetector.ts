import { Pool } from 'pg';
import { Logger, globalLogger } from '../lib/logger';
import { MetricsCollector } from '../lib/metrics';
import {
  PayoutDriftRepository,
  PayoutForVerification,
  DriftDetail,
  DriftSummary,
} from '../db/repositories/payoutDriftRepository';
import { StellarTransactionVerifier } from '../lib/stellarTransactionVerifier';

export interface PayoutDriftDetectorOptions {
  intervalMs?: number;
  driftThresholdHours?: number;
  logger?: Logger;
}

export interface PayoutDriftRunResult {
  offeringsChecked: number;
  totalMissing: number;
  totalUnderfunded: number;
  totalOverfunded: number;
  totalDuplicateTx: number;
  totalDriftAmount: string;
  oldestDriftHours: number;
  alarmRaised: boolean;
  errors: string[];
}

const METRIC_MISSING_TOTAL = 'payout_drift_missing_total';
const METRIC_UNDERFUNDED_TOTAL = 'payout_drift_underfunded_total';
const METRIC_OVERFUNDED_TOTAL = 'payout_drift_overfunded_total';
const METRIC_DUPLICATE_TX_TOTAL = 'payout_drift_duplicate_tx_total';
const METRIC_ALARM = 'payout_drift_alarm';
const METRIC_OLDEST_AGE = 'payout_drift_oldest_age_hours';
const METRIC_RUN_DURATION = 'payout_drift_run_duration_ms';

export class PayoutDriftDetector {
  private intervalId?: NodeJS.Timeout;
  private readonly intervalMs: number;
  private readonly driftThresholdHours: number;
  private readonly logger: Logger;

  constructor(
    private readonly pool: Pool,
    private readonly driftRepo: PayoutDriftRepository,
    private readonly metrics: MetricsCollector,
    private readonly txVerifier?: StellarTransactionVerifier,
    options: PayoutDriftDetectorOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000;
    this.driftThresholdHours = options.driftThresholdHours ?? 24;
    this.logger = options.logger ?? globalLogger;
  }

  start(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    this.runDriftDetection().catch((err) => {
      this.logger.error('Initial payout drift detection failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.intervalId = setInterval(() => {
      this.runDriftDetection().catch((err) => {
        this.logger.error('Scheduled payout drift detection failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);

    this.logger.info('PayoutDriftDetector started', {
      intervalMs: this.intervalMs,
      driftThresholdHours: this.driftThresholdHours,
    });
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      this.logger.info('PayoutDriftDetector stopped');
    }
  }

  async runDriftDetection(): Promise<PayoutDriftRunResult> {
    const startTime = Date.now();
    this.logger.info('PayoutDriftDetector: starting drift detection run');

    const result: PayoutDriftRunResult = {
      offeringsChecked: 0,
      totalMissing: 0,
      totalUnderfunded: 0,
      totalOverfunded: 0,
      totalDuplicateTx: 0,
      totalDriftAmount: '0',
      oldestDriftHours: 0,
      alarmRaised: false,
      errors: [],
    };

    try {
      const grouped = await this.driftRepo.getPayoutsByOffering();

      for (const group of grouped) {
        try {
          await this.detectDriftForOffering(group.offering_id, group.payouts, result);
          result.offeringsChecked++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.error('PayoutDriftDetector: offering run failed', {
            offeringId: group.offering_id,
            error: msg,
          });
          result.errors.push(`offering ${group.offering_id}: ${msg}`);
        }
      }

      const summary = await this.driftRepo.getAggregatedDriftSummary();
      result.totalMissing = summary.total_missing;
      result.totalDuplicateTx = summary.total_duplicate_tx;
      result.totalDriftAmount = summary.total_drift_amount;
      result.oldestDriftHours = summary.oldest_drift_hours;

      this.emitAggregatedMetrics(result);

      if (result.oldestDriftHours > this.driftThresholdHours && (
        result.totalMissing > 0 || result.totalUnderfunded > 0 ||
        result.totalOverfunded > 0 || result.totalDuplicateTx > 0
      )) {
        result.alarmRaised = true;
        this.metrics.setGauge(
          METRIC_ALARM,
          1,
          {},
          '1 when non-zero payout drift is older than threshold hours'
        );
      } else {
        this.metrics.setGauge(METRIC_ALARM, 0, {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('PayoutDriftDetector: run failed', { error: msg });
      result.errors.push(msg);
    }

    const duration = Date.now() - startTime;
    this.metrics.recordHistogram(METRIC_RUN_DURATION, duration, {
      status: result.errors.length > 0 && result.offeringsChecked === 0 ? 'error' : 'completed',
    });

    this.logger.info('PayoutDriftDetector: run complete', { ...result, durationMs: duration });
    return result;
  }

  private async detectDriftForOffering(
    offeringId: string,
    payouts: PayoutForVerification[],
    result: PayoutDriftRunResult
  ): Promise<void> {
    const details: DriftDetail[] = [];
    const label = this.shortLabel(offeringId);

    let missingCount = 0;
    let underfundedCount = 0;
    let overfundedCount = 0;
    let duplicateCount = 0;

    const txHashMap = new Map<string, PayoutForVerification[]>();

    for (const payout of payouts) {
      if (!payout.tx_hash) {
        missingCount++;
        details.push({
          payout_id: payout.id,
          investor_id: payout.investor_id,
          amount: payout.amount,
          tx_hash: null,
          drift_type: 'missing',
          expected_amount: payout.amount,
          actual_amount: '0',
          discrepancy: payout.amount,
        });
        continue;
      }

      const existing = txHashMap.get(payout.tx_hash) ?? [];
      existing.push(payout);
      txHashMap.set(payout.tx_hash, existing);

      if (this.txVerifier) {
        try {
          const verification = await this.txVerifier.verifyTransaction(
            payout.tx_hash,
            payout.amount
          );

          if (!verification.isValid) {
            const actual = verification.actualAmount ?? '0';
            const expected = payout.amount;
            const diff = (parseFloat(expected) - parseFloat(actual)).toFixed(2);

            if (parseFloat(diff) > 0.01) {
              underfundedCount++;
              details.push({
                payout_id: payout.id,
                investor_id: payout.investor_id,
                amount: payout.amount,
                tx_hash: payout.tx_hash,
                drift_type: 'underfunded',
                expected_amount: expected,
                actual_amount: actual,
                discrepancy: diff,
              });
            } else if (parseFloat(diff) < -0.01) {
              overfundedCount++;
              details.push({
                payout_id: payout.id,
                investor_id: payout.investor_id,
                amount: payout.amount,
                tx_hash: payout.tx_hash,
                drift_type: 'overfunded',
                expected_amount: expected,
                actual_amount: actual,
                discrepancy: diff,
              });
            }
          }
        } catch (err) {
          this.logger.warn('PayoutDriftDetector: tx verification error, skipping on-chain check', {
            payoutId: payout.id,
            txHash: payout.tx_hash,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    for (const [, dupeList] of txHashMap.entries()) {
      if (dupeList.length > 1) {
        duplicateCount++;
        for (const p of dupeList) {
          details.push({
            payout_id: p.id,
            investor_id: p.investor_id,
            amount: p.amount,
            tx_hash: p.tx_hash,
            drift_type: 'duplicate_tx',
            expected_amount: dupeList[0].amount,
            actual_amount: p.amount,
            discrepancy: 'DUPLICATE_TX_HASH',
          });
        }
      }
    }

    if (details.length > 0) {
      const totalDriftAmount = details
        .reduce((sum, d) => sum + Math.abs(parseFloat(d.discrepancy) || 0), 0)
        .toFixed(2);

      const oldestCreated = payouts
        .filter((p) => !p.tx_hash)
        .reduce((oldest, p) => (p.created_at < oldest ? p.created_at : oldest),
          new Date());

      const oldestAgeHours = (Date.now() - oldestCreated.getTime()) / 3600000;

      this.metrics.incrementCounter(METRIC_MISSING_TOTAL, { offering_id: label }, missingCount);
      this.metrics.incrementCounter(METRIC_UNDERFUNDED_TOTAL, { offering_id: label }, underfundedCount);
      this.metrics.incrementCounter(METRIC_OVERFUNDED_TOTAL, { offering_id: label }, overfundedCount);
      this.metrics.incrementCounter(METRIC_DUPLICATE_TX_TOTAL, { offering_id: label }, duplicateCount);
      this.metrics.setGauge(METRIC_OLDEST_AGE, oldestAgeHours, { offering_id: label });

      result.totalMissing += missingCount;
      result.totalUnderfunded += underfundedCount;
      result.totalOverfunded += overfundedCount;
      result.totalDuplicateTx += duplicateCount;

      const currentTotal = parseFloat(result.totalDriftAmount);
      result.totalDriftAmount = (currentTotal + parseFloat(totalDriftAmount)).toFixed(2);

      if (oldestAgeHours > result.oldestDriftHours) {
        result.oldestDriftHours = oldestAgeHours;
      }

      await this.driftRepo.saveReport({
        offering_id: offeringId,
        total_payouts: payouts.length,
        verified_count: payouts.filter((p) => p.tx_hash).length,
        missing_count: missingCount,
        underfunded_count: underfundedCount,
        overfunded_count: overfundedCount,
        duplicate_tx_count: duplicateCount,
        total_drift_amount: totalDriftAmount,
        oldest_drift_age_hours: oldestAgeHours,
        details,
      });
    }
  }

  private emitAggregatedMetrics(result: PayoutDriftRunResult): void {
    this.metrics.setGauge(
      METRIC_OLDEST_AGE,
      result.oldestDriftHours,
      { offering_id: '__aggregate__' }
    );
  }

  private shortLabel(offeringId: string): string {
    return offeringId.split('-')[0] ?? offeringId.slice(0, 8);
  }
}
