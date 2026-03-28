/**
 * @title DistributionEngine
 * @notice Computes per-investor payout amounts based on token balances and persists them.
 * @dev This service handles the core logic for revenue distribution, including:
 * 1. Balance acquisition (via provider or repository)
 * 2. Proration of revenue based on balances
 * 3. Rounding adjustment to ensure total payout equals revenue amount
 * 4. Persistence of distribution runs and individual payouts with a retry strategy
 */

export interface BalanceRow {
  investor_id: string;
  balance: number; // numeric balance; precision handled by callers/tests
}

export interface DistributionResult {
  distributionRun: any;
  payouts: Array<{ investor_id: string; amount: string }>;
}

export interface DistributionEngineOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  /** Log retry attempts to console/logger */
  logRetries?: boolean;
}

export class DistributionEngine {
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;
  private readonly backoffFactor: number;
  private readonly logRetries: boolean;

  /**
   * @param offeringRepo - should expose a method to list investors for offering (optional)
   * @param distributionRepo - must expose `createDistributionRun` and `createPayout`
   * @param balanceProvider - optional provider with `getBalances(offeringId, period)` returning BalanceRow[]
   * @param options - retry configuration
   */
  constructor(
    private offeringRepo: any,
    private distributionRepo: any,
    private balanceProvider?: { getBalances: (offeringId: string, period: any) => Promise<BalanceRow[]> },
    options: DistributionEngineOptions = {}
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelayMs = options.initialDelayMs ?? 500;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.logRetries = options.logRetries ?? false;
  }

  /**
   * @notice Distribute revenueAmount across investors for an offering and period.
   * @dev Security Assumptions:
   * - revenueAmount must be strictly positive.
   * - offeringId must be valid and exist (checked by repo).
   * - totalBalance must be > 0.
   * - Payouts are persisted with a retry strategy to handle transient failures.
   *
   * @param offeringId The unique identifier of the offering
   * @param period The timeframe for which the distribution is being made
   * @param revenueAmount The total amount of revenue to be distributed
   * @returns The created distribution run and the list of payouts
   */
  async distribute(
    offeringId: string,
    period: { start: Date; end: Date },
    revenueAmount: number
  ): Promise<DistributionResult> {
    // 1. Validation
    if (!offeringId) {
      throw new Error('offeringId is required');
    }
    if (revenueAmount <= 0) {
      throw new Error('revenueAmount must be > 0');
    }
    if (!period || !period.start || !period.end) {
      throw new Error('Valid distribution period is required');
    }

    // 2. Acquire balances with retry
    let balances: BalanceRow[] = [];
    try {
      balances = await this.withRetry(() => this.fetchBalances(offeringId, period));
    } catch (err) {
      throw new Error(`Failed to acquire balances after ${this.maxRetries} attempts: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!balances || balances.length === 0) {
      throw new Error('No investors or balances found for offering');
    }

    // 3. Sum balances
    const totalBalance = balances.reduce((s, b) => s + Number(b.balance), 0);
    if (totalBalance <= 0) {
      throw new Error('Total balance must be > 0 to distribute revenue');
    }

    // 4. Compute raw shares and round to 2 decimals (string amounts)
    const rawShares = balances.map((b) => ({
      investor_id: b.investor_id,
      raw: (Number(b.balance) / totalBalance) * revenueAmount,
    }));

    // Round to cents and ensure sum equals revenueAmount by adjusting largest share
    const rounded = rawShares.map((r) => ({
      investor_id: r.investor_id,
      amount: Math.round(r.raw * 100) / 100,
    }));

    const roundedSum = rounded.reduce((s, r) => s + r.amount, 0);
    const diff = Math.round((revenueAmount - roundedSum) * 100) / 100;

    if (Math.abs(diff) >= 0.01) {
      // find index of largest provisional raw amount to absorb rounding diff
      let maxIdx = 0;
      for (let i = 1; i < rawShares.length; i++) {
        if (rawShares[i].raw > rawShares[maxIdx].raw) maxIdx = i;
      }
      rounded[maxIdx].amount = Math.round((rounded[maxIdx].amount + diff) * 100) / 100;
    }

    // 5. Persist distribution run with retry
    let run: any;
    try {
      run = await this.withRetry(() =>
        this.distributionRepo.createDistributionRun({
          offering_id: offeringId,
          total_amount: revenueAmount.toFixed(2),
          distribution_date: period.end,
          status: 'processing',
        })
      );
    } catch (err) {
      throw new Error(`Failed to create distribution run after ${this.maxRetries} attempts: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 6. Persist payouts with individual retries
    const payouts: Array<{ investor_id: string; amount: string }> = [];
    for (const r of rounded) {
      const amtStr = r.amount.toFixed(2);
      try {
        await this.withRetry(() =>
          this.distributionRepo.createPayout({
            distribution_run_id: run.id,
            investor_id: r.investor_id,
            amount: amtStr,
            status: 'pending',
          })
        );
      } catch (err) {
        // Hardening: If an individual payout fails after all retries, we might want to mark the run as failed
        // but for now we follow the requirement to be robust. We log and throw to let the caller handle it.
        throw new Error(`Failed to create payout for investor ${r.investor_id} after ${this.maxRetries} attempts: ${err instanceof Error ? err.message : String(err)}`);
      }
      payouts.push({ investor_id: r.investor_id, amount: amtStr });
    }

    return { distributionRun: run, payouts };
  }

  /**
   * Internal helper to fetch balances from available sources
   */
  private async fetchBalances(offeringId: string, period: any): Promise<BalanceRow[]> {
    if (this.balanceProvider && typeof this.balanceProvider.getBalances === 'function') {
      return await this.balanceProvider.getBalances(offeringId, period);
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
   * @param fn The asynchronous function to execute
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
            console.log(`[DistributionEngine] Retry attempt ${attempt} failed, retrying in ${delay}ms...`);
          }
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }
}

export default DistributionEngine;
