import { Pool, QueryResult } from 'pg';
import { LedgerEntry, LedgerExportRepository } from '../../services/ledgerExportService';

export class PgLedgerEntryRepository implements LedgerExportRepository {
  constructor(private db: Pool) {}

  async findByGlAccount(
    glAccount: string,
    limit: number,
    afterId?: string,
  ): Promise<{ entries: LedgerEntry[]; total: number; hasMore: boolean }> {
    const countQuery = `
      SELECT COUNT(*)::int AS total
      FROM ledger_entries
      WHERE gl_account = $1
    `;
    const countResult: QueryResult<{ total: number }> = await this.db.query(countQuery, [glAccount]);
    const total = countResult.rows[0]?.total ?? 0;

    const fetchLimit = limit + 1;
    let dataQuery: string;
    let params: unknown[];
    if (afterId) {
      dataQuery = `
        SELECT id, gl_account, entry_date, description,
               debit_amount, credit_amount, currency,
               recorded_at, entry_type
        FROM ledger_entries
        WHERE gl_account = $1 AND id > $2
        ORDER BY id ASC
        LIMIT $3
      `;
      params = [glAccount, afterId, fetchLimit];
    } else {
      dataQuery = `
        SELECT id, gl_account, entry_date, description,
               debit_amount, credit_amount, currency,
               recorded_at, entry_type
        FROM ledger_entries
        WHERE gl_account = $1
        ORDER BY id ASC
        LIMIT $2
      `;
      params = [glAccount, fetchLimit];
    }

    const dataResult: QueryResult<LedgerEntry> = await this.db.query(dataQuery, params);
    const rows = dataResult.rows.map((row) => ({
      id: row.id,
      gl_account: row.gl_account,
      entry_date: row.entry_date,
      description: row.description,
      debit_amount: row.debit_amount,
      credit_amount: row.credit_amount,
      currency: row.currency,
      recorded_at: row.recorded_at,
      entry_type: row.entry_type,
    }));

    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;
    return { entries, total, hasMore };
  }
}
