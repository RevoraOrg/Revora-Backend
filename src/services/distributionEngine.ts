import { Logger, globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';
import { Pool } from 'pg';
import { withTransaction } from '../db/transaction';
import { 
  classifyStellarRPCFailure, 
  StellarRPCFailureClass,
  StellarRPCFailure,
  StellarRPCFailureContext 
} from '../lib/stellarRpcFailure';

/**
 * @title DistributionEngine
 * @notice Computes per-investor payout amounts based on token balances and persists them.
 * @dev This service handles the core logic for revenue distribution, including:
 * 1. Balance acquisition (via provider or repository)
 * 2. Proration of revenue based on balances
 * 3. Rounding adjustment to ensure total payout equals revenue amount
 * 4. Persistence of distribution runs and individual payouts with a retry strategy
 * 5. Batch processing for large payout sets with partial failure handling
 * 
 * **Security Assumptions & Risk Notes:**
 * - **Trust Boundary**: Balance data is assumed to be validated by the provided `balanceProvider` or `offeringRepo`.
 * - **Idempotency**: Runs are keyed by `(offeringId, periodId, totalAmount)`. Multiple calls with same params will resume or return existing run.
 * - **Data Leakage**: Stellar RPC failures are classified via `classifyStellarRPCFailure` to ensure raw upstream error strings do not leak to client.
 * - **Transactionality**: Payouts are persisted individually within batches. Partial failures are recorded in the `distribution_run` status.
 * - **Rounding**: The "Max Share Adjustment" strategy is used to ensure total payouts exactly match `revenueAmount` to the cent, preventing minor leakage or shortfall.
 */

export interface BalanceRow {
  investor_id: string;
  balance: number; // numeric balance; precision handled by callers/tests
}

export interface DistributionResult {
  distributionRun: any;
  payouts: Array<{ investor_id: string; amount: string }>;
}

/** Enhanced result type with batch processing details */
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
  /** Log retry attempts to console/logger */
  logRetries?: boolean;
  /** Max payouts per batch to prevent overwhelming the database (default: 50) */
  batchSize?: number;
}

export class DistributionEngine {
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
    private pool?: Pool
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 500;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.logRetries = options.logRetries ?? false;
    this.batchSize = options.batchSize ?? 50;
    this.logger = globalLogger;
  }

  /**
   * @notice Distribute revenueAmount across investors for an offering and period.
   * @dev Security Assumptions:
   * - revenueAmount must be strictly positive.
   * - offeringId must be valid and exist (checked by repo).
   * - totalBalance must be > 0.
   * - Payouts are persisted with a retry strategy to handle transient failures.
   * - Batch processing prevents overwhelming the database with large payout sets.
   *
   * @param offeringId The unique identifier of the offering
   * @param period The timeframe for which the distribution is being made
   * @param revenueAmount The total amount of revenue to be distributed
   * @returns The created distribution run and the list of payouts
   */
  async distribute(
    offeringId: string,
    period: { id: string; start: Date; end: Date },
    revenueAmount: number
  ): Promise<DistributionResult> {
    const result = await this.distributeWithBatch(offeringId, period, revenueAmount);
    
    if (result.failedPayouts.length > 0) {
      const firstFailure = result.failedPayouts[0];
      const errorMsg = firstFailure.errorClass 
        ? `Distribution failed: ${firstFailure.errorClass}`
        : 'Distribution completed with partial failures';
      throw Errors.internal(errorMsg);
    }

    // Backward compatibility: return original shape
    return {
      distributionRun: result.distributionRun,
      payouts: result.successfulPayouts,
    };
  }

  /**
   * @notice Distribute revenueAmount with batch processing and partial failure tracking.
   * @dev This is the enhanced version that returns detailed batch results.
   *
   * @param offeringId The unique identifier of the offering
   * @param period The timeframe for which the distribution is being made
   * @param revenueAmount The total amount of revenue to be distributed
   * @returns Batch result with successful and failed payouts
   */
  async distributeWithBatch(
    offeringId: string,
    period: { start: Date; end: Date },
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

    if (!balances || balances.length === 0) {
      throw Errors.badRequest('No investors or balances found for offering');
    }

    // 4. Sum balances and compute shares
    const totalBalance = balances.reduce((s, b) => s + Number(b.balance), 0);
    if (totalBalance <= 0) {
      throw Errors.badRequest('Total balance must be > 0 to distribute revenue');
    }

    const rawShares = balances.map((b) => ({
      investor_id: b.investor_id,
      raw: (Number(b.balance) / totalBalance) * revenueAmount,
    }));

    const rounded = rawShares.map((r) => ({
      investor_id: r.investor_id,
      amount: Math.round(r.raw * 100) / 100,
    }));

    const roundedSum = rounded.reduce((s, r) => s + r.amount, 0);
    const diff = Math.round((revenueAmount - roundedSum) * 100) / 100;

    if (Math.abs(diff) >= 0.01) {
      let maxIdx = 0;
      for (let i = 1; i < rawShares.length; i++) {
        if (rawShares[i].raw > rawShares[maxIdx].raw) maxIdx = i;
      }
      rounded[maxIdx].amount = Math.round((rounded[maxIdx].amount + diff) * 100) / 100;
    }

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
        // Process batch with transaction support if pool is available
        if (this.pool) {
          await withTransaction(this.pool, async (client) => {
            for (const r of batch) {
              if (existingInvestorIds.has(r.investor_id)) {
                continue;
              }

              const amtStr = r.amount.toFixed(2);
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
            if (existingInvestorIds.has(r.investor_id)) {
              continue;
            }

            const amtStr = r.amount.toFixed(2);
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

        // When a transactional batch fails, don't add individual failures 
        // because the entire batch rolled back
        if (!this.pool) {
          // In non-transactional mode, any payout that wasn't already added to successfulPayouts failed
          for (const r of batch) {
            if (!existingInvestorIds.has(r.investor_id) && !successfulPayouts.some(p => p.investor_id === r.investor_id)) {
              const amtStr = r.amount.toFixed(2);
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

    return {
      distributionRun: run,
      successfulPayouts,
      failedPayouts,
      totalPayouts: rounded.length,
    };
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
}

export default DistributionEngine;
