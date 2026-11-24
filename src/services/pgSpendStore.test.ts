import type { Pool } from 'pg';
import { InMemorySpendStore } from './fxProviderBudgetRegistry';
import {
  createFxProviderSpendStore,
  PgSpendStore,
} from './pgSpendStore';

const TENANT = 'tenant-a';
const PROVIDER = 'provider-a';
const MONTH = '2026-11';

function makeStore() {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const db = { query } as unknown as Pick<Pool, 'query'>;
  return { store: new PgSpendStore(db), query };
}

describe('PgSpendStore', () => {
  it('uses one atomic upsert for concurrent-safe increments', async () => {
    const { store, query } = makeStore();
    await store.increment(TENANT, PROVIDER, MONTH, 0.125);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        'spend_usd = fx_provider_spend.spend_usd + EXCLUDED.spend_usd',
      ),
      [TENANT, PROVIDER, MONTH, 0.125],
    );
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid spend increments (%s)',
    async (amountUsd) => {
      const { store, query } = makeStore();
      await expect(
        store.increment(TENANT, PROVIDER, MONTH, amountUsd),
      ).rejects.toThrow(RangeError);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it('does not create a database record for a zero-cost call', async () => {
    const { store, query } = makeStore();
    await store.increment(TENANT, PROVIDER, MONTH, 0);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns zero for an unknown key and converts PostgreSQL numeric strings', async () => {
    const { store, query } = makeStore();
    expect(await store.get(TENANT, PROVIDER, MONTH)).toBe(0);

    query.mockResolvedValueOnce({ rows: [{ spend_usd: '12.34567890' }] });
    expect(await store.get(TENANT, PROVIDER, MONTH)).toBe(12.3456789);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining('WHERE tenant_id = $1 AND provider_id = $2 AND month_key = $3'),
      [TENANT, PROVIDER, MONTH],
    );
  });

  it('rejects invalid numeric values returned by PostgreSQL', async () => {
    const { store, query } = makeStore();
    query.mockResolvedValueOnce({ rows: [{ spend_usd: 'not-a-number' }] });
    await expect(store.get(TENANT, PROVIDER, MONTH)).rejects.toThrow(
      'invalid spend_usd',
    );
  });

  it('lists only the requested tenant and month using SpendRecord fields', async () => {
    const { store, query } = makeStore();
    query.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: TENANT,
          provider_id: PROVIDER,
          month_key: MONTH,
          spend_usd: '4.25',
        },
      ],
    });

    await expect(store.listByTenant(TENANT, MONTH)).resolves.toEqual([
      { tenantId: TENANT, providerId: PROVIDER, monthKey: MONTH, spendUsd: 4.25 },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE tenant_id = $1 AND month_key = $2'),
      [TENANT, MONTH],
    );
  });

  it('rejects invalid numeric values in tenant listings', async () => {
    const { store, query } = makeStore();
    query.mockResolvedValueOnce({
      rows: [
        {
          tenant_id: TENANT,
          provider_id: PROVIDER,
          month_key: MONTH,
          spend_usd: 'not-a-number',
        },
      ],
    });

    await expect(store.listByTenant(TENANT, MONTH)).rejects.toThrow(
      'invalid spend_usd',
    );
  });

  it('propagates database failures instead of returning a fabricated balance', async () => {
    const { store, query } = makeStore();
    query.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(store.get(TENANT, PROVIDER, MONTH)).rejects.toThrow(
      'database unavailable',
    );
  });

  it('selects the requested backend at startup', () => {
    const db = { query: jest.fn() } as unknown as Pick<Pool, 'query'>;
    expect(createFxProviderSpendStore('memory', db)).toBeInstanceOf(InMemorySpendStore);
    expect(createFxProviderSpendStore('postgres', db)).toBeInstanceOf(PgSpendStore);
  });
});
