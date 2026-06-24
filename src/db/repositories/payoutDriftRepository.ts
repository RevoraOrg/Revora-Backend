import { Pool, QueryResult } from 'pg';

export interface PayoutDriftReport {
  id: string;
  run_at: Date;
  completed_at: Date | null;
  offering_id: string;
  total_payouts: number;
  verified_count: number;
  missing_count: number;
  underfunded_count: number;
  overfunded_count: number;
  duplicate_tx_count: number;
  total_drift_amount: string;
  oldest_drift_age_hours: number;
  details: DriftDetail[];
  status: 'completed' | 'error';
  error_message: string | null;
  created_at: Date;
}

export interface DriftDetail {
  payout_id: string;
  investor_id: string;
  amount: string;
  tx_hash: string | null;
  drift_type: 'missing' | 'underfunded' | 'overfunded' | 'duplicate_tx';
  expected_amount: string;
  actual_amount: string;
  discrepancy: string;
}

export interface CreateDriftReportInput {
  offering_id: string;
  total_payouts: number;
  verified_count: number;
  missing_count: number;
  underfunded_count: number;
  overfunded_count: number;
  duplicate_tx_count: number;
  total_drift_amount: string;
  oldest_drift_age_hours: number;
  details: DriftDetail[];
  status?: 'completed' | 'error';
  error_message?: string | null;
}

export interface DriftSummary {
  total_missing: number;
  total_underfunded: number;
  total_overfunded: number;
  total_duplicate_tx: number;
  total_drift_amount: string;
  oldest_drift_hours: number;
}

