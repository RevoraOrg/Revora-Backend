/**
 * Unit tests for PgLedgerEntryRepository (pool-mocked, no DB).
 *
 * These complement the integration suite in src/routes/ledgerExport.test.ts,
 * which is skipped unless INTEGRATION_DB_URL is set. Here the pg Pool is faked
 * so the SQL parameters and row mapping are exercised in CI.
 *
 * The repository issues two queries per call:
 *   [0] COUNT(*) for the gl_account          → params [glAccount]
 *   [1] page SELECT ... LIMIT (limit + 1)    → params [glAccount, limit + 1]
 *                                              or [glAccount, afterId, limit + 1]
 */
import { Pool } from 'pg';
import { PgLedgerEntryRepository } from './ledgerEntryRepository';
import { LedgerEntry } from '../../services/ledgerExportService';

function makeRow(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: '1',
    gl_account: '1050-Custody',
    entry_date: '2026-07-01',
    description: 'Client deposit',
    debit_amount: '1000.00',
    credit_amount: '0.00',
    currency: 'USD',
    recorded_at: '2026-07-01T10:00:00Z',
    entry_type: 'deposit',
    ...overrides,
  };
}

/**
 * Build a fake Pool whose count query returns `total` and whose data query
 * returns `rows`, in call order.
 */
function makePool(total: number, rows: Record<string, unknown>[]): { pool: Pool; query: jest.Mock } {
  const query = jest.fn()
    .mockResolvedValueOnce({ rows: [{ total }] })
    .mockResolvedValueOnce({ rows });
  return { pool: { query } as unknown as Pool, query };
}

describe('PgLedgerEntryRepository', () => {
  it('counts by gl_account and returns mapped entries with total', async () => {
    const { pool, query } = makePool(4, [makeRow()]);
    const repo = new PgLedgerEntryRepository(pool);

    const result = await repo.findByGlAccount('1050-Custody', 10);

    // Count query is parameterised by the gl account only.
    expect(query.mock.calls[0][1]).toEqual(['1050-Custody']);
    expect(query.mock.calls[0][0]).toContain('COUNT(*)');
    expect(result.total).toBe(4);
    expect(result.entries).toEqual([makeRow()]);
    expect(result.hasMore).toBe(false);
  });

  it('requests limit + 1 rows so hasMore can be detected', async () => {
    const { pool, query } = makePool(50, [makeRow()]);
    const repo = new PgLedgerEntryRepository(pool);

    await repo.findByGlAccount('1050-Custody', 10);

    // Data query params are [glAccount, fetchLimit] where fetchLimit = limit + 1.
    expect(query.mock.calls[1][1]).toEqual(['1050-Custody', 11]);
  });

  it('includes afterId in the data query parameters when provided', async () => {
    const { pool, query } = makePool(50, [makeRow({ id: '20' })]);
    const repo = new PgLedgerEntryRepository(pool);

    await repo.findByGlAccount('1050-Custody', 10, '15');

    const [sql, params] = query.mock.calls[1];
    expect(params).toEqual(['1050-Custody', '15', 11]);
    expect(sql).toContain('id > $2');
  });

  it('omits the afterId predicate from the data query when not provided', async () => {
    const { pool, query } = makePool(50, [makeRow()]);
    const repo = new PgLedgerEntryRepository(pool);

    await repo.findByGlAccount('1050-Custody', 10);

    const [sql, params] = query.mock.calls[1];
    expect(params).toEqual(['1050-Custody', 11]);
    expect(sql).not.toContain('id > $2');
  });

  it('sets hasMore true and truncates to limit when limit + 1 rows are returned', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => makeRow({ id: String(i + 1) }));
    const { pool } = makePool(50, rows);
    const repo = new PgLedgerEntryRepository(pool);

    const result = await repo.findByGlAccount('1050-Custody', 5);

    expect(result.entries).toHaveLength(5);
    expect(result.entries.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(result.hasMore).toBe(true);
  });

  it('sets hasMore false when exactly limit rows are returned', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow({ id: String(i + 1) }));
    const { pool } = makePool(50, rows);
    const repo = new PgLedgerEntryRepository(pool);

    const result = await repo.findByGlAccount('1050-Custody', 5);

    expect(result.entries).toHaveLength(5);
    expect(result.hasMore).toBe(false);
  });

  it('returns empty entries, zero total and hasMore false for an account with no rows', async () => {
    const { pool } = makePool(0, []);
    const repo = new PgLedgerEntryRepository(pool);

    const result = await repo.findByGlAccount('9999-Nonexistent', 10);

    expect(result.entries).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it('defaults total to 0 when the count query returns no rows', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const repo = new PgLedgerEntryRepository({ query } as unknown as Pool);

    const result = await repo.findByGlAccount('1050-Custody', 10);

    expect(result.total).toBe(0);
  });

  it('projects only the known columns from each row', async () => {
    const row = { ...makeRow(), unexpected_column: 'should be dropped' };
    const { pool } = makePool(1, [row]);
    const repo = new PgLedgerEntryRepository(pool);

    const result = await repo.findByGlAccount('1050-Custody', 10);

    expect(result.entries).toEqual([makeRow()]);
    expect(Object.keys(result.entries[0]).sort()).toEqual(
      [
        'credit_amount',
        'currency',
        'debit_amount',
        'description',
        'entry_date',
        'entry_type',
        'gl_account',
        'id',
        'recorded_at',
      ].sort(),
    );
  });
});
