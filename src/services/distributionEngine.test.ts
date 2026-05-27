import DistributionEngine, { BalanceRow } from './distributionEngine';
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from '../lib/stellarRpcFailure';

class MockDistributionRepo {
  public runs: any[] = [];
  public payouts: any[] = [];
  public failNextRunCount = 0;
  public failNextPayoutCount = 0;
  public failSpecificPayouts: number[] = []; // indices of payouts that should fail

  async findRunByParams(offeringId: string, periodId: string, amount: string): Promise<any> {
    return this.runs.find(r => 
      r.offering_id === offeringId && 
      r.period_id === periodId && 
      r.total_amount === amount
    );
  }

  async getPayoutsForRun(runId: string): Promise<any[]> {
    return this.payouts.filter(p => p.distribution_id === runId);
  }

  public failNextUpdateStatusCount = 0;

  async updateRunStatus(runId: string, status: string): Promise<void> {
    if (this.failNextUpdateStatusCount > 0) {
      this.failNextUpdateStatusCount--;
      throw new Error('Database error (update status)');
    }
    const run = this.runs.find(r => r.id === runId);
    if (run) {
      run.status = status;
    }
  }

  async createDistributionRun(input: any): Promise<any> {
    if (this.failNextRunCount > 0) {
      this.failNextRunCount--;
      throw new Error('Database error (run)');
    }
    const run = { 
      id: `run-${this.runs.length + 1}`, 
      status: 'pending',
      ...input 
    };
    this.runs.push(run);
    return run;
  }

  async createPayout(input: any, client?: any): Promise<any> {
    // Check if this specific payout should fail
    const payoutIndex = this.payouts.length;
    if (this.failNextPayoutCount > 0) {
      this.failNextPayoutCount -= 1;
      throw new Error('Database error (payout)');
    }
    if (this.failSpecificPayouts.includes(payoutIndex)) {
      throw new Error(`Simulated failure for payout at index ${payoutIndex}`);
    }

    const payout = { id: `p-${this.payouts.length + 1}`, ...input };
    this.payouts.push(payout);
    return payout;
  }
}

class MockBalanceProvider {
  constructor(private readonly balances: BalanceRow[], private failCount = 0) {}

  async getBalances(_offeringId: string, _period: any): Promise<BalanceRow[]> {
    if (this.failCount > 0) {
      this.failCount--;
      throw new Error('Stellar RPC Timeout');
    }
    return this.balances;
  }
}