export interface PayoutForVerification {
  id: string;
  distribution_id: string;
  investor_id: string;
  amount: string;
  status: string;
  tx_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PayoutDriftRepository {
  constructor(private db: Pool) {}

  async saveReport(input: CreateDriftReportInput): Promise<PayoutDriftReport> {
    const query = `
      INSERT INTO payout_drift_reports (
        offering_id,
        total_payouts,
        verified_count,
        missing_count,
        underfunded_count,
        overfunded_count,
        duplicate_tx_count,
        total_drift_amount,
        oldest_drift_age_hours,
        details,
        status,
        error_message,
        completed_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, NOW())
      RETURNING *
    `;

    const result: QueryResult = await this.db.query(query, [
      input.offering_id,
      input.total_payouts,
      input.verified_count,
      input.missing_count,
      input.underfunded_count,
      input.overfunded_count,
      input.duplicate_tx_count,
      input.total_drift_amount,
      input.oldest_drift_age_hours,
      JSON.stringify(input.details),
      input.status ?? 'completed',
      input.error_message ?? null,
    ]);

    return this.mapReport(result.rows[0]);
  }

  async getLatestReport(offeringId: string): Promise<PayoutDriftReport | null> {
    const query = `
      SELECT *
      FROM payout_drift_reports
      WHERE offering_id = $1
      ORDER BY run_at DESC
      LIMIT 1
    `;

    const result: QueryResult = await this.db.query(query, [offeringId]);
    if (result.rows.length === 0) return null;
    return this.mapReport(result.rows[0]);
  }

  async getReportsSince(hoursAgo: number): Promise<PayoutDriftReport[]> {
    const query = `
      SELECT *
      FROM payout_drift_reports
      WHERE run_at >= NOW() - INTERVAL '1 hour' * $1
      ORDER BY run_at DESC
    `;

    const result: QueryResult = await this.db.query(query, [hoursAgo]);
    return result.rows.map((r) => this.mapReport(r));
  }

  async getProcessedPayoutsWithoutTxHash(): Promise<PayoutForVerification[]> {
    const query = `
      SELECT dp.*
      FROM distribution_payouts dp
      WHERE dp.status = 'processed'
        AND dp.tx_hash IS NULL
      ORDER BY dp.created_at DESC
    `;

    const result: QueryResult = await this.db.query(query);
    return result.rows.map(this.mapPayout);
  }

  async getPayoutsWithDuplicateTxHashes(): Promise<Array<{ tx_hash: string; count: number; payouts: PayoutForVerification[] }>> {
    const query = `
      SELECT tx_hash, COUNT(*) as cnt
      FROM distribution_payouts
      WHERE tx_hash IS NOT NULL AND status = 'processed'
      GROUP BY tx_hash
      HAVING COUNT(*) > 1
    `;

    const dupes = await this.db.query(query);
    const result: Array<{ tx_hash: string; count: number; payouts: PayoutForVerification[] }> = [];

    for (const row of dupes.rows) {
      const payoutQuery = `
        SELECT *
        FROM distribution_payouts
        WHERE tx_hash = $1 AND status = 'processed'
        ORDER BY created_at ASC
      `;
      const payouts = await this.db.query(payoutQuery, [row.tx_hash]);
      result.push({
        tx_hash: row.tx_hash,
        count: parseInt(row.cnt, 10),
        payouts: payouts.rows.map(this.mapPayout),
      });
    }

    return result;
  }

  async getPayoutsForVerification(): Promise<PayoutForVerification[]> {
    const query = `
      SELECT dp.*
      FROM distribution_payouts dp
      WHERE dp.status = 'processed'
        AND dp.tx_hash IS NOT NULL
      ORDER BY dp.created_at DESC
    `;

    const result: QueryResult = await this.db.query(query);
    return result.rows.map(this.mapPayout);
  }

  async getAggregatedDriftSummary(): Promise<DriftSummary> {
    const missing = await this.db.query(`
      SELECT COUNT(*) as cnt FROM distribution_payouts
      WHERE status = 'processed' AND tx_hash IS NULL
    `);

    const dupes = await this.db.query(`
      SELECT COUNT(*) as cnt FROM (
        SELECT tx_hash FROM distribution_payouts
        WHERE tx_hash IS NOT NULL AND status = 'processed'
        GROUP BY tx_hash HAVING COUNT(*) > 1
      ) dup
    `);

    const oldestMissing = await this.db.query(`
      SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 3600 as oldest_hours
      FROM distribution_payouts
      WHERE status = 'processed' AND tx_hash IS NULL
    `);

    return {
      total_missing: parseInt(missing.rows[0].cnt, 10),
      total_underfunded: 0,
      total_overfunded: 0,
      total_duplicate_tx: parseInt(dupes.rows[0].cnt, 10),
      total_drift_amount: '0',
      oldest_drift_hours: oldestMissing.rows[0].oldest_hours
        ? parseFloat(oldestMissing.rows[0].oldest_hours)
        : 0,
    };
  }

  async getPayoutsByOffering(): Promise<Array<{ offering_id: string; payouts: PayoutForVerification[] }>> {
    const query = `
      SELECT dp.*, d.offering_id
      FROM distribution_payouts dp
      JOIN distributions d ON d.id = dp.distribution_id
      WHERE dp.status = 'processed'
      ORDER BY d.offering_id, dp.created_at DESC
    `;

    const result: QueryResult = await this.db.query(query);
    const grouped: Record<string, PayoutForVerification[]> = {};

    for (const row of result.rows) {
      const oid = row.offering_id;
      if (!grouped[oid]) grouped[oid] = [];
      grouped[oid].push(this.mapPayout(row));
    }

    return Object.entries(grouped).map(([offering_id, payouts]) => ({
      offering_id,
      payouts,
    }));
  }

  private mapReport(row: any): PayoutDriftReport {
    return {
      id: row.id,
      run_at: row.run_at,
      completed_at: row.completed_at,
      offering_id: row.offering_id,
      total_payouts: row.total_payouts,
      verified_count: row.verified_count,
      missing_count: row.missing_count,
      underfunded_count: row.underfunded_count,
      overfunded_count: row.overfunded_count,
      duplicate_tx_count: row.duplicate_tx_count,
      total_drift_amount: row.total_drift_amount,
      oldest_drift_age_hours: parseFloat(row.oldest_drift_age_hours) || 0,
      details: typeof row.details === 'string' ? JSON.parse(row.details) : (row.details ?? []),
      status: row.status,
      error_message: row.error_message,
      created_at: row.created_at,
    };
  }

  private mapPayout(row: any): PayoutForVerification {
    return {
      id: row.id,
      distribution_id: row.distribution_id,
      investor_id: row.investor_id,
      amount: row.amount,
      status: row.status,
      tx_hash: row.tx_hash || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
