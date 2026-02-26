import assert from 'assert';
import DistributionEngine from './distributionEngine';

// Mock distributionRepo that records created runs and payouts
class MockDistributionRepo {
  runs: any[] = [];
  payouts: any[] = [];
  async createDistributionRun(input: any) {
    const run = { id: `run-${this.runs.length + 1}`, ...input };
    this.runs.push(run);
    return run;
  }
  async createPayout(input: any) {
    const p = { id: `p-${this.payouts.length + 1}`, ...input };
    this.payouts.push(p);
    return p;
  }
}

// Mock balance provider
class MockBalanceProvider {
  constructor(private rows: any[]) {}
  async getBalances(_offeringId: string, _period: any) {
    return this.rows;
  }
}

(async function run() {
  // Test 1: simple proration
  const distRepo1 = new MockDistributionRepo();
  const balances1 = [
    { investor_id: 'i1', balance: 70 },
    { investor_id: 'i2', balance: 30 },
  ];
  const engine1 = new DistributionEngine(null, distRepo1, new MockBalanceProvider(balances1));
  const res1 = await engine1.distribute('off-1', { start: new Date(), end: new Date() }, 100);
  assert(res1.payouts.length === 2);
  const a1 = res1.payouts.find((p) => p.investor_id === 'i1')!;
  const a2 = res1.payouts.find((p) => p.investor_id === 'i2')!;
  assert(a1.amount === '70.00', `expected 70.00 got ${a1.amount}`);
  assert(a2.amount === '30.00', `expected 30.00 got ${a2.amount}`);

  // Test 2: rounding / equality
  const distRepo2 = new MockDistributionRepo();
  const balances2 = [{ investor_id: 'i1', balance: 1 }, { investor_id: 'i2', balance: 1 }, { investor_id: 'i3', balance: 1 }];
  const engine2 = new DistributionEngine(null, distRepo2, new MockBalanceProvider(balances2));
  const res2 = await engine2.distribute('off-2', { start: new Date(), end: new Date() }, 100);
  // sum check
  const sum = res2.payouts.reduce((s, p) => s + Number(p.amount), 0);
  assert(Math.abs(sum - 100) < 0.0001, `expected sum 100 got ${sum}`);

  // Test 3: zero total balance -> should throw
  const distRepo3 = new MockDistributionRepo();
  const engine3 = new DistributionEngine(null, distRepo3, new MockBalanceProvider([{ investor_id: 'i1', balance: 0 }]));
  let threw = false;
  try {
    await engine3.distribute('off-3', { start: new Date(), end: new Date() }, 50);
  } catch (e) {
    threw = true;
  }
  assert(threw, 'expected error when total balance is zero');

  console.log('distributionEngine tests passed');
})();
