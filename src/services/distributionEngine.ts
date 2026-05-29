import { Logger, globalLogger } from '../lib/logger';
import { Errors } from '../lib/errors';
import { Decimal } from '../lib/decimal';
import { Pool } from 'pg';
import { withTransaction } from '../db/transaction';
import { 
  classifyStellarRPCFailure, 
  StellarRPCFailureClass,
  StellarRPCFailure,
  StellarRPCFailureContext 
} from '../lib/stellarRpcFailure';

/**
    // 6. Process payouts in batches with optional transaction support
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
          // Transactional batch: create all payouts within a DB transaction
          await withTransaction(this.pool, async (client) => {
            for (const r of batch) {
              if (existingInvestorIds.has(r.investor_id)) continue;

              const amtStr = r.amount.toString();
              await this.withRetry(() =>
                // Pass client for transactional repository implementations
                this.distributionRepo.createPayout({
                  distribution_run_id: run.id,
                  investor_id: r.investor_id,
                  amount: amtStr,
                  status: 'pending',
                }, client)
              );

              successfulPayouts.push({ investor_id: r.investor_id, amount: amtStr });
              existingInvestorIds.add(r.investor_id);
            }
          });
        } else {
          // Non-transactional fallback for compatibility (used by tests/mocks)
          for (const r of batch) {
            if (existingInvestorIds.has(r.investor_id)) continue;

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

        // In non-transactional mode, record which specific payouts failed
        if (!this.pool) {
          for (const r of batch) {
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

    // 4. Sum balances and compute shares using Decimal for precision
    // ──────────────────────────────────────────────────────────────
    // Use BigInt-based Decimal arithmetic to avoid floating-point inaccuracies.
    // This ensures exact-to-the-cent calculations for financial correctness.
    // Convert all balances to Decimal first, then sum using Decimal arithmetic.
    // Convert balances to Decimal without performing JS floating-point arithmetic.
    // - Format the incoming numeric value to a decimal string with high precision
    //   (up to 18 places) to preserve any fractional parts.
    // - Construct a Decimal from that string, then round to 2 decimal places
    //   using `toSorobanI128(2, 'round')` to produce cent-precision values.
    const balanceDecimals = balances.map((b) => {
      const rawStr = (b.balance).toFixed(18); // string representation with up to 18 decimals
      const rawDecimal = new Decimal(rawStr);
      const scaled = rawDecimal.toSorobanI128(2, 'round');
      return Decimal.fromScaledBigInt(scaled, 2);
    });

    const totalBalanceDecimal = balanceDecimals.reduce((sum, bd) => sum.add(bd), new Decimal('0'));

    if (totalBalanceDecimal.isZero() || totalBalanceDecimal.isNegative()) {
      throw Errors.badRequest('Total balance must be > 0 to distribute revenue');
    }

    // Convert `revenueAmount` to a Decimal without JS numeric rounding.
    // Use a high-precision string representation then round to 2 decimals via Decimal.
    const revenueRawStr = revenueAmount.toFixed(18);
    const revenueRawDecimal = new Decimal(revenueRawStr);
    const revenueScaled = revenueRawDecimal.toSorobanI128(2, 'round');
    const revenueDecimal = Decimal.fromScaledBigInt(revenueScaled, 2);

    // Compute raw shares as Decimals with full precision (up to 18 decimal places).
    // These are NOT yet rounded; they preserve the exact mathematical division result.
    interface RawShare {
      investor_id: string;
      rawShare: Decimal;
    }
    const rawShares: RawShare[] = balances.map((b, index) => {
      // Use the pre-converted balance Decimal instead of reconverting
      const balanceDecimal = balanceDecimals[index];
      // rawShare = (balance / totalBalance) * revenueAmount
      const share = balanceDecimal.divide(totalBalanceDecimal).multiply(revenueDecimal);
      return {
        investor_id: b.investor_id,
        rawShare: share,
      };
    });

    // Round each raw share to 2 decimal places (cents) using "round half up" strategy.
    // Convert via toSorobanI128 with scale=2 for consistent rounding behavior.
    interface RoundedShare {
      investor_id: string;
      amount: Decimal;
      rawShare: Decimal;
    }
    const rounded: RoundedShare[] = rawShares.map((r) => {
      // toSorobanI128(2, 'round') scales to 2 decimals and applies round-half-up
      const scaledValue = r.rawShare.toSorobanI128(2, 'round');
      const amountDecimal = Decimal.fromScaledBigInt(scaledValue, 2);
      return {
        investor_id: r.investor_id,
        amount: amountDecimal,
        rawShare: r.rawShare,
      };
    });

    // Calculate total of all rounded amounts to determine if reconciliation is needed.
    const roundedSum = rounded.reduce(
      (sum, r) => sum.add(r.amount),
      new Decimal('0')
    );

    // **Largest-Share Reconciliation Adjustment**
    // ────────────────────────────────────────────
    // Compute the difference between the intended revenue and the sum of rounded amounts.
    // Due to independent rounding, this difference can be non-zero (typically ±0.01).
    // Round the difference to 2 decimal places to ensure it fits within cent precision.
    const rawDiff = revenueDecimal.subtract(roundedSum);
    const diffScaled = rawDiff.toSorobanI128(2, 'round');
    const diff = Decimal.fromScaledBigInt(diffScaled, 2);

    if (!diff.isZero()) {
      // Find the investor with the largest raw share and adjust their payout by `diff`.
      // This ensures total payouts always equal revenueAmount exactly.
      // Rationale: The investor with the largest share implicitly benefits most from
      // the proration algorithm, so the reconciliation adjustment is fair.
      let maxIdx = 0;
      for (let i = 1; i < rawShares.length; i++) {
        if (rawShares[i].rawShare.compareTo(rawShares[maxIdx].rawShare) > 0) {
          maxIdx = i;
        }
      }
      // Adjust the largest share investor by the difference
      rounded[maxIdx].amount = rounded[maxIdx].amount.add(diff);
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

<<<<<<< HEAD
          // Decimal with scale 2 toString() returns exactly 2 decimal places
          const amtStr = r.amount.toString();
          try {
            await this.withRetry(() =>
              this.distributionRepo.createPayout({
                distribution_run_id: run.id,
=======
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
>>>>>>> origin/master
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
