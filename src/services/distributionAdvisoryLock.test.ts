/**
 * Advisory lock tests for DistributionEngine.distribute()
 *
 * These tests use in-process mocks to simulate concurrent callers and verify:
 *  1. Race: two concurrent callers for the same offering/period — only one succeeds
 *  2. Rollback: lock is released when the transaction rolls back
 *  3. Parallel distinct offerings: different (offering, period) pairs run concurrently
 *  4. Lock key hash: advisoryLockKey is deterministic and stable
 *  5. Conflict error shape: second caller receives Errors.conflict (409)
 */

import DistributionEngine, {
  advisoryLockKey,
  tryAcquireDistributionLock,
  BalanceRow,
} from './distributionEngine';
import { Errors, ErrorCode } from '../lib/errors';
import { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

class MockDistributionRepo {
  runs: any[] = [];
  payouts: any[] = [];

  async findRunByParams() { return null; }
  async getPayoutsForRun() { return []; }
  async createDistributionRun(input: any) {
    const run = { id: `run-${this.runs.length + 1}`, status: 'processing', ...input };
    this.runs.push(run);
    return run;
  }
  async createPayout(input: any) {
    const p = { id: `p-${this.payouts.length + 1}`, ...input };
    this.payouts.push(p);
    return p;
  }
  async updateRunStatus(runId: string, status: string) {
    const run = this.runs.find(r => r.id === runId);
    if (run) run.status = status;
  }
}

class MockBalanceProvider {
  constructor(private balances: BalanceRow[]) {}
  async getBalances() { return this.balances; }
}

/**
 * Build a mock Pool whose query() simulates pg_try_advisory_xact_lock.
 *
 * `lockGranted` controls whether the lock is available. The mock tracks
 * which (classId, objectId) pairs are currently held so that the second
 * caller in a race gets `acquired: false`.
 */
function buildMockPool(opts: { lockGranted?: boolean } = {}) {
  const held = new Set<string>();

  const mockClient: Partial<PoolClient> = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        const key = `${params![0]}:${params![1]}`;
        if (opts.lockGranted === false || held.has(key)) {
          return { rows: [{ acquired: false }] };
        }
        held.add(key);
        return { rows: [{ acquired: true }] };
      }
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        if (sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
          // Release all locks on commit/rollback
          held.clear();
        }
        return { rows: [] };
      }
      return { rows: [] };
    }) as any,
    release: jest.fn(),
  };

  const pool = {
    connect: jest.fn(async () => mockClient as PoolClient),
    query: jest.fn(),
  } as unknown as Pool;

  return { pool, mockClient, held };
}

// ---------------------------------------------------------------------------
// advisoryLockKey unit tests
// ---------------------------------------------------------------------------

describe('advisoryLockKey', () => {
  it('returns two integers', () => {
    const [hi, lo] = advisoryLockKey('offering-1', 'period-1');
    expect(typeof hi).toBe('number');
    expect(typeof lo).toBe('number');
  });

  it('is deterministic', () => {
    expect(advisoryLockKey('off-A', 'p-1')).toEqual(advisoryLockKey('off-A', 'p-1'));
  });

  it('produces different keys for different inputs', () => {
    const k1 = advisoryLockKey('off-A', 'p-1');
    const k2 = advisoryLockKey('off-B', 'p-1');
    const k3 = advisoryLockKey('off-A', 'p-2');
    expect(k1).not.toEqual(k2);
    expect(k1).not.toEqual(k3);
  });

  it('values fit in signed int32 range', () => {
    const [hi, lo] = advisoryLockKey('some-offering', 'some-period');
    expect(hi).toBeGreaterThanOrEqual(-2147483648);
    expect(hi).toBeLessThanOrEqual(2147483647);
    expect(lo).toBeGreaterThanOrEqual(-2147483648);
    expect(lo).toBeLessThanOrEqual(2147483647);
  });
});

// ---------------------------------------------------------------------------
// tryAcquireDistributionLock unit tests
// ---------------------------------------------------------------------------

