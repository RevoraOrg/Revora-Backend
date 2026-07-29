import { Logger, globalLogger } from '../lib/logger';
import { Errors, AppError } from '../lib/errors';
import { Decimal } from '../lib/decimal';
import { Pool, PoolClient } from 'pg';
import { withTransaction, TransactionError } from '../db/transaction';
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
  StellarRPCFailure,
  StellarRPCFailureContext
} from '../lib/stellarRpcFailure';

export interface BalanceRow {
  investor_id: string;
  balance: number;
}

export interface DistributionBatchResult {
  distributionRun: any;
  successfulPayouts: Array<{ investor_id: string; amount: string }>;
  failedPayouts: Array<{ investor_id: string; amount: string; error: string; errorClass?: string }>;
  totalPayouts: number;
}

export interface DistributionEngineOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  logRetries?: boolean;
  batchSize?: number;
}

/**
 * Pure calculation result from distribution math.
 * This is the output of the shared calculation logic used by both
 * real distributions and previews.
 */
export interface DistributionCalculation {
  rounded: Array<{ investor_id: string; amount: Decimal; rawShare: Decimal }>;
  totalBalanceDecimal: Decimal;
  revenueDecimal: Decimal;
}

/**
 * Preview-specific response metadata.
 * Includes the preview-id for referencing this computation,
 * context for understanding when/what was previewed,
 * and the projected per-investor payouts.
 */
export interface DistributionPreviewResult {
  preview_id: string;
  offering_id: string;
  period_id: string;
  revenue_amount: string;
  computed_at: string;
  investor_count: number;
  projections: Array<{ investor_id: string; amount: string }>;
}

/**
 * Compute a stable 32-bit advisory lock key from (offeringId, periodId).
 *
 * pg_try_advisory_xact_lock takes a single bigint or two int4 values.
 * We use the two-argument form: (classId, objectId) where both are int4.
 * We derive them by hashing the concatenated string with a simple djb2-style
 * hash and splitting the 32-bit result into two 16-bit halves, then sign-extending
 * to int4 so Postgres accepts them.
 *
 * Collision probability is negligible for the expected cardinality of
 * (offering_id, period_id) pairs in a single deployment.
 */
export function advisoryLockKey(offeringId: string, periodId: string): [number, number] {
  const input = `${offeringId}:${periodId}`;
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // FNV prime: 0x01000193
    h = Math.imul(h, 0x01000193);
  }
  // Split into two signed int16 values (Postgres int4 range is fine with these)
  const hi = (h >>> 16) & 0xffff;
  const lo = h & 0xffff;
  // Convert to signed int32 range so Postgres accepts them as integer literals
  return [hi | 0, lo | 0];
}

/**
 * Attempt to acquire a Postgres transaction-scoped advisory lock for the given
 * (offeringId, periodId) pair. Returns true if the lock was acquired, false if
 * another session already holds it.
 *
 * The lock is automatically released when the surrounding transaction commits
 * or rolls back — no explicit release is needed.
 */
export async function tryAcquireDistributionLock(
  client: PoolClient,
  offeringId: string,
  periodId: string
): Promise<boolean> {
  const [classId, objectId] = advisoryLockKey(offeringId, periodId);
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_xact_lock($1, $2) AS acquired',
    [classId, objectId]
  );
  return result.rows[0].acquired;
}

/**
 * Core distribution calculation logic: prorate revenue across investors.
 * 
 * This is the SHARED pure calculation function used by both real distribution runs
 * and preview operations. It contains the deterministic math that both paths must
 * use identically to guarantee that "preview totals equal actual-run totals".
 * 
 * This function has NO side effects: no DB writes, no webhooks, no state mutations.
 * It is purely functional — same inputs always yield same outputs.
 * 
 * @param balances Array of investor balances
 * @param revenueAmount Total revenue to distribute
 * @returns Calculation result with per-investor rounded amounts
 */
