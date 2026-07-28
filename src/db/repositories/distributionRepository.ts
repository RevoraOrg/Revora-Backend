import { Pool, PoolClient, QueryResult } from 'pg';

/**
 * Type representing any queryable database object (Pool or PoolClient)
 * Both have the same query interface for transactional support
 */
type Queryable = Pool | PoolClient;

/**
 * Distribution entity (matches 'distributions' table)
 */
export interface DistributionRun {
  id: string;
  offering_id: string;
  period_id: string; // From migration
  total_amount: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  run_at: Date; // From migration (replaces distribution_date)
  tx_batch_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Payout entity (matches 'distribution_payouts' table)
 */
export interface Payout {
  id: string;
  distribution_id: string; // From migration (replaces distribution_run_id)
  investor_id: string;
  amount: string;
  status: 'pending' | 'processed' | 'failed';
  tx_hash?: string | null; // From migration (replaces transaction_hash)
  created_at: Date;
  updated_at: Date;
}

/**
 * Distribution input for creation
 */
export interface CreateDistributionRunInput {
  offering_id: string;
  period_id: string;
  total_amount: string;
  run_at?: Date;
  status?: 'pending' | 'processing' | 'completed' | 'failed';
}

/**
 * Payout input for creation
 */
export interface CreatePayoutInput {
  distribution_id: string;
  investor_id: string;
  amount: string;
  status?: 'pending' | 'processed' | 'failed';
  tx_hash?: string | null;
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
   * @param client Optional transaction client; if provided, query is executed within that transaction
   * @returns Created distribution run
   */
  async createDistributionRun(
    input: CreateDistributionRunInput,
    client?: Queryable
  ): Promise<DistributionRun> {
    const query = `
      INSERT INTO distributions (
        offering_id,
        period_id,
        total_amount,
        run_at,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING *
    `;

    const status = input.status || 'pending';
    const runAt = input.run_at || new Date();
    const values = [
      input.offering_id,
      input.period_id,
      input.total_amount,
      runAt,
      status,
    ];

    const queryable = client || this.db;
    const result: QueryResult<DistributionRun> = await queryable.query(
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
   * @param client Optional transaction client; if provided, query is executed within that transaction
   * @returns Created payout
   */
  async createPayout(input: CreatePayoutInput, client?: Queryable): Promise<Payout> {
    const query = `
      INSERT INTO distribution_payouts (
        distribution_id,
        investor_id,
        amount,
        status,
        tx_hash,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING *
    `;

    const status = input.status || 'pending';
    const values = [
      input.distribution_id,
      input.investor_id,
      input.amount,
      status,
      input.tx_hash || null,
    ];

    const queryable = client || this.db;
    const result: QueryResult<Payout> = await queryable.query(query, values);

    if (result.rows.length === 0) {
      throw new Error('Failed to create payout');
    }

    return this.mapPayout(result.rows[0]);
  }

  /**
   * Find a distribution run by unique parameters for idempotency
   */
  async findRunByParams(
    offeringId: string,
    periodId: string,
    totalAmount: string
  ): Promise<DistributionRun | null> {
    const query = `
      SELECT *
      FROM distributions
      WHERE offering_id = $1 AND period_id = $2 AND total_amount = $3
      LIMIT 1
    `;

    const result: QueryResult<DistributionRun> = await this.db.query(query, [
      offeringId,
      periodId,
      totalAmount,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapDistributionRun(result.rows[0]);
  }

  /**
   * Get all payouts for a specific distribution run
   */
  async getPayoutsForRun(distributionId: string): Promise<Payout[]> {
    const query = `
      SELECT *
      FROM distribution_payouts
      WHERE distribution_id = $1
    `;

    const result: QueryResult<Payout> = await this.db.query(query, [
      distributionId,
    ]);

    return result.rows.map((row) => this.mapPayout(row));
  }

  /**
   * Update distribution run status
   * @param id Run ID
   * @param status New status
   * @param client Optional transaction client; if provided, query is executed within that transaction
   */
  async updateRunStatus(
    id: string,
    status: 'pending' | 'processing' | 'completed' | 'failed',
    client?: Queryable
  ): Promise<void> {
    const query = `
      UPDATE distributions
      SET status = $1, updated_at = NOW()
      WHERE id = $2
    `;

    const queryable = client || this.db;
    await queryable.query(query, [status, id]);
  }

  /**
   * List distribution runs by offering
   * @param offeringId Offering ID
   * @returns Array of distribution runs
   */
  async listByOffering(offeringId: string): Promise<DistributionRun[]> {
    const query = `
      SELECT *
      FROM distributions
      WHERE offering_id = $1
      ORDER BY run_at DESC, created_at DESC
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
      FROM distribution_payouts
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
        MAX(run_at) as last_report_date
      FROM distributions
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
      period_id: row.period_id,
      total_amount: row.total_amount,
      run_at: row.run_at,
      status: row.status,
      tx_batch_id: row.tx_batch_id,
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
      distribution_id: row.distribution_id,
      investor_id: row.investor_id,
      amount: row.amount,
      status: row.status,
      tx_hash: row.tx_hash || undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