describe('DistributionEngine', () => {
  it('prorates payouts correctly', async () => {
    const repo = new MockDistributionRepo();
    const balances = [
      { investor_id: 'i1', balance: 70 },
      { investor_id: 'i2', balance: 30 },
    ];

    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    const result = await engine.distribute(
      'off-1',
      { id: 'p1', start: new Date('2026-01-01'), end: new Date('2026-01-31') },
      100,
    );

    expect(result.payouts).toEqual([
      { investor_id: 'i1', amount: '70.00' },
      { investor_id: 'i2', amount: '30.00' },
    ]);
    expect(repo.runs).toHaveLength(1);
    expect(repo.payouts).toHaveLength(2);
    expect(repo.runs[0].status).toBe('completed');
  });

  it('is idempotent when called multiple times', async () => {
    const repo = new MockDistributionRepo();
    const balances = [{ investor_id: 'i1', balance: 100 }];
    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    const period = { id: 'p1', start: new Date(), end: new Date() };

    const res1 = await engine.distribute('off-1', period, 50);
    const res2 = await engine.distribute('off-1', period, 50);

    expect(res1.distributionRun.id).toBe(res2.distributionRun.id);
    expect(res1.payouts).toEqual(res2.payouts);
    expect(repo.runs).toHaveLength(1);
    expect(repo.payouts).toHaveLength(1);
  });

  it('resumes from a partial failure', async () => {
    const repo = new MockDistributionRepo();
    const balances = [
      { investor_id: 'i1', balance: 50 },
      { investor_id: 'i2', balance: 50 },
    ];
    
    // Fail on the SECOND payout (index 1)
    repo.failSpecificPayouts = [1];

    const engine = new DistributionEngine(
      null,
      repo,
      new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
    );

    const period = { id: 'p2', start: new Date(), end: new Date() };

    await expect(engine.distribute('off-2', period, 100)).rejects.toThrow();
    
    expect(repo.runs).toHaveLength(1);
    expect(repo.payouts).toHaveLength(1); // First payout should have succeeded
    expect(repo.runs[0].status).toBe('failed');

    // Clear failure for retry
    repo.failSpecificPayouts = [];

    // Second run should resume
    const res2 = await engine.distribute('off-2', period, 100);
    
    expect(repo.runs).toHaveLength(1); // Same run
    expect(repo.payouts).toHaveLength(2); // Now both payouts
    expect(repo.runs[0].status).toBe('completed');
    expect(res2.payouts).toHaveLength(2);
  });

  it('classifies and retries Stellar RPC failures', async () => {
    const repo = new MockDistributionRepo();
    const balances = [{ investor_id: 'i1', balance: 100 }];
    
    const provider = new MockBalanceProvider(balances, 1); // Fails once
    const engine = new DistributionEngine(
      null,
      repo,
      provider,
      { maxRetries: 2, initialDelayMs: 0, backoffFactor: 1 },
    );

    const result = await engine.distribute('off-3', { id: 'p3', start: new Date(), end: new Date() }, 10);
    expect(result.payouts[0].amount).toBe('10.00');
  });

  it('throws after exhausting retries for balance fetching', async () => {
    const provider = new MockBalanceProvider([], 3); // Fails 3 times
    const engine = new DistributionEngine(null, new MockDistributionRepo(), provider, { maxRetries: 2, initialDelayMs: 0 });
    await expect(engine.distribute('off-fail', { id: 'p', start: new Date(), end: new Date() }, 100)).rejects.toThrow(/Failed to acquire balances/);
  });

  it('throws if no balances are found', async () => {
    const provider = new MockBalanceProvider([]);
    const engine = new DistributionEngine(null, new MockDistributionRepo(), provider, { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-empty', { id: 'p', start: new Date(), end: new Date() }, 100)).rejects.toThrow(/No investors or balances found/);
  });

  it('throws if total balance is zero', async () => {
    const provider = new MockBalanceProvider([{ investor_id: 'i1', balance: 0 }]);
    const engine = new DistributionEngine(null, new MockDistributionRepo(), provider, { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-zero', { id: 'p', start: new Date(), end: new Date() }, 100)).rejects.toThrow(/Total balance must be > 0/);
  });

  it('adjusts rounding to match revenue amount', async () => {
    const balances = [
      { investor_id: 'i1', balance: 1 },
      { investor_id: 'i2', balance: 1 },
      { investor_id: 'i3', balance: 1 },
    ];
    const engine = new DistributionEngine(null, new MockDistributionRepo(), new MockBalanceProvider(balances), { maxRetries: 1, initialDelayMs: 0 });
    const result = await engine.distribute('off-round', { id: 'p', start: new Date(), end: new Date() }, 100);
    const sum = result.payouts.reduce((s, p) => s + Number(p.amount), 0);
    expect(sum).toBe(100.00);
    // One should be 33.34, others 33.33
    const counts = result.payouts.reduce((acc: any, p) => { acc[p.amount] = (acc[p.amount] || 0) + 1; return acc; }, {});
    expect(counts['33.34']).toBe(1);
    expect(counts['33.33']).toBe(2);
  });

  it('throws if run initialization fails after retries', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextRunCount = 5;
    const engine = new DistributionEngine(null, repo, new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]), { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-run-fail', { id: 'p', start: new Date(), end: new Date() }, 100)).rejects.toThrow(/Failed to initialize distribution run/);
  });

  it('uses offeringRepo if balanceProvider is missing', async () => {
    const offeringRepo = {
      getInvestors: jest.fn().mockResolvedValue([{ investor_id: 'i1', balance: 100 }])
    };
    const engine = new DistributionEngine(offeringRepo, new MockDistributionRepo(), undefined, { maxRetries: 1, initialDelayMs: 0 });
    const result = await engine.distribute('off-repo', { id: 'p', start: new Date(), end: new Date() }, 100);
    expect(result.payouts).toHaveLength(1);
    expect(offeringRepo.getInvestors).toHaveBeenCalled();
  });

  it('uses listInvestors if getInvestors is missing', async () => {
    const offeringRepo = {
      listInvestors: jest.fn().mockResolvedValue([{ investor_id: 'i1', balance: 100 }])
    };
    const engine = new DistributionEngine(offeringRepo, new MockDistributionRepo(), undefined, { maxRetries: 1, initialDelayMs: 0 });
    const result = await engine.distribute('off-list', { id: 'p', start: new Date(), end: new Date() }, 100);
    expect(result.payouts).toHaveLength(1);
    expect(offeringRepo.listInvestors).toHaveBeenCalled();
  });

  it('throws if no balance source is available', async () => {
    const engine = new DistributionEngine(null, new MockDistributionRepo(), undefined, { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-none', { id: 'p', end: new Date() } as any, 100)).rejects.toThrow(/Failed to acquire balances: UNKNOWN/);
  });

  // ── Retry storm: exhausted budget throws, does not loop forever ────────────

  it('throws after maxRetries exhausted on balance fetch', async () => {
    const repo = new MockDistributionRepo();
    let calls = 0;
    const flakyProvider = {
      getBalances: async () => { 
        calls++; 
        throw new Error('flaky'); 
      },
    };
    const engine = new DistributionEngine(null, repo, flakyProvider, { maxRetries: 3, initialDelayMs: 0 });

    await expect(
      engine.distribute('off-5', { id: 'p5', start: new Date(), end: new Date() }, 10),
    ).rejects.toThrow(/Failed to acquire balances: UNKNOWN/);

    expect(calls).toBe(3); // exactly maxRetries, no infinite loop
  });

  it('throws after maxRetries exhausted on payout creation', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextPayoutCount = 99; // always fail
    const engine = new DistributionEngine(
      null, repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 2, initialDelayMs: 0 },
    );

    await expect(
      engine.distribute('off-6', { id: 'p6', start: new Date(), end: new Date() }, 10),
    ).rejects.toThrow(/Distribution failed: UNKNOWN/);
  });

  it('succeeds on last allowed retry (boundary)', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextRunCount = 2; // fail twice, succeed on 3rd (maxRetries=3)
    const engine = new DistributionEngine(
      null, repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 3, initialDelayMs: 0 },
    );

    const result = await engine.distribute('off-7', { id: 'p7', start: new Date(), end: new Date() }, 50);
    expect(result.payouts).toEqual([{ investor_id: 'i1', amount: '50.00' }]);
  });

  it('applies exponential backoff correctly', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextRunCount = 2; // Fails twice
    
    // Use a small initial delay to keep test fast but measurable
    const initialDelayMs = 10;
    const backoffFactor = 2;
    
    const engine = new DistributionEngine(
      null, repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 3, initialDelayMs, backoffFactor }
    );

    const start = Date.now();
    await engine.distribute('off-backoff', { id: 'p-backoff', start: new Date(), end: new Date() }, 100);
    const duration = Date.now() - start;

    // Expected delays: 10ms (1st retry) + 20ms (2nd retry) = 30ms total
    expect(duration).toBeGreaterThanOrEqual(30);
  });

  // ── Stellar result-code classification wired into distribution errors ──────

  it('classifies a Stellar tx_bad_seq error as non-retryable TX_RESULT_CODE', () => {
    const err = { status: 400, extras: { result_codes: { transaction: 'tx_bad_seq' } } };
    const context = { operation: 'test' };
    const failure = classifyStellarRPCFailure(err, context);
    expect(failure.class).toBe(StellarRPCFailureClass.TX_RESULT_CODE);
    expect(failure.shouldRetry).toBe(false);
  });

  it('classifies a Stellar op_underfunded error as non-retryable OP_RESULT_CODE', () => {
    const err = { status: 400, extras: { result_codes: { transaction: 'tx_failed', operations: ['op_underfunded'] } } };
    const context = { operation: 'test' };
    const failure = classifyStellarRPCFailure(err, context);
    expect(failure.class).toBe(StellarRPCFailureClass.OP_RESULT_CODE);
    expect(failure.shouldRetry).toBe(false);
  });

  it('classifies a 503 upstream error as retryable', () => {
    const err = { status: 503 };
    const context = { operation: 'test' };
    const failure = classifyStellarRPCFailure(err, context);
    expect(failure.class).toBe(StellarRPCFailureClass.UPSTREAM_ERROR);
    expect(failure.shouldRetry).toBe(true);
  });

  it('throws when offeringId is empty', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(null, repo, new MockBalanceProvider([]), { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('', { id: 'p', start: new Date(), end: new Date() }, 10)).rejects.toThrow('offeringId is required');
  });

  it('throws when revenueAmount is zero', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(null, repo, new MockBalanceProvider([{ investor_id: 'i1', balance: 1 }]), { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-x', { id: 'p', start: new Date(), end: new Date() }, 0)).rejects.toThrow('revenueAmount must be > 0');
  });

  it('throws when no investors found', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(null, repo, new MockBalanceProvider([]), { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-x', { id: 'px', start: new Date(), end: new Date() }, 10)).rejects.toThrow('No investors or balances found');
  });

  it('uses offeringRepo.getInvestors when no balanceProvider', async () => {
    const repo = new MockDistributionRepo();
    const offeringRepo = { getInvestors: async () => [{ investor_id: 'i1', balance: 100 }] };
    const engine = new DistributionEngine(offeringRepo, repo, undefined, { maxRetries: 1, initialDelayMs: 0 });
    const result = await engine.distribute('off-8', { id: 'p8', start: new Date(), end: new Date() }, 10);
    expect(result.payouts).toEqual([{ investor_id: 'i1', amount: '10.00' }]);
  });

  it('uses offeringRepo.listInvestors as fallback', async () => {
    const repo = new MockDistributionRepo();
    const offeringRepo = { listInvestors: async () => [{ investor_id: 'i2', balance: 50 }] };
    const engine = new DistributionEngine(offeringRepo, repo, undefined, { maxRetries: 1, initialDelayMs: 0 });
    const result = await engine.distribute('off-9', { id: 'p9', start: new Date(), end: new Date() }, 20);
    expect(result.payouts).toEqual([{ investor_id: 'i2', amount: '20.00' }]);
  });

  it('throws when no balance source is available', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(null, repo, undefined, { maxRetries: 1, initialDelayMs: 0 });
    await expect(engine.distribute('off-x', { id: 'px', start: new Date(), end: new Date() }, 10)).rejects.toThrow(/Failed to acquire balances: UNKNOWN/);
  });

  it('logs retries when logRetries is true', async () => {
    const repo = new MockDistributionRepo();
    repo.failNextRunCount = 1;
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = new DistributionEngine(
      null, repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 2, initialDelayMs: 0, logRetries: true },
    );
    await engine.distribute('off-log', { id: 'plog', start: new Date(), end: new Date() }, 5);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('[DistributionEngine]'));
    spy.mockRestore();
  });

  it('handles failure when updating run status to processing', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(
      null, repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 1, initialDelayMs: 0 }
    );
    
    // Create an existing run that is NOT in 'processing' status
    const period = { id: 'p-update-fail', start: new Date(), end: new Date() };
    repo.runs.push({
      id: 'existing-run',
      offering_id: 'off-update-fail',
      period_id: period.id,
      total_amount: '100.00',
      status: 'pending' // Not processing
    });

    // Call to update status to 'processing' should fail
    repo.failNextUpdateStatusCount = 1;
    
    await expect(
      engine.distribute('off-update-fail', period, 100)
    ).rejects.toThrow(/Failed to update distribution status/);
  });

  it('handles failure when updating final run status', async () => {
    const repo = new MockDistributionRepo();
    const engine = new DistributionEngine(
      null, repo,
      new MockBalanceProvider([{ investor_id: 'i1', balance: 100 }]),
      { maxRetries: 1, initialDelayMs: 0 }
    );
    
    // We want the SECOND update to fail.
    // 1. updateRunStatus(run.id, 'processing') -> succeeds
    // 2. updateRunStatus(run.id, 'completed') -> fails
    
    // Ensure we trigger the first update by having an existing pending run
    const period = { id: 'p-final-fail', start: new Date(), end: new Date() };
    repo.runs.push({
      id: 'existing-run-final',
      offering_id: 'off-final-fail',
      period_id: period.id,
      total_amount: '100.00',
      status: 'pending'
    });

    let callCount = 0;
    const originalUpdate = repo.updateRunStatus.bind(repo);
    repo.updateRunStatus = async (runId: string, status: string) => {
      callCount++;
      if (callCount === 2) {
        throw new Error('Final update failed');
      }
      return originalUpdate(runId, status);
    };

    // This should NOT throw because the final update is wrapped in a try/catch that just logs
    const result = await engine.distribute('off-final-fail', period, 100);
    // The status should still be 'processing' because the final update failed
    expect(repo.runs[0].status).toBe('processing');
  });

  describe('Batch Processing and Stellar RPC Classification', () => {
    it('processes payouts in batches (≥50 investors)', async () => {
      const repo = new MockDistributionRepo();
      const investorCount = 120;
      const balances: BalanceRow[] = [];
      for (let i = 0; i < investorCount; i++) {
        balances.push({ investor_id: `i${i}`, balance: 100 });
      }

      const batchSize = 50;
      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0, batchSize }
      );

      const period = { id: 'p-batch', start: new Date(), end: new Date() };
      const result = await engine.distributeWithBatch('off-batch', period, 12000);

      expect(result.successfulPayouts).toHaveLength(investorCount);
      expect(result.totalPayouts).toBe(investorCount);
      expect(repo.payouts).toHaveLength(investorCount);
      expect(result.distributionRun.status).toBe('completed');
    });

    it('captures partial failures in a batch with Stellar RPC classification', async () => {
      const repo = new MockDistributionRepo();
      const balances = [
        { investor_id: 'i1', balance: 100 },
        { investor_id: 'i2', balance: 100 },
        { investor_id: 'i3', balance: 100 },
      ];

      // Simulate a Stellar RPC error for the second investor
      const stellarError = { 
        status: 400, 
        extras: { 
          result_codes: { transaction: 'tx_bad_seq' } 
        } 
      };
      
      const originalCreatePayout = repo.createPayout.bind(repo);
      repo.createPayout = async (input: any) => {
        if (input.investor_id === 'i2') {
          throw stellarError;
        }
        return originalCreatePayout(input);
      };

      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0 }
      );

      const period = { id: 'p-partial-stellar', start: new Date(), end: new Date() };
      const result = await engine.distributeWithBatch('off-partial-stellar', period, 300);

      expect(result.successfulPayouts).toHaveLength(2);
      expect(result.failedPayouts).toHaveLength(1);
      expect(result.failedPayouts[0].investor_id).toBe('i2');
      expect(result.failedPayouts[0].errorClass).toBe(StellarRPCFailureClass.TX_RESULT_CODE);
      expect(result.failedPayouts[0].error).toBe(`Action failed with ${StellarRPCFailureClass.TX_RESULT_CODE}`);
      
      // Ensure the run status is 'failed' due to partial failure
      expect(result.distributionRun.status).toBe('failed');
    });

    it('handles unexpected errors in batch processing loop', async () => {
      const repo = new MockDistributionRepo();
      const balances = [
        { investor_id: 'i1', balance: 100 },
        { investor_id: 'i2', balance: 100 },
      ];

      // Force a total batch failure by throwing in slice or some unexpected place if possible,
      // but here we can mock distributeRepo.createPayout to throw something non-Stellar
      const originalCreatePayout = repo.createPayout.bind(repo);
      repo.createPayout = async (input: any) => {
        if (input.investor_id === 'i1') {
          throw new Error('Total batch collapse');
        }
        return originalCreatePayout(input);
      };

      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0 }
      );

      const period = { id: 'p-batch-error', start: new Date(), end: new Date() };
      const result = await engine.distributeWithBatch('off-batch-error', period, 200);

      // The loop for i1 fails, caught by inner try/catch
      // i2 should still be processed
      expect(result.successfulPayouts).toHaveLength(1);
      expect(result.failedPayouts).toHaveLength(1);
      expect(result.failedPayouts[0].errorClass).toBe(StellarRPCFailureClass.UNKNOWN);
    });

    it('distribute() throws a clean error when batch has Stellar failures', async () => {
      const repo = new MockDistributionRepo();
      const balances = [{ investor_id: 'i1', balance: 100 }];
      
      repo.createPayout = async () => {
        throw { status: 503 }; // UPSTREAM_ERROR
      };

      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0 }
      );

      const period = { id: 'p-dist-error', start: new Date(), end: new Date() };
      await expect(engine.distribute('off-dist-error', period, 100))
        .rejects.toThrow(`Distribution failed: ${StellarRPCFailureClass.UPSTREAM_ERROR}`);
    });

    it('handles unexpected errors in the outer batch processing catch block', async () => {
      const repo = new MockDistributionRepo();
      const balances = [{ investor_id: 'i1', balance: 100 }];
      
      const engine = new DistributionEngine(
        null,
        repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0 }
      );

      const period = { id: 'p-outer-fail', start: new Date(), end: new Date() };
      
      // Monkey-patch fetchBalances to return an array that will eventually produce a poisoned 'rounded' array
      (engine as any).fetchBalances = async () => {
        const b = [{ investor_id: 'i1', balance: 100 }];
        const originalMap = b.map;
        (b as any).map = function(...args: any[]) {
          const rawShares = originalMap.apply(this, args);
          const originalMap2 = rawShares.map;
          rawShares.map = function(...args2: any[]) {
            const rounded = originalMap2.apply(this, args2);
            const originalSlice = rounded.slice;
            rounded.slice = function(...args3: any[]) {
              const batch = originalSlice.apply(this, args3);
              // Poison the batch to make the loop at line 287 throw
              // 'for (const r of batch)' will throw if batch contains null
              batch[0] = null; 
              return batch;
            };
            return rounded;
          };
          return rawShares;
        };
        return b;
      };

      const result = await engine.distributeWithBatch('off-outer-fail', period, 100);
      expect(result.distributionRun.status).toBe('failed');
    });

    it('handles failure when updating final run status in distributeWithBatch', async () => {
      const repo = new MockDistributionRepo();
      const balances = [{ investor_id: 'i1', balance: 100 }];
      const engine = new DistributionEngine(
        null, repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0 }
      );
      
      const period = { id: 'p-final-fail-batch', start: new Date(), end: new Date() };
      
      let updateCallCount = 0;
      const originalUpdate = repo.updateRunStatus.bind(repo);
      repo.updateRunStatus = async (runId: string, status: string) => {
        // We want to fail the FINAL update (status='completed' or 'failed')
        if (status === 'completed' || status === 'failed') {
          updateCallCount++;
          if (updateCallCount === 1) {
            throw new Error('Final update failed batch');
          }
        }
        return originalUpdate(runId, status);
      };

      const result = await engine.distributeWithBatch('off-final-fail-batch', period, 100);
      // It should be 'processing' because the final update failed and line 349 was never reached.
      expect(result.distributionRun.status).toBe('processing');
    });

    it('uses default options when none are provided', async () => {
      const repo = new MockDistributionRepo();
      const balances = [{ investor_id: 'i1', balance: 100 }];
      const engine = new DistributionEngine(null, repo, new MockBalanceProvider(balances));
      
      const period = { id: 'p-default-opts', start: new Date(), end: new Date() };
      const result = await engine.distributeWithBatch('off-default', period, 100);
      expect(result.distributionRun.status).toBe('completed');
    });

    it('throws error for invalid period in distributeWithBatch', async () => {
      const engine = new DistributionEngine(null, null);
      await expect(engine.distributeWithBatch('off-1', {} as any, 100))
        .rejects.toThrow('Valid distribution period with ID is required');
    });

    it('throws specific error message in distribute for partial failures', async () => {
      const repo = new MockDistributionRepo();
      const balances = [{ investor_id: 'i1', balance: 100 }];
      const engine = new DistributionEngine(
        null, repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0 }
      );
      
      repo.failNextPayoutCount = 1;
      const period = { id: 'p-partial-fail', start: new Date(), end: new Date() };
      
      // Since it has errorClass 'UNKNOWN' by default for random errors
      await expect(engine.distribute('off-partial', period, 100))
        .rejects.toThrow(/Distribution failed: UNKNOWN/);
    });

    it('handles max share adjustment correctly with multiple investors', async () => {
      const repo = new MockDistributionRepo();
      const balances = [
        { investor_id: 'i1', balance: 10 },
        { investor_id: 'i2', balance: 10 },
        { investor_id: 'i3', balance: 10 },
      ];
      const engine = new DistributionEngine(
        null, repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0 }
      );
      
      const period = { id: 'p-max-adj', start: new Date(), end: new Date() };
      const result = await engine.distributeWithBatch('off-max-adj', period, 100);
      
      const sum = result.successfulPayouts.reduce((s, p) => s + Number(p.amount), 0);
      expect(sum).toBe(100);
      const amounts = result.successfulPayouts.map(p => Number(p.amount));
      expect(amounts).toContain(33.34);
      expect(amounts).toContain(33.33);
      
      // Separate repo for the second case to avoid pollution
      const repo2 = new MockDistributionRepo();
      const engine2 = new DistributionEngine(
        null, repo2,
        new MockBalanceProvider([{ investor_id: 'i1', balance: 10 }, { investor_id: 'i2', balance: 20 }]),
        { maxRetries: 1, initialDelayMs: 0 }
      );
      const result2 = await engine2.distributeWithBatch('off-max-adj-2', period, 100.01);
      expect(result2.successfulPayouts.length).toBe(2);
    });

    it('updates run status to processing if it exists but is not processing', async () => {
      const repo = new MockDistributionRepo();
      const balances = [{ investor_id: 'i1', balance: 100 }];
      const engine = new DistributionEngine(
        null, repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0 }
      );
      
      const period = { id: 'p-resume', start: new Date(), end: new Date() };
      // Create a run in 'pending' status
      await repo.createDistributionRun({
        offering_id: 'off-resume',
        period_id: period.id,
        total_amount: '100.00',
        run_at: period.end,
        status: 'pending'
      });
      
      const result = await engine.distributeWithBatch('off-resume', period, 100);
       expect(result.distributionRun.status).toBe('completed');
     });
 
     it('handles non-Error objects in catch blocks', async () => {
        const repo = new MockDistributionRepo();
        const balances = [{ investor_id: 'i1', balance: 100 }];
        const engine = new DistributionEngine(
          null, repo,
          new MockBalanceProvider(balances),
          { maxRetries: 1, initialDelayMs: 0 }
        );
        
        repo.createPayout = async () => {
          throw "Unexpected string error";
        };
  
        const period = { id: 'p-string-err', start: new Date(), end: new Date() };
        const result = await engine.distributeWithBatch('off-string-err', period, 100);
        // It uses the failure class message
        expect(result.failedPayouts[0].error).toBe('Action failed with UNKNOWN');
      });
  
      it('throws error with errorClass in distribute', async () => {
      const repo = new MockDistributionRepo();
      const balances = [{ investor_id: 'i1', balance: 100 }];
      const engine = new DistributionEngine(
        null, repo,
        new MockBalanceProvider(balances),
        { maxRetries: 1, initialDelayMs: 0 }
      );
      
      repo.createPayout = async () => {
        const err = new Error('Too many requests');
        (err as any).status = 429;
        throw err;
      };

      const period = { id: 'p-class-fail', start: new Date(), end: new Date() };
      await expect(engine.distribute('off-class', period, 100))
        .rejects.toThrow(/Distribution failed: RATE_LIMIT/);
    });
 
      it('throws error when updateRunStatus fails during initialization', async () => {
        const repo = new MockDistributionRepo();
        const balances = [{ investor_id: 'i1', balance: 100 }];
        const engine = new DistributionEngine(
          null, repo,
          new MockBalanceProvider(balances),
          { maxRetries: 1, initialDelayMs: 0 }
        );
        
        const period = { id: 'p-init-fail', start: new Date(), end: new Date() };
        // Create a run in 'pending' status
        await repo.createDistributionRun({
          offering_id: 'off-init-fail',
          period_id: period.id,
          total_amount: '100.00',
          run_at: period.end,
          status: 'pending'
        });
        
        repo.failNextUpdateStatusCount = 1;
        await expect(engine.distributeWithBatch('off-init-fail', period, 100))
          .rejects.toThrow(/Failed to update distribution status: UNKNOWN/);
      });
    });
  });
