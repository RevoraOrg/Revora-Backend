import type { Pool } from 'pg';
import { InMemorySpendStore } from './fxProviderBudgetRegistry';
import type {
  MonthKey,
  SpendRecord,
  SpendStore,
} from './fxProviderBudgetRegistry';

/**
 * PostgreSQL-backed spend storage for shared, durable monthly provider budgets.
 *
 * @remarks
 * `increment` is a single atomic upsert. Tenant identifiers must be
 * authenticated by the caller; this store does not provide authorization.
 */
export class PgSpendStore implements SpendStore {
  constructor(private readonly db: Pick<Pool, 'query'>) {}

  async increment(
    tenantId: string,
    providerId: string,
    monthKey: MonthKey,
    amountUsd: number,
  ): Promise<void> {
    if (!Number.isFinite(amountUsd) || amountUsd < 0) {
      throw new RangeError(
        `spend increment must be a non-negative finite number (got ${amountUsd})`,
      );
    }
    if (amountUsd === 0) return;

    await this.db.query(
      `INSERT INTO fx_provider_spend (tenant_id, provider_id, month_key, spend_usd)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, provider_id, month_key)
       DO UPDATE SET
         spend_usd = fx_provider_spend.spend_usd + EXCLUDED.spend_usd,
         updated_at = NOW()`,
      [tenantId, providerId, monthKey, amountUsd],
    );
  }

  async get(
    tenantId: string,
    providerId: string,
    monthKey: MonthKey,
  ): Promise<number> {
    const result = await this.db.query<{ spend_usd: string | number }>(
      `SELECT spend_usd
       FROM fx_provider_spend
       WHERE tenant_id = $1 AND provider_id = $2 AND month_key = $3`,
      [tenantId, providerId, monthKey],
    );
    const spendUsd = result.rows[0]?.spend_usd;
    if (spendUsd === undefined) return 0;

    const parsed = Number(spendUsd);
    if (!Number.isFinite(parsed)) {
      throw new Error('fx_provider_spend returned an invalid spend_usd value');
    }
    return parsed;
  }

  async listByTenant(
    tenantId: string,
    monthKey: MonthKey,
  ): Promise<SpendRecord[]> {
    const result = await this.db.query<{
      tenant_id: string;
      provider_id: string;
      month_key: string;
      spend_usd: string | number;
    }>(
      `SELECT tenant_id, provider_id, month_key, spend_usd
       FROM fx_provider_spend
       WHERE tenant_id = $1 AND month_key = $2
       ORDER BY provider_id`,
      [tenantId, monthKey],
    );

    return result.rows.map((row) => {
      const spendUsd = Number(row.spend_usd);
      if (!Number.isFinite(spendUsd)) {
        throw new Error('fx_provider_spend returned an invalid spend_usd value');
      }
      return {
        tenantId: row.tenant_id,
        providerId: row.provider_id,
        monthKey: row.month_key,
        spendUsd,
      };
    });
  }
}

export type FxProviderSpendStoreType = 'memory' | 'postgres';

/** Select the spend backend at application startup using validated config. */
export function createFxProviderSpendStore(
  type: FxProviderSpendStoreType,
  db: Pick<Pool, 'query'>,
): SpendStore {
  return type === 'postgres' ? new PgSpendStore(db) : new InMemorySpendStore();
}