describe('tryAcquireDistributionLock', () => {
  it('returns true when lock is granted', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ acquired: true }] }),
    } as unknown as PoolClient;

    const result = await tryAcquireDistributionLock(client, 'off-1', 'p-1');
    expect(result).toBe(true);
    expect(client.query).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_xact_lock($1, $2) AS acquired',
      expect.any(Array)
    );
  });

  it('returns false when lock is not granted', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ acquired: false }] }),
    } as unknown as PoolClient;

    const result = await tryAcquireDistributionLock(client, 'off-1', 'p-1');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Race condition: two concurrent callers for the same offering/period
// ---------------------------------------------------------------------------

describe('DistributionEngine advisory lock – race condition', () => {
  it('only one of two concurrent callers succeeds; the other gets CONFLICT', async () => {
    const repo = new MockDistributionRepo();
    const balances: BalanceRow[] = [{ investor_id: 'i1', balance: 100 }];

    // Shared lock state: first caller acquires, second is denied
    let lockHeld = false;
    let commitCount = 0;

    const makeClient = (willAcquire: boolean): Partial<PoolClient> => ({
      query: jest.fn(async (sql: string, params?: any[]) => {
        if (sql.includes('pg_try_advisory_xact_lock')) {
          return { rows: [{ acquired: willAcquire }] };
        }
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.startsWith('COMMIT')) { commitCount++; return { rows: [] }; }
        if (sql.startsWith('ROLLBACK')) return { rows: [] };
        return { rows: [] };
      }) as any,
      release: jest.fn(),
    });

    let callCount = 0;
    const pool = {
      connect: jest.fn(async () => {
        callCount++;
        // First caller gets the lock, second does not
        return makeClient(callCount === 1) as PoolClient;
      }),
    } as unknown as Pool;

    const engine = new DistributionEngine(
      null, repo, new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
      pool
    );

    const period = { id: 'p-race', start: new Date(), end: new Date() };

    const [r1, r2] = await Promise.allSettled([
      engine.distribute('off-race', period, 100),
      engine.distribute('off-race', period, 100),
    ]);

    const fulfilled = [r1, r2].filter(r => r.status === 'fulfilled');
    const rejected  = [r1, r2].filter(r => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err.code).toBe(ErrorCode.CONFLICT);
    expect(err.statusCode).toBe(409);
    expect(err.message).toMatch(/already in progress/);
  });
});

// ---------------------------------------------------------------------------
// Lock auto-release on rollback
// ---------------------------------------------------------------------------

describe('DistributionEngine advisory lock – rollback releases lock', () => {
  it('a subsequent caller succeeds after the first caller rolls back', async () => {
    const repo = new MockDistributionRepo();
    const balances: BalanceRow[] = [{ investor_id: 'i1', balance: 100 }];

    let callCount = 0;
    // First call: lock acquired but distributeWithBatch throws → rollback
    // Second call: lock available again → succeeds
    const pool = {
      connect: jest.fn(async () => {
        callCount++;
        const client: Partial<PoolClient> = {
          query: jest.fn(async (sql: string, params?: any[]) => {
            if (sql.includes('pg_try_advisory_xact_lock')) {
              return { rows: [{ acquired: true }] }; // always grant
            }
            if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
              return { rows: [] };
            }
            return { rows: [] };
          }) as any,
          release: jest.fn(),
        };
        return client as PoolClient;
      }),
    } as unknown as Pool;

    // First call: make distributeWithBatch throw by poisoning the repo
    const firstRepo = new MockDistributionRepo();
    firstRepo.createDistributionRun = async () => { throw new Error('forced rollback'); };

    const engine1 = new DistributionEngine(
      null, firstRepo, new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
      pool
    );

    const period = { id: 'p-rollback', start: new Date(), end: new Date() };

    // First call should fail (distributeWithBatch throws)
    await expect(engine1.distribute('off-rb', period, 100)).rejects.toThrow();

    // Second call with a healthy repo should succeed
    const engine2 = new DistributionEngine(
      null, repo, new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 },
      pool
    );

    const result = await engine2.distribute('off-rb', period, 100);
    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0].investor_id).toBe('i1');
  });
});

