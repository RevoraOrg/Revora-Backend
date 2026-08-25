import { Pool, QueryResult } from 'pg';
import { InvestmentVelocityRecord, VelocityRepository } from './types';

/** PostgreSQL persistence for AML sliding-window velocity aggregates. */
export class PgVelocityRepository implements VelocityRepository {
  constructor(private readonly db: Pool) {}

  async upsert(
    record: Omit<InvestmentVelocityRecord, 'id' | 'created_at' | 'updated_at'>,
  ): Promise<InvestmentVelocityRecord> {
    const result: QueryResult = await this.db.query(
      `
        INSERT INTO aml_investment_velocity (
          investor_id, window_start, window_end, window_minutes, tx_count,
          total_amount, investment_ids, amount_exceeded, count_exceeded,
          threshold_amount, threshold_count, rule_id, rule_version
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb)
        ON CONFLICT (investor_id, window_start, window_end, rule_id)
        DO UPDATE SET
          window_minutes = EXCLUDED.window_minutes,
          tx_count = EXCLUDED.tx_count,
          total_amount = EXCLUDED.total_amount,
          investment_ids = EXCLUDED.investment_ids,
          amount_exceeded = EXCLUDED.amount_exceeded,
          count_exceeded = EXCLUDED.count_exceeded,
          threshold_amount = EXCLUDED.threshold_amount,
          threshold_count = EXCLUDED.threshold_count,
          rule_version = EXCLUDED.rule_version
        RETURNING *
      `,
      [
        record.investor_id,
        record.window_start,
        record.window_end,
        record.window_minutes,
        record.tx_count,
        record.total_amount,
        JSON.stringify(record.investment_ids),
        record.amount_exceeded,
        record.count_exceeded,
        record.threshold_amount,
        record.threshold_count,
        record.rule_id,
        JSON.stringify(record.rule_version),
      ],
    );

    return this.mapRecord(result.rows[0]);
  }

  async findByInvestor(investorId: string, from: Date, to: Date): Promise<InvestmentVelocityRecord[]> {
    const result: QueryResult = await this.db.query(
      `
        SELECT *
        FROM aml_investment_velocity
        WHERE investor_id = $1 AND window_end >= $2 AND window_end <= $3
        ORDER BY window_end DESC
      `,
      [investorId, from, to],
    );

    return result.rows.map((row) => this.mapRecord(row));
  }

  private mapRecord(row: any): InvestmentVelocityRecord {
    return {
      ...row,
      window_start: new Date(row.window_start),
      window_end: new Date(row.window_end),
      total_amount: Number(row.total_amount),
      investment_ids: Array.isArray(row.investment_ids) ? row.investment_ids : JSON.parse(row.investment_ids),
      rule_version: typeof row.rule_version === 'string' ? JSON.parse(row.rule_version) : row.rule_version,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}