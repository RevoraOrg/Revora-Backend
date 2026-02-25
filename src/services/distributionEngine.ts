/**
 * DistributionEngine
 * - Computes per-investor payout amounts based on token balances (or snapshot)
 * - Persists a distribution run and payouts via a DistributionRepository
 *
 * This module only depends on provided repository interfaces (passed into
 * the constructor). It does not assume concrete implementations so it can
 * be tested with simple mocks.
 */

export interface BalanceRow {
  investor_id: string;
  balance: number; // numeric balance; precision handled by callers/tests
}

export interface DistributionResult {
  distributionRun: any;
  payouts: Array<{ investor_id: string; amount: string }>;
}

export class DistributionEngine {
  /**
   * @param offeringRepo - should expose a method to list investors for offering (optional)
   * @param distributionRepo - must expose `createDistributionRun` and `createPayout`
   * @param balanceProvider - optional provider with `getBalances(offeringId, period)` returning BalanceRow[]
   */
  constructor(
    private offeringRepo: any,
    private distributionRepo: any,
    private balanceProvider?: { getBalances: (offeringId: string, period: any) => Promise<BalanceRow[]> }
  ) {}

  /**
   * Distribute revenueAmount (number) across investors for an offering and period.
   * Persists distribution run and payouts and returns the created records.
   */
  async distribute(
    offeringId: string,
    period: { start: Date; end: Date },
    revenueAmount: number
  ): Promise<DistributionResult> {
    if (revenueAmount <= 0) {
      throw new Error('revenueAmount must be > 0');
    }

    // Acquire balances
    let balances: BalanceRow[] = [];
    if (this.balanceProvider && typeof this.balanceProvider.getBalances === 'function') {
      balances = await this.balanceProvider.getBalances(offeringId, period);
    } else if (this.offeringRepo && typeof this.offeringRepo.getInvestors === 'function') {
      // offeringRepo.getInvestors may return [{ investor_id, balance }]
      balances = await this.offeringRepo.getInvestors(offeringId, period);
    } else if (this.offeringRepo && typeof this.offeringRepo.listInvestors === 'function') {
      balances = await this.offeringRepo.listInvestors(offeringId, period);
    } else {
      throw new Error('No balance source available (provide balanceProvider or offeringRepo.getInvestors)');
    }

    if (!balances || balances.length === 0) {
      throw new Error('No investors or balances found for offering');
    }

    // Sum balances
    const totalBalance = balances.reduce((s, b) => s + Number(b.balance), 0);
    if (totalBalance <= 0) {
      throw new Error('Total balance must be > 0 to distribute revenue');
    }

    // Compute raw shares and round to 2 decimals (string amounts)
    const rawShares = balances.map((b) => ({
      investor_id: b.investor_id,
      raw: (Number(b.balance) / totalBalance) * revenueAmount,
    }));

    // Round to cents and ensure sum equals revenueAmount by adjusting largest share
    const rounded = rawShares.map((r) => ({ investor_id: r.investor_id, amount: Math.round(r.raw * 100) / 100 }));
    const roundedSum = rounded.reduce((s, r) => s + r.amount, 0);
    const diff = Math.round((revenueAmount - roundedSum) * 100) / 100; // can be negative/positive

    if (Math.abs(diff) >= 0.01) {
      // find index of largest provisional raw amount to absorb rounding diff
      let maxIdx = 0;
      for (let i = 1; i < rawShares.length; i++) {
        if (rawShares[i].raw > rawShares[maxIdx].raw) maxIdx = i;
      }
      rounded[maxIdx].amount = Math.round((rounded[maxIdx].amount + diff) * 100) / 100;
    }

    // Persist distribution run
    const run = await this.distributionRepo.createDistributionRun({
      offering_id: offeringId,
      total_amount: revenueAmount.toFixed(2),
      distribution_date: period.end,
    });

    // Persist payouts
    const payouts: Array<{ investor_id: string; amount: string }> = [];
    for (const r of rounded) {
      const amtStr = r.amount.toFixed(2);
      await this.distributionRepo.createPayout({
        distribution_run_id: run.id,
        investor_id: r.investor_id,
        amount: amtStr,
      });
      payouts.push({ investor_id: r.investor_id, amount: amtStr });
    }

    return { distributionRun: run, payouts };
  }
}

export default DistributionEngine;
