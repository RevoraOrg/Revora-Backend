/**
 * RevenueReportRepository — persistence for revenue_reports.
 *
 * @see ../../docs/architecture/distribution-reconciliation.md
 *      Architecture map (see §5 — Database tables and ownership).
 * @see ../docs/revenue-report-ingestion-validation.md
 * @see ../docs/revenue-route-schema-validation.md
 */
import { Pool, QueryResult } from 'pg';

export type DistributionStatus = 'in_progress' | 'completed' | 'failed';

export interface RevenueReport {
  id: string;
  offering_id: string;
  period_id?: string;
  total_revenue?: string;
  issuer_id?: string;
  amount?: string;
  period_start?: Date;
  period_end?: Date;
  distribution_status?: DistributionStatus | null;
  distribution_status_updated_at?: Date | null;
  reported_by: string;
  created_at: Date;
  updated_at: Date;
  [key: string]: unknown;
}

export interface CreateRevenueReportInput {
  offering_id: string;
  period_id?: string;
  total_revenue?: string;
  issuer_id?: string;
  amount?: string;
  period_start?: Date;
  period_end?: Date;
  reported_by: string;
  [key: string]: string | number | boolean | Date | null | undefined;
}

type RevenueReportRow = Record<string, unknown>;

/**
 * Revenue Report Repository
 * Handles database operations for revenue reports.
 */
export class RevenueReportRepository {
  constructor(private db: Pool) {}

  /**
   * Create a new revenue report.
   */
  async create(input: CreateRevenueReportInput): Promise<RevenueReport> {
    const entries = Object.entries(input).filter(([, value]) => value !== undefined);

    if (entries.length === 0) {
      throw new Error('Failed to create revenue report');
    }

    const columns = entries.map(([column]) => column);
    const values = entries.map(([, value]) => value);
    const placeholders = columns.map((_, index) => `$${index + 1}`);

    const query = `
      INSERT INTO revenue_reports (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `;

    const result: QueryResult<RevenueReportRow> = await this.db.query(query, values);

    if (result.rows.length === 0) {
      throw new Error('Failed to create revenue report');
    }

    return this.mapRevenueReport(result.rows[0]);
  }

  /**
   * Get a revenue report by offering and period id.
   */
  async getByOfferingAndPeriod(
    offeringId: string,
    periodId: string
  ): Promise<RevenueReport | null> {
    const query = `
      SELECT *
      FROM revenue_reports
      WHERE offering_id = $1
        AND period_id = $2
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const result: QueryResult<RevenueReportRow> = await this.db.query(query, [
      offeringId,
      periodId,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRevenueReport(result.rows[0]);
  }

  /**
   * Get a revenue report by offering and date period.
   */
  async findByOfferingAndPeriod(
    offeringId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<RevenueReport | null> {
    const query = `
      SELECT *
      FROM revenue_reports
      WHERE offering_id = $1
        AND period_start = $2
        AND period_end = $3
      LIMIT 1
    `;

    const result: QueryResult<RevenueReportRow> = await this.db.query(query, [
      offeringId,
      periodStart,
      periodEnd,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRevenueReport(result.rows[0]);
  }

  /**
   * Find any existing report that overlaps with the given period for an offering.
   * This ensures no two reports cover the same time window.
   */
  async findOverlappingReport(
    offeringId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<RevenueReport | null> {
    const query = `
      SELECT *
      FROM revenue_reports
      WHERE offering_id = $1
        AND (
          (period_start < $3 AND period_end > $2)
        )
      LIMIT 1
    `;

    const result: QueryResult<RevenueReportRow> = await this.db.query(query, [
      offeringId,
      periodStart,
      periodEnd,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRevenueReport(result.rows[0]);
  }

  /**
   * List all revenue reports for an offering.
   */
  async listByOffering(offeringId: string): Promise<RevenueReport[]> {
    const query = `
      SELECT *
      FROM revenue_reports
      WHERE offering_id = $1
      ORDER BY created_at DESC
    `;

    const result: QueryResult<RevenueReportRow> = await this.db.query(query, [offeringId]);

    return result.rows.map((row) => this.mapRevenueReport(row));
  }

  /**
   * Find approved revenue reports that have not been successfully distributed yet.
   */
  async findApprovedWithoutDistribution(): Promise<RevenueReport[]> {
    const query = `
      SELECT r.*
      FROM revenue_reports r
      LEFT JOIN distributions d ON d.period_id = r.id
      WHERE r.status = 'approved'
        AND (d.id IS NULL OR d.status != 'completed')
        AND (
          r.distribution_status IS NULL
          OR r.distribution_status = 'failed'
          OR (
            r.distribution_status = 'in_progress'
            AND r.distribution_status_updated_at < NOW() - INTERVAL '15 minutes'
          )
        )
      ORDER BY r.created_at ASC
    `;

    const result: QueryResult<RevenueReportRow> = await this.db.query(query);

    return result.rows.map((row) => this.mapRevenueReport(row));
  }

  async claimApprovedReportForDistribution(reportId: string): Promise<RevenueReport | null> {
    const query = `
      UPDATE revenue_reports
      SET distribution_status = 'in_progress',
          distribution_status_updated_at = NOW()
      WHERE id = $1
        AND status = 'approved'
        AND (
          distribution_status IS NULL
          OR distribution_status = 'failed'
          OR (
            distribution_status = 'in_progress'
            AND distribution_status_updated_at < NOW() - INTERVAL '15 minutes'
          )
        )
      RETURNING *
    `;

    const result: QueryResult<RevenueReportRow> = await this.db.query(query, [reportId]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRevenueReport(result.rows[0]);
  }

  async markReportDistributionCompleted(reportId: string): Promise<void> {
    const query = `
      UPDATE revenue_reports
      SET distribution_status = 'completed',
          distribution_status_updated_at = NOW()
      WHERE id = $1
      RETURNING id
    `;

    const result: QueryResult<RevenueReportRow> = await this.db.query(query, [reportId]);

    if (result.rows.length === 0) {
      throw new Error(`Failed to mark revenue report ${reportId} as completed`);
    }
  }

  async markReportDistributionFailed(reportId: string): Promise<void> {
    const query = `
      UPDATE revenue_reports
      SET distribution_status = 'failed',
          distribution_status_updated_at = NOW()
      WHERE id = $1
      RETURNING id
    `;

    const result: QueryResult<RevenueReportRow> = await this.db.query(query, [reportId]);

    if (result.rows.length === 0) {
      throw new Error(`Failed to mark revenue report ${reportId} as failed`);
    }
  }

  private mapRevenueReport(row: RevenueReportRow): RevenueReport {
    return {
      ...(row as RevenueReport),
      id: String(row.id),
      offering_id: String(row.offering_id),
      period_id:
        row.period_id !== undefined && row.period_id !== null
          ? String(row.period_id)
          : undefined,
      total_revenue:
        row.total_revenue !== undefined && row.total_revenue !== null
          ? String(row.total_revenue)
          : undefined,
      issuer_id:
        row.issuer_id !== undefined && row.issuer_id !== null
          ? String(row.issuer_id)
          : undefined,
      amount: row.amount !== undefined && row.amount !== null ? String(row.amount) : undefined,
      reported_by: String(row.reported_by),
      period_start: (row.period_start as Date | undefined) ?? undefined,
      period_end: (row.period_end as Date | undefined) ?? undefined,
      created_at: row.created_at as Date,
      updated_at: row.updated_at as Date,
    };
  }
}