function calculateDistributionPayouts(
  balances: BalanceRow[],
  revenueAmount: number
): DistributionCalculation {
  if (!balances || balances.length === 0) {
    throw Errors.badRequest('No investors or balances found for offering');
  }

  // 1. Sum balances and compute shares using Decimal for precision
  const balanceDecimals = balances.map((b) => {
    const rawStr = (b.balance).toFixed(18);
    const rawDecimal = new Decimal(rawStr);
    const scaled = rawDecimal.toSorobanI128(2, 'round');
    return Decimal.fromScaledBigInt(scaled, 2);
  });

  const totalBalanceDecimal = balanceDecimals.reduce((sum, bd) => sum.add(bd), new Decimal('0'));

  if (totalBalanceDecimal.isZero() || totalBalanceDecimal.isNegative()) {
    throw Errors.badRequest('Total balance must be > 0 to distribute revenue');
  }

  const revenueRawStr = revenueAmount.toFixed(18);
  const revenueRawDecimal = new Decimal(revenueRawStr);
  const revenueScaled = revenueRawDecimal.toSorobanI128(2, 'round');
  const revenueDecimal = Decimal.fromScaledBigInt(revenueScaled, 2);

  interface RawShare {
    investor_id: string;
    rawShare: Decimal;
  }
  const rawShares: RawShare[] = balances.map((b, index) => {
    const balanceDecimal = balanceDecimals[index];
    const share = balanceDecimal.divide(totalBalanceDecimal).multiply(revenueDecimal);
    return { investor_id: b.investor_id, rawShare: share };
  });

  interface RoundedShare {
    investor_id: string;
    amount: Decimal;
    rawShare: Decimal;
  }
  const rounded: RoundedShare[] = rawShares.map((r) => {
    const scaledValue = r.rawShare.toSorobanI128(2, 'round');
    const amountDecimal = Decimal.fromScaledBigInt(scaledValue, 2);
    return { investor_id: r.investor_id, amount: amountDecimal, rawShare: r.rawShare };
  });

  const roundedSum = rounded.reduce((sum, r) => sum.add(r.amount), new Decimal('0'));

  // 2. Largest-Share Reconciliation Adjustment
  const rawDiff = revenueDecimal.subtract(roundedSum);
  const diffScaled = rawDiff.toSorobanI128(2, 'round');
  const diff = Decimal.fromScaledBigInt(diffScaled, 2);

  if (!diff.isZero()) {
    let maxIdx = 0;
    for (let i = 1; i < rawShares.length; i++) {
      if (rawShares[i].rawShare.compareTo(rawShares[maxIdx].rawShare) > 0) {
        maxIdx = i;
      }
    }
    rounded[maxIdx].amount = rounded[maxIdx].amount.add(diff);
  }

  return { rounded, totalBalanceDecimal, revenueDecimal };
}

class DistributionEngine {
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly backoffFactor: number;
  private readonly logRetries: boolean;
  private readonly batchSize: number;
  private readonly logger: Logger;

  constructor(
    private offeringRepo: any,
    private distributionRepo: any,
    private balanceProvider?: { getBalances: (offeringId: string, period: any) => Promise<BalanceRow[]> },
    options: DistributionEngineOptions = {},
    private pool?: Pool,
    private notificationRepo?: any,
    private notificationPreferencesRepo?: any
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 500;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.logRetries = options.logRetries ?? false;
    this.batchSize = options.batchSize ?? 50;
    this.logger = globalLogger;
  }

