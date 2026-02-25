import { Pool, QueryResult } from 'pg';

/**
 * Distribution Run entity
 */
export interface DistributionRun {
  id: string;
  offering_id: string;
  total_amount: string; // Decimal as string to preserve precision
  distribution_date: Date;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: Date;
  updated_at: Date;
}

/**
 * Payout entity
 */
export interface Payout {
  id: string;
  distribution_run_id: string;
  investor_id: string;
  amount: string; // Decimal as string to preserve precision
  status: 'pending' | 'processed' | 'failed';
  transaction_hash?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Distribution Run input for creation
 */
export interface CreateDistributionRunInput {
  offering_id: string;
  total_amount: string;
  distribution_date: Date;
  status?: 'pending' | 'processing' | 'completed' | 'failed';
}

/**
 * Payout input for creation
 */
export interface CreatePayoutInput {
  distribution_run_id: string;
  investor_id: string;
  amount: string;
  status?: 'pending' | 'processed' | 'failed';
  transaction_hash?: string;
}

/**
 * Distribution Repository
 * Handles database operations for distributions and payouts
 */
export class DistributionRepository {
  constructor(private db: Pool) {}

  /**
   * Create a new distribution run
   * @param input Distribution run data
   * @returns Created distribution run
   */
  async createDistributionRun(
    input: CreateDistributionRunInput
  ): Promise<DistributionRun> {
    const query = `
      INSERT INTO distribution_runs (
        offering_id,
        total_amount,
        distribution_date,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING *
    `;

    const status = input.status || 'pending';
    const values = [
      input.offering_id,
      input.total_amount,
      input.distribution_date,
      status,
    ];

    const result: QueryResult<DistributionRun> = await this.db.query(
      query,
      values
    );

    if (result.rows.length === 0) {
      throw new Error('Failed to create distribution run');
    }

    return this.mapDistributionRun(result.rows[0]);
  }

  /**
   * Create a new payout
   * @param input Payout data
   * @returns Created payout
   */
  async createPayout(input: CreatePayoutInput): Promise<Payout> {
    const query = `
      INSERT INTO payouts (
        distribution_run_id,
        investor_id,
        amount,
        status,
        transaction_hash,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING *
    `;

    const status = input.status || 'pending';
    const values = [
      input.distribution_run_id,
      input.investor_id,
      input.amount,
      status,
      input.transaction_hash || null,
    ];

    const result: QueryResult<Payout> = await this.db.query(query, values);

    if (result.rows.length === 0) {
      throw new Error('Failed to create payout');
    }

    return this.mapPayout(result.rows[0]);
  }

  /**
   * List distribution runs by offering
   * @param offeringId Offering ID
   * @returns Array of distribution runs
   */
  async listByOffering(offeringId: string): Promise<DistributionRun[]> {
    const query = `
      SELECT *
      FROM distribution_runs
      WHERE offering_id = $1
      ORDER BY distribution_date DESC, created_at DESC
    `;

    const result: QueryResult<DistributionRun> = await this.db.query(query, [
      offeringId,
    ]);

    return result.rows.map((row) => this.mapDistributionRun(row));
  }

  /**
   * List payouts by investor
   * @param investorId Investor ID
   * @returns Array of payouts
   */
  async listPayoutsByInvestor(investorId: string): Promise<Payout[]> {
    const query = `
      SELECT *
      FROM payouts
      WHERE investor_id = $1
      ORDER BY created_at DESC
    `;

    const result: QueryResult<Payout> = await this.db.query(query, [
      investorId,
    ]);

    return result.rows.map((row) => this.mapPayout(row));
  }

  /**
   * Get aggregate stats for an offering
   * @param offeringId Offering ID
   * @returns Aggregate statistics
   */
  async getAggregateStats(offeringId: string): Promise<{ totalDistributed: string; lastReportDate: Date | null }> {
    const query = `
      SELECT 
        COALESCE(SUM(total_amount), 0) as total_distributed,
        MAX(distribution_date) as last_report_date
      FROM distribution_runs
      WHERE offering_id = $1 AND status = 'completed'
    `;

    const result = await this.db.query(query, [offeringId]);
    const row = result.rows[0];

    return {
      totalDistributed: row.total_distributed.toString(),
      lastReportDate: row.last_report_date ? new Date(row.last_report_date) : null,
    };
  }

  /**
   * Map database row to DistributionRun entity
   */
  private mapDistributionRun(row: any): DistributionRun {
    return {
      id: row.id,
      offering_id: row.offering_id,
      total_amount: row.total_amount,
      distribution_date: row.distribution_date,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Map database row to Payout entity
   */
  private mapPayout(row: any): Payout {
    return {
      id: row.id,
      distribution_run_id: row.distribution_run_id,
      investor_id: row.investor_id,
      amount: row.amount,
      status: row.status,
      transaction_hash: row.transaction_hash || undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
