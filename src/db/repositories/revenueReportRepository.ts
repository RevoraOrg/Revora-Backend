import { Pool, QueryResult } from 'pg';

export interface RevenueReport {
    id: string;
    offering_id: string;
    issuer_id: string;
    amount: string;
    period_start: Date;
    period_end: Date;
    created_at: Date;
    updated_at: Date;
}

export interface CreateRevenueReportInput {
    offering_id: string;
    issuer_id: string;
    amount: string;
    period_start: Date;
    period_end: Date;
}

export class RevenueReportRepository {
    constructor(private db: Pool) { }

    async create(input: CreateRevenueReportInput): Promise<RevenueReport> {
        const query = `
      INSERT INTO revenue_reports (
        offering_id,
        issuer_id,
        amount,
        period_start,
        period_end,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING *
    `;

        const values = [
            input.offering_id,
            input.issuer_id,
            input.amount,
            input.period_start,
            input.period_end,
        ];

        const result: QueryResult<RevenueReport> = await this.db.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('Failed to create revenue report');
        }

        return result.rows[0];
    }

    async findByOfferingAndPeriod(
        offeringId: string,
        periodStart: Date,
        periodEnd: Date
    ): Promise<RevenueReport | null> {
        const query = `
      SELECT * FROM revenue_reports 
      WHERE offering_id = $1 
      AND period_start = $2 
      AND period_end = $3
    `;
        const result: QueryResult<RevenueReport> = await this.db.query(query, [
            offeringId,
            periodStart,
            periodEnd,
        ]);

        if (result.rows.length === 0) {
            return null;
        }

        return result.rows[0];
    }
}