  /**
   * Public entry point. Delegates to distributeWithBatch, wrapped in an
   * advisory lock when a pool is available so that concurrent callers for the
   * same (offeringId, period.id) are serialised at the database level.
   *
   * If the lock cannot be acquired the method throws Errors.conflict so the
   * caller receives a structured 409 response rather than blocking.
   *
   * If any payouts fail, throws an error with the failure class of the first
   * failed payout so callers get a clean rejection rather than a partial result.
   */
  async distribute(
    offeringId: string,
    period: { id: string; start: Date; end: Date },
    revenueAmount: number
  ): Promise<DistributionBatchResult & { payouts: Array<{ investor_id: string; amount: string }> }> {
    let batchResult: DistributionBatchResult;

    if (!this.pool) {
      // No pool — run without locking (test / legacy path)
      batchResult = await this.distributeWithBatch(offeringId, period, revenueAmount);
    } else {
      // Wrap the entire batch inside a single transaction so the advisory lock
      // (which is transaction-scoped) is held for the full duration.
      let result: DistributionBatchResult | undefined;
      try {
        await withTransaction(this.pool, async (client) => {
          const acquired = await tryAcquireDistributionLock(client, offeringId, period.id);
          if (!acquired) {
            throw Errors.conflict(
              `Distribution for offering ${offeringId} / period ${period.id} is already in progress`
            );
          }
          result = await this.distributeWithBatch(offeringId, period, revenueAmount);
        });
      } catch (err) {
        // withTransaction wraps errors in TransactionError; unwrap AppErrors so
        // callers receive the original structured error (e.g. 409 CONFLICT).
        if (err instanceof TransactionError && err.cause instanceof AppError) {
          throw err.cause;
        }
        throw err;
      }
      batchResult = result!;
    }

    // Throw if any payouts failed so callers get a clean rejection
    if (batchResult.failedPayouts.length > 0) {
      const firstFailure = batchResult.failedPayouts[0];
      throw new Error(`Distribution failed: ${firstFailure.errorClass ?? 'UNKNOWN'}`);
    }

    return { ...batchResult, payouts: batchResult.successfulPayouts };
  }

