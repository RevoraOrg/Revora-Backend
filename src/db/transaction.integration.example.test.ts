/**
 * Regression coverage for the transaction-boundary integration examples
 * (`src/db/transaction.integration.example.ts`) — issue #1030.
 *
 * The examples document the canonical failure/rollback contract for services
 * built on `withTransaction`. The branches named in the issue —
 * "Offering not found" (x2) and "Offering is not active" — are pinned here, so a
 * change to the example, the transaction wrapper, or the error wrapping is
 * caught by CI. The neighbouring success paths and the empty-input boundary are
 * covered alongside.
 *
 * Evidence lines exercised:
 *   - `transaction.integration.example.ts:110` "Offering not found"
 *   - `transaction.integration.example.ts:114` "Offering is not active"
 *   - `transaction.integration.example.ts:215` "Offering not found"
 */
import { Pool } from 'pg';
import { TransactionError } from './transaction';
import {
  InvestmentService,
  BalanceSnapshotService,
  RevenueReconciliationService,
} from './transaction.integration.example';

type Row = Record<string, unknown>;

function result(rows: Row[] = []) {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

/**
 * Build a pool whose single client answers every query via `handle`.
 * `handle` receives the SQL string and returns the rows to resolve with.
 */
function makeTransactionalPool(handle: (sql: string, params?: unknown[]) => Row[]) {
  const client = {
    query: jest.fn((sql: string, params?: unknown[]) =>
      Promise.resolve(result(handle(sql, params))),
    ),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn(),
  };
  return { pool, client };
}

const asPool = (pool: unknown): Pool => pool as unknown as Pool;

/** Await a promise that must reject and return the thrown value. */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject but it resolved');
}

const sqls = (client: { query: jest.Mock }): string[] =>
  client.query.mock.calls.map((call) => String(call[0]));

describe('transaction.integration.example — failure branches (#1030)', () => {
  describe('BalanceSnapshotService.createSnapshotWithValidation', () => {
    const input = {
      offering_id: 'offering-abc',
      period_id: 'period-1',
      snapshots: [{ holder_address_or_id: 'holder-1', balance: '100.00' }],
    };

    it('aborts with the "Offering not found" branch and rolls back', async () => {
      const { pool, client } = makeTransactionalPool(() => []);

      await expect(
        new BalanceSnapshotService(asPool(pool)).createSnapshotWithValidation(input),
      ).rejects.toThrow(/Offering not found/);

      const statements = sqls(client);
      expect(statements).toContain('ROLLBACK');
      expect(statements).not.toContain('COMMIT');
      expect(
        statements.some((s) => /INSERT\s+INTO\s+token_balance_snapshots/i.test(s)),
      ).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('aborts with the "Offering is not active" branch and writes no snapshots', async () => {
      const { pool, client } = makeTransactionalPool((sql) =>
        /SELECT id, status FROM offerings/.test(sql)
          ? [{ id: 'offering-abc', status: 'paused' }]
          : [],
      );

      await expect(
        new BalanceSnapshotService(asPool(pool)).createSnapshotWithValidation(input),
      ).rejects.toThrow(/Offering is not active/);

      const statements = sqls(client);
      expect(statements).toContain('ROLLBACK');
      expect(
        statements.some((s) => /INSERT\s+INTO\s+token_balance_snapshots/i.test(s)),
      ).toBe(false);
    });

    it('wraps the domain failure in a TransactionError (observable contract)', async () => {
      const { pool } = makeTransactionalPool(() => []);

      const error = await captureError(
        new BalanceSnapshotService(asPool(pool)).createSnapshotWithValidation(input),
      );

      expect(error).toBeInstanceOf(TransactionError);
      expect((error as TransactionError).rollbackSucceeded).toBe(true);
      expect((error as TransactionError).message).toContain('Offering not found');
    });

    it('succeeds for an active offering and commits the batch + timestamp', async () => {
      const { pool, client } = makeTransactionalPool((sql) => {
        if (/SELECT id, status FROM offerings/.test(sql)) {
          return [{ id: 'offering-abc', status: 'active' }];
        }
        if (/INSERT INTO token_balance_snapshots/.test(sql)) {
          return [{ id: 'snap-1', balance: '100.00' }];
        }
        return [];
      });

      const created = await new BalanceSnapshotService(asPool(pool)).createSnapshotWithValidation(
        input,
      );

      expect(created).toHaveLength(1);
      const statements = sqls(client);
      expect(statements).toContain('COMMIT');
      expect(statements.some((s) => /UPDATE offerings SET last_snapshot_at/i.test(s))).toBe(true);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('treats an empty snapshot batch as a valid boundary (timestamp update only)', async () => {
      const { pool, client } = makeTransactionalPool((sql) =>
        /SELECT id, status FROM offerings/.test(sql)
          ? [{ id: 'offering-abc', status: 'active' }]
          : [],
      );

      const created = await new BalanceSnapshotService(
        asPool(pool),
      ).createSnapshotWithValidation({ ...input, snapshots: [] });

      expect(created).toEqual([]);
      const statements = sqls(client);
      expect(statements).toContain('COMMIT');
      expect(
        statements.some((s) => /INSERT\s+INTO\s+token_balance_snapshots/i.test(s)),
      ).toBe(false);
    });
  });

  describe('RevenueReconciliationService.reconcileAndDistribute', () => {
    const input = {
      offering_id: 'offering-abc',
      period_start: new Date('2026-01-01'),
      period_end: new Date('2026-02-01'),
    };

    it('aborts with the "Offering not found" branch and rolls back', async () => {
      const { pool, client } = makeTransactionalPool((sql) =>
        /SELECT \* FROM offerings/.test(sql) ? [] : [],
      );

      await expect(
        new RevenueReconciliationService(asPool(pool)).reconcileAndDistribute(input),
      ).rejects.toThrow(/Offering not found/);

      const statements = sqls(client);
      expect(statements).toContain('ROLLBACK');
      expect(statements).not.toContain('COMMIT');
    });

    it('creates a distribution when revenue exceeds what was distributed', async () => {
      const { pool, client } = makeTransactionalPool((sql) => {
        if (/SELECT \* FROM offerings/.test(sql)) return [{ id: 'offering-abc' }];
        if (/total_revenue/.test(sql)) return [{ total_revenue: '100' }];
        if (/total_distributed/.test(sql)) return [{ total_distributed: '40' }];
        if (/INSERT INTO distribution_runs/.test(sql)) return [{ id: 'dr-1' }];
        return [];
      });

      const out = await new RevenueReconciliationService(asPool(pool)).reconcileAndDistribute(
        input,
      );

      expect(out).toMatchObject({
        offering_id: 'offering-abc',
        undistributed: '60',
        distribution_created: true,
      });
      const statements = sqls(client);
      expect(statements).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ');
      expect(statements).toContain('COMMIT');
    });

    it.each([
      ['fully distributed', '100', '100'],
      ['over-distributed', '100', '150'],
    ])(
      'returns distribution_created=false when %s (boundary <= 0)',
      async (_label, revenue, distributed) => {
        const { pool, client } = makeTransactionalPool((sql) => {
          if (/SELECT \* FROM offerings/.test(sql)) return [{ id: 'offering-abc' }];
          if (/total_revenue/.test(sql)) return [{ total_revenue: revenue }];
          if (/total_distributed/.test(sql)) return [{ total_distributed: distributed }];
          return [];
        });

        const out = await new RevenueReconciliationService(
          asPool(pool),
        ).reconcileAndDistribute(input);

        expect(out).toMatchObject({ undistributed: '0', distribution_created: false });
        expect(
          sqls(client).some((s) => /INSERT INTO distribution_runs/i.test(s)),
        ).toBe(false);
      },
    );

    it('treats NULL aggregates as zero (no phantom distribution)', async () => {
      const { pool } = makeTransactionalPool((sql) => {
        if (/SELECT \* FROM offerings/.test(sql)) return [{ id: 'offering-abc' }];
        if (/total_revenue/.test(sql)) return [{ total_revenue: null }];
        if (/total_distributed/.test(sql)) return [{ total_distributed: null }];
        return [];
      });

      const out = await new RevenueReconciliationService(asPool(pool)).reconcileAndDistribute(
        input,
      );

      expect(out).toMatchObject({ undistributed: '0', distribution_created: false });
    });
  });

  describe('InvestmentService.createInvestment (example service)', () => {
    it('commits the investment and its audit log atomically', async () => {
      const { pool, client } = makeTransactionalPool((sql) => {
        if (/INSERT INTO investments/.test(sql)) return [{ id: 'inv-1' }];
        return [];
      });

      const out = await new InvestmentService(asPool(pool)).createInvestment({
        investor_id: 'investor-123',
        offering_id: 'offering-abc',
        amount: '5000.00',
        asset: 'USDC',
      });

      expect(out).toEqual({ id: 'inv-1' });
      const statements = sqls(client);
      expect(statements.some((s) => /INSERT INTO audit_logs/i.test(s))).toBe(true);
      expect(statements).toContain('COMMIT');
    });
  });
});
