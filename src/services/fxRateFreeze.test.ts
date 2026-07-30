import DistributionEngine from './distributionEngine';
import { FxConversionEngine, InMemoryRateProvider } from './fxConversionEngine';
import { Decimal } from '../lib/decimal';

class MockDistributionRepo {
  public runs: any[] = [];
  public payouts: any[] = [];

  async findRunByParams(offeringId: string, periodId: string, amount: string): Promise<any> {
    return this.runs.find(
      (r) => r.offering_id === offeringId && r.period_id === periodId && r.total_amount === amount
    );
  }

  async getPayoutsForRun(runId: string): Promise<any[]> {
    return this.payouts.filter((p) => p.distribution_id === runId);
  }

  async updateRunStatus(runId: string, status: string): Promise<void> {
    const run = this.runs.find((r) => r.id === runId);
    if (run) {
      run.status = status;
    }
  }

  async createDistributionRun(input: any): Promise<any> {
    const run = {
      id: `run-${this.runs.length + 1}`,
      status: 'pending',
      ...input,
    };
    this.runs.push(run);
    return run;
  }

  async createPayout(input: any): Promise<any> {
    const payout = {
      id: `p-${this.payouts.length + 1}`,
      ...input,
    };
    this.payouts.push(payout);
    return payout;
  }
}

class MockAuditLogRepo {
  public logs: any[] = [];

  async createAuditLog(input: any): Promise<any> {
    const log = { id: `audit-${this.logs.length + 1}`, ...input, created_at: new Date() };
    this.logs.push(log);
    return log;
  }
}

function makeFxEngine(): FxConversionEngine {
  const provider = new InMemoryRateProvider();
  provider.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92', 300000);
  provider.setRateFromValues('USD/USD', '1.00', '1.00', '1.00', 300000);
  return new FxConversionEngine(provider);
}

describe('Rate-Freeze Windows around Distributions (#702)', () => {
  it('freezes FX rate idempotently per run-id / context', async () => {
    const fxEngine = makeFxEngine();
    const context = 'off-100-period-1';

    const rate1 = await fxEngine.freezeRate(context, 'USD', 'EUR');
    expect(rate1).toBeDefined();
    expect(rate1.id).toBeDefined();

    const rate2 = await fxEngine.freezeRate(context, 'USD', 'EUR');
    expect(rate2.id).toBe(rate1.id);
    expect(rate2.mid.toString()).toBe(rate1.mid.toString());

    const retrieved = fxEngine.getFrozenRate(context);
    expect(retrieved?.id).toBe(rate1.id);
  });

  it('pins rate for distribution run and attaches frozen_fx_rate_id to each payout record', async () => {
    const repo = new MockDistributionRepo();
    const auditRepo = new MockAuditLogRepo();
    const fxEngine = makeFxEngine();

    const balances = [
      { investor_id: 'inv-1', balance: 600 },
      { investor_id: 'inv-2', balance: 400 },
    ];

    const engine = new DistributionEngine(
      null,
      repo,
      { getBalances: async () => balances },
      { maxRetries: 1, initialDelayMs: 0 },
      undefined,
      null,
      null,
      fxEngine,
      auditRepo
    );

    const period = { id: 'p-2026-01', start: new Date('2026-01-01'), end: new Date('2026-01-31') };
    const result = await engine.distribute('off-702', period, 1000);

    expect(result.distributionRun).toBeDefined();
    expect(result.distributionRun.frozen_fx_rate_id).toBeDefined();
    expect(result.successfulPayouts.length).toBe(2);

    // Verify each payout record has frozen_fx_rate_id stored
    expect(repo.payouts.length).toBe(2);
    repo.payouts.forEach((payout) => {
      expect(payout.frozen_fx_rate_id).toBe(result.distributionRun.frozen_fx_rate_id);
    });

    // Verify fx.rate.frozen audit event was emitted
    const fxAuditLog = auditRepo.logs.find((log) => log.action === 'fx.rate.frozen');
    expect(fxAuditLog).toBeDefined();
    expect(fxAuditLog.resource).toBe('distribution:off-702:p-2026-01');

    const details = JSON.parse(fxAuditLog.details);
    expect(details.offering_id).toBe('off-702');
    expect(details.period_id).toBe('p-2026-01');
    expect(details.frozen_fx_rate_id).toBe(result.distributionRun.frozen_fx_rate_id);
    expect(details.pair).toBeDefined();
  });

  it('reuses the same frozen rate on retry of a failed run', async () => {
    const repo = new MockDistributionRepo();
    const auditRepo = new MockAuditLogRepo();
    const fxEngine = makeFxEngine();

    const balances = [
      { investor_id: 'inv-1', balance: 500 },
      { investor_id: 'inv-2', balance: 500 },
    ];

    const engine = new DistributionEngine(
      null,
      repo,
      { getBalances: async () => balances },
      { maxRetries: 1, initialDelayMs: 0 },
      undefined,
      null,
      null,
      fxEngine,
      auditRepo
    );

    const period = { id: 'p-2026-02', start: new Date('2026-02-01'), end: new Date('2026-02-28') };

    // Initial run
    const result1 = await engine.distribute('off-702-retry', period, 500);
    const initialFrozenRateId = result1.distributionRun.frozen_fx_rate_id;
    expect(initialFrozenRateId).toBeDefined();

    // Mark run as failed to simulate a retryable state
    await repo.updateRunStatus(result1.distributionRun.id, 'failed');

    // Simulate retry by triggering distribute again
    const result2 = await engine.distribute('off-702-retry', period, 500);

    // Verify the same frozen rate ID is reused
    expect(result2.distributionRun.frozen_fx_rate_id).toBe(initialFrozenRateId);
  });

  it('supports frozenContext in fxConversionEngine.convert', async () => {
    const fxEngine = makeFxEngine();
    const context = 'custom-ctx-1';
    const frozen = await fxEngine.freezeRate(context, 'USD', 'EUR');

    const converted = await fxEngine.convert(new Decimal('100'), 'USD', 'EUR', {
      frozenContext: context,
    });

    expect(converted.rate.id).toBe(frozen.id);
    expect(converted.path.description).toContain(`frozen:${context}`);
  });
});