  /**
   * Core distribution logic: prorate revenue across investors and record payouts.
   *
   * @param offeringId  The offering to distribute revenue for
   * @param period      Distribution period (must include an `id` field)
   * @param revenueAmount The total amount of revenue to be distributed
   * @returns Batch result with successful and failed payouts
   */
  async distributeWithBatch(
    offeringId: string,
    period: { id?: string; start: Date; end: Date } & Record<string, any>,
    revenueAmount: number
  ): Promise<DistributionBatchResult> {
    const startTime = Date.now();

    // 1. Validation
    if (!offeringId) throw Errors.badRequest('offeringId is required');
    if (revenueAmount <= 0) throw Errors.badRequest('revenueAmount must be > 0');
    if (!period || !period.id || !period.end) throw Errors.badRequest('Valid distribution period with ID is required');

    const amtStr = revenueAmount.toFixed(2);

    // 2. Idempotency Check: Look for an existing run
    let run = await this.distributionRepo.findRunByParams(offeringId, period.id, amtStr);

    if (run) {
      if (run.status === 'completed') {
        this.logger.info('Distribution already completed, returning cached results', {
          offeringId,
          periodId: period.id,
          runId: run.id,
        });
        const existingPayouts = await this.distributionRepo.getPayoutsForRun(run.id);
        return {
          distributionRun: run,
          successfulPayouts: existingPayouts.map((p: any) => ({ investor_id: p.investor_id, amount: p.amount })),
          failedPayouts: [],
          totalPayouts: existingPayouts.length,
        };
      }
      this.logger.info('Resuming partially completed distribution', {
        offeringId,
        periodId: period.id,
        runId: run.id,
        currentStatus: run.status
      });
    }

    // 3. Acquire balances with retry and classification
    let balances: BalanceRow[] = [];
    try {
      balances = await this.withRetry(() => this.fetchBalances(offeringId, period));
    } catch (err) {
      const failure = classifyStellarRPCFailure(err, {
        operation: 'fetchBalances',
        offeringId,
        periodId: period.id,
      });
      this.logger.error('Failed to acquire balances', {
        offeringId,
        periodId: period.id,
        error: err instanceof Error ? err.message : String(err),
        failureClass: failure.class
      });
      throw Errors.serviceUnavailable(`Failed to acquire balances: ${failure.class}`);
    }

    // 4. Run the SHARED pure calculation logic
    // Both real distribution and previews use this exact same function,
    // guaranteeing that preview totals equal actual-run totals when inputs are unchanged.
    const calculation = calculateDistributionPayouts(balances, revenueAmount);
    const { rounded } = calculation;

    // 5. Ensure distribution run exists and is in 'processing' state
    if (!run) {
      try {
        run = await this.withRetry(() =>
          this.distributionRepo.createDistributionRun({
            offering_id: offeringId,
            period_id: period.id,
            total_amount: amtStr,
            run_at: period.end,
            status: 'processing',
          })
        );
        this.logger.info('Created new distribution run', {
          offeringId,
          periodId: period.id,
          runId: run.id
        });
      } catch (err) {
        const failure = classifyStellarRPCFailure(err, {
          operation: 'createDistributionRun',
          offeringId,
          periodId: period.id,
        });
        this.logger.error('Failed to create distribution run', {
          offeringId,
          periodId: period.id,
          error: err instanceof Error ? err.message : String(err),
          failureClass: failure.class
        });
        throw Errors.internal(`Failed to initialize distribution run: ${failure.class}`);
      }
    } else if (run.status !== 'processing') {
      try {
        await this.distributionRepo.updateRunStatus(run.id, 'processing');
      } catch (err) {
        const failure = classifyStellarRPCFailure(err, {
          operation: 'updateRunStatus',
          offeringId,
          periodId: period.id,
        });
        this.logger.error('Failed to update run status to processing', {
          offeringId,
          runId: run.id,
          error: err instanceof Error ? err.message : String(err),
          failureClass: failure.class
        });
        throw Errors.internal(`Failed to update distribution status: ${failure.class}`);
      }
    }

    this.logger.info('Distribution batch started', {
      offeringId,
      runId: run.id,
      period,
      revenueAmount,
      investorCount: balances.length,
      batchSize: this.batchSize,
    });

    // 6. Process payouts in batches with atomic transaction support
    const existingPayouts = await this.distributionRepo.getPayoutsForRun(run.id);
    const existingInvestorIds = new Set(existingPayouts.map((p: any) => p.investor_id));

    const successfulPayouts: Array<{ investor_id: string; amount: string }> = existingPayouts.map((p: any) => ({
      investor_id: p.investor_id,
      amount: p.amount,
    }));
    const failedPayouts: Array<{ investor_id: string; amount: string; error: string; errorClass?: string }> = [];
    let hasBatchFailure = false;

    for (let batchStart = 0; batchStart < rounded.length; batchStart += this.batchSize) {
      const batch = rounded.slice(batchStart, batchStart + this.batchSize);
      const batchNumber = Math.floor(batchStart / this.batchSize) + 1;

      try {
        if (this.pool) {
          await withTransaction(this.pool, async (client) => {
            for (const r of batch) {
              if (existingInvestorIds.has(r.investor_id)) continue;

              const amtStr = r.amount.toString();
              await this.withRetry(() =>
                this.distributionRepo.createPayout(
                  {
                    distribution_id: run.id,
                    investor_id: r.investor_id,
                    amount: amtStr,
                    status: 'pending',
                  },
                  client
                )
              );
              successfulPayouts.push({ investor_id: r.investor_id, amount: amtStr });
              existingInvestorIds.add(r.investor_id);
            }
          });
        } else {
          // Fallback to non-transactional processing for backward compatibility
          for (const r of batch) {
            if (existingInvestorIds.has(r.investor_id)) continue;

            const amtStr = r.amount.toString();
            try {
              await this.withRetry(() =>
                this.distributionRepo.createPayout({
                  distribution_id: run.id,
                  investor_id: r.investor_id,
                  amount: amtStr,
                  status: 'pending',
                })
              );
              successfulPayouts.push({ investor_id: r.investor_id, amount: amtStr });
              existingInvestorIds.add(r.investor_id);
            } catch (err) {
              const failure = classifyStellarRPCFailure(err, {
                operation: 'createPayout',
                offeringId,
                periodId: period.id,
              });

              this.logger.error('Payout creation failed', {
                offeringId,
                runId: run.id,
                investorId: r.investor_id,
                errorClass: failure.class,
                batchNumber,
                rawError: err instanceof Error ? err.message : String(err),
              });

              failedPayouts.push({
                investor_id: r.investor_id,
                amount: amtStr,
                error: `Action failed with ${failure.class}`,
                errorClass: failure.class,
              });
            }
          }
        }

        this.logger.info('Distribution batch processed successfully', {
          offeringId,
          runId: run.id,
          batchNumber,
          payoutsInBatch: batch.length,
          transactional: !!this.pool,
        });
      } catch (err) {
        hasBatchFailure = true;
        const failure = classifyStellarRPCFailure(err, {
          operation: 'processBatch',
          offeringId,
          periodId: period.id,
        });

        this.logger.error('Payout batch failed', {
          offeringId,
          runId: run.id,
          batchNumber,
          errorClass: failure.class,
          investorCount: batch.length,
          transactional: !!this.pool,
          rawError: err instanceof Error ? err.message : String(err),
        });

        if (!this.pool) {
          for (const r of batch) {
            if (!r) continue; // guard against poisoned/null batch items
            if (!existingInvestorIds.has(r.investor_id) && !successfulPayouts.some(p => p.investor_id === r.investor_id)) {
              const amtStr = r.amount.toString();
              failedPayouts.push({
                investor_id: r.investor_id,
                amount: amtStr,
                error: `Batch processing failed: ${failure.class}`,
                errorClass: failure.class,
              });
            }
          }
        }
      }
    }

    const duration = Date.now() - startTime;
    const finalStatus = (failedPayouts.length === 0 && !hasBatchFailure) ? 'completed' : 'failed';

    try {
      await this.distributionRepo.updateRunStatus(run.id, finalStatus);
      run.status = finalStatus;
    } catch (err) {
      const failure = classifyStellarRPCFailure(err, {
        operation: 'updateFinalRunStatus',
        offeringId,
        periodId: period.id,
      });
      this.logger.error('Failed to update final distribution run status', {
        offeringId,
        runId: run.id,
        finalStatus,
        error: err instanceof Error ? err.message : String(err),
        failureClass: failure.class
      });
    }

    this.logger.info('Distribution batch completed', {
      offeringId,
      runId: run.id,
      status: finalStatus,
      successfulPayouts: successfulPayouts.length,
      failedPayouts: failedPayouts.length,
      totalPayouts: rounded.length,
      duration,
    });

    try {
      await this.fanOutNotifications(run, finalStatus, successfulPayouts, failedPayouts);
    } catch (err) {
      this.logger.error('Failed to fan out notifications', {
        offeringId,
        runId: run.id,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    return {
      distributionRun: run,
      successfulPayouts,
      failedPayouts,
      totalPayouts: rounded.length,
    };
  }

  /**
   * Preview-only distribution run: uses the exact same calculation logic as real distribution
   * but performs zero side effects (no DB writes, no webhooks, no idempotency-key consumption).
   * 
   * This is designed for treasury to dry-run distribution math before approving/executing
   * a real distribution window. Returns per-investor projected amounts with a fresh preview-id.
   * 
   * SECURITY NOTES:
   * - Returns real, sensitive per-investor financial data — must be RBAC-gated appropriately.
   * - No persistence: no DB writes of any kind.
   * - No webhooks: notifications are never emitted.
   * - No idempotency state: idempotency-key consumption is skipped; previews are freely repeatable.
   * - Preview-id is a fresh UUID per call, not persisted or queryable as a resource unless
   *   the caller explicitly builds a secondary record (outside this engine).
   * 
   * @param offeringId  The offering to preview distribution for
   * @param period      Distribution period (must include an `id` field)
   * @param revenueAmount The total amount of revenue to preview distributing
   * @returns Preview result with per-investor projected amounts and preview metadata
   */
  async previewRun(
    offeringId: string,
    period: { id?: string; start: Date; end: Date } & Record<string, any>,
    revenueAmount: number
  ): Promise<DistributionPreviewResult> {
    const startTime = Date.now();
    const previewId = this.generatePreviewId();

    // 1. Validation
    if (!offeringId) throw Errors.badRequest('offeringId is required');
    if (revenueAmount <= 0) throw Errors.badRequest('revenueAmount must be > 0');
    if (!period || !period.id) throw Errors.badRequest('Valid distribution period with ID is required');

    this.logger.info('Distribution preview requested', {
      previewId,
      offeringId,
      periodId: period.id,
      revenueAmount,
    });

    // 2. Acquire balances with retry and classification
    let balances: BalanceRow[] = [];
    try {
      balances = await this.withRetry(() => this.fetchBalances(offeringId, period));
    } catch (err) {
      const failure = classifyStellarRPCFailure(err, {
        operation: 'fetchBalances',
        offeringId,
        periodId: period.id,
      });
      this.logger.error('Failed to acquire balances for preview', {
        previewId,
        offeringId,
        periodId: period.id,
        error: err instanceof Error ? err.message : String(err),
        failureClass: failure.class
      });
      throw Errors.serviceUnavailable(`Failed to acquire balances: ${failure.class}`);
    }

    // 3. Run the SHARED pure calculation logic (same as real distribution)
    const calculation = calculateDistributionPayouts(balances, revenueAmount);
    const { rounded } = calculation;

    // 4. Build response
    const projections = rounded.map((r) => ({
      investor_id: r.investor_id,
      amount: r.amount.toString(),
    }));

    const duration = Date.now() - startTime;

    this.logger.info('Distribution preview completed', {
      previewId,
      offeringId,
      periodId: period.id,
      revenueAmount,
      investorCount: balances.length,
      duration,
    });

    return {
      preview_id: previewId,
      offering_id: offeringId,
      period_id: period.id,
      revenue_amount: revenueAmount.toFixed(2),
      computed_at: new Date().toISOString(),
      investor_count: balances.length,
      projections,
    };
  }

  /**
   * Generate a fresh UUID for a preview computation.
   * This identifies a specific preview call without implying persistence.
   */
  private generatePreviewId(): string {
    // Simple UUID v4 generation (RFC 4122 compliant)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Internal helper to fetch balances from available sources
   */
  private async fetchBalances(offeringId: string, period: any): Promise<BalanceRow[]> {
    if (this.balanceProvider && typeof this.balanceProvider.getBalances === 'function') {
      return await this.balanceProvider.getBalances(offeringId, period.id);
    } else if (this.offeringRepo && typeof this.offeringRepo.getInvestors === 'function') {
      return await this.offeringRepo.getInvestors(offeringId, period);
    } else if (this.offeringRepo && typeof this.offeringRepo.listInvestors === 'function') {
      return await this.offeringRepo.listInvestors(offeringId, period);
    } else {
      throw new Error('No balance source available');
    }
  }

  /**
   * Executes a function with exponential backoff retry strategy.
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: any;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          const delay = this.initialDelayMs * Math.pow(this.backoffFactor, attempt - 1);
          if (this.logRetries) {
            this.logger.warn(`[DistributionEngine] Retry attempt ${attempt} failed, retrying in ${delay}ms...`);
          }
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, delay);
            if (timer.unref) timer.unref();
          });
        }
      }
    }
    throw lastError;
  }

  /**
   * Fans out notifications to investors based on distribution outcomes.
   */
  private async fanOutNotifications(
    run: any,
    finalStatus: string,
    successfulPayouts: Array<{ investor_id: string; amount: string }>,
    failedPayouts: Array<{ investor_id: string; amount: string; error: string; errorClass?: string }>
  ) {
    if (!this.notificationRepo || !this.notificationPreferencesRepo || !this.pool) {
      this.logger.debug('Skipping notification fan-out due to missing dependencies');
      return;
    }

    const processNotification = async (
      investorId: string,
      type: string,
      title: string,
      body: string
    ) => {
      const idempotencyKey = `notification:${type}:${run.id}:${investorId}`;
      try {
        await this.pool!.query(
          `INSERT INTO idempotency_keys (key, response_status, response_body, state, created_at) VALUES ($1, 200, '{}', 'completed', NOW())`,
          [idempotencyKey]
        );
      } catch (e: any) {
        if (e.code === '23505') {
          return;
        }
        throw e;
      }

      const prefs = await this.notificationPreferencesRepo.getByUserId(investorId);
      if (prefs && prefs.push_notifications === false && prefs.email_notifications === false) {
        return;
      }

      await this.notificationRepo.create({
        user_id: investorId,
        type,
        title,
        body,
      });
    };

    if (finalStatus === 'completed') {
      for (const payout of successfulPayouts) {
        await processNotification(
          payout.investor_id,
          'distribution.completed',
          'Distribution Completed',
          `Your distribution of ${payout.amount} has been processed successfully.`
        );
      }
    }

    for (const payout of failedPayouts) {
      await processNotification(
        payout.investor_id,
        'payout.failed',
        'Payout Failed',
        `Your payout of ${payout.amount} failed to process. Reason: ${payout.errorClass || 'Unknown error'}.`
      );
    }
  }
}

export default DistributionEngine;