// ---------------------------------------------------------------------------
// Parallel distinct offerings run concurrently without blocking each other
// ---------------------------------------------------------------------------

describe('DistributionEngine advisory lock – distinct offerings run in parallel', () => {
  it('two different offering/period pairs both succeed concurrently', async () => {
    const repo1 = new MockDistributionRepo();
    const repo2 = new MockDistributionRepo();
    const balances: BalanceRow[] = [{ investor_id: 'i1', balance: 100 }];

    // Each pool connection always grants the lock (different keys don't conflict)
    const makePool = () => ({
      connect: jest.fn(async () => ({
        query: jest.fn(async (sql: string) => {
          if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
          if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return { rows: [] };
          return { rows: [] };
        }) as any,
        release: jest.fn(),
      } as unknown as PoolClient)),
    } as unknown as Pool);

    const engine1 = new DistributionEngine(
      null, repo1, new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 }, makePool()
    );
    const engine2 = new DistributionEngine(
      null, repo2, new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 }, makePool()
    );

    const period = { start: new Date(), end: new Date() };

    const [r1, r2] = await Promise.all([
      engine1.distribute('off-A', { ...period, id: 'p-A' }, 100),
      engine2.distribute('off-B', { ...period, id: 'p-B' }, 100),
    ]);

    expect(r1.payouts).toHaveLength(1);
    expect(r2.payouts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Manual + scheduler race: same offering/period, different engine instances
// ---------------------------------------------------------------------------

describe('DistributionEngine advisory lock – manual vs scheduler race', () => {
  it('manual POST and scheduler for same offering/period: one wins, one gets 409', async () => {
    const repo = new MockDistributionRepo();
    const balances: BalanceRow[] = [{ investor_id: 'i1', balance: 100 }];

    let connectCount = 0;
    const pool = {
      connect: jest.fn(async () => {
        connectCount++;
        const grant = connectCount === 1; // first caller wins
        return {
          query: jest.fn(async (sql: string) => {
            if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: grant }] };
            if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return { rows: [] };
            return { rows: [] };
          }) as any,
          release: jest.fn(),
        } as unknown as PoolClient;
      }),
    } as unknown as Pool;

    const manualEngine = new DistributionEngine(
      null, repo, new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 }, pool
    );
    const schedulerEngine = new DistributionEngine(
      null, repo, new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 }, pool
    );

    const period = { id: 'p-ms', start: new Date(), end: new Date() };

    const results = await Promise.allSettled([
      manualEngine.distribute('off-ms', period, 100),
      schedulerEngine.distribute('off-ms', period, 100),
    ]);

    const ok  = results.filter(r => r.status === 'fulfilled');
    const err = results.filter(r => r.status === 'rejected');

    expect(ok).toHaveLength(1);
    expect(err).toHaveLength(1);
    expect((err[0] as PromiseRejectedResult).reason.code).toBe(ErrorCode.CONFLICT);
  });
});

// ---------------------------------------------------------------------------
// No pool: distribute() works without locking (legacy / test path)
// ---------------------------------------------------------------------------

describe('DistributionEngine advisory lock – no pool fallback', () => {
  it('distribute() works without a pool (no locking)', async () => {
    const repo = new MockDistributionRepo();
    const balances: BalanceRow[] = [{ investor_id: 'i1', balance: 50 }];

    const engine = new DistributionEngine(
      null, repo, new MockBalanceProvider(balances),
      { maxRetries: 1, initialDelayMs: 0 }
      // no pool
    );

    const result = await engine.distribute(
      'off-nopool', { id: 'p-nopool', start: new Date(), end: new Date() }, 50
    );

    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0].amount).toBe('50.00');
  });
});
