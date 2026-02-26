import { Pool, QueryResult } from 'pg';

/**
 * Investment entity
 */
export interface Investment {
  id: string;
  investor_id: string;
  offering_id: string;
  amount: string; // Numeric as string to preserve precision
  asset: string;
  status: 'pending' | 'completed' | 'failed';
  tx_hash?: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Options for listing investments by investor
 */
export interface ListByInvestorOptions {
  investor_id: string;
  offering_id?: string;
  limit?: number;
  offset?: number;
}

/**
 * Investment input for creation
 */
export interface CreateInvestmentInput {
  investor_id: string;
  offering_id: string;
  amount: string;
  asset: string;
  status?: 'pending' | 'completed' | 'failed';
  tx_hash?: string;
}

/**
 * Investment Repository
 * Handles database operations for investments
 */
export class InvestmentRepository {
  constructor(private db: Pool) {}

  /**
   * List investments for a given investor with optional filters and pagination
   * @param options Query options including investor_id, offering_id, limit, offset
   * @returns Array of investments
   */
  async listByInvestor(options: ListByInvestorOptions): Promise<Investment[]> {
    const params: unknown[] = [options.investor_id];
    let paramIndex = 2;

    let query = `
      SELECT *
      FROM investments
      WHERE investor_id = $1
    `;

    if (options.offering_id !== undefined) {
      query += ` AND offering_id = $${paramIndex++}`;
      params.push(options.offering_id);
    }

    query += ' ORDER BY created_at DESC';

    if (options.limit !== undefined) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset !== undefined) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result: QueryResult<Investment> = await this.db.query(query, params);
    return result.rows.map((row) => this.mapInvestment(row));
  }

  /**
   * Create a new investment
   * @param input Investment data
   * @returns Created investment
   */
  async create(input: CreateInvestmentInput): Promise<Investment> {
    const query = `
      INSERT INTO investments (
        investor_id,
        offering_id,
        amount,
        asset,
        status,
        tx_hash,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING *
    `;

    const status = input.status || 'pending';
    const values = [
      input.investor_id,
      input.offering_id,
      input.amount,
      input.asset,
      status,
      input.tx_hash || null,
    ];

    const result: QueryResult<Investment> = await this.db.query(query, values);

    if (result.rows.length === 0) {
      throw new Error('Failed to create investment');
    }

    return this.mapInvestment(result.rows[0]);
  }

  /**
   * Find investments by offering
   * @param offeringId Offering ID
   * @returns Array of investments
   */
  async findByOffering(offeringId: string): Promise<Investment[]> {
    const query = `
      SELECT *
      FROM investments
      WHERE offering_id = $1
      ORDER BY created_at DESC
    `;

    const result: QueryResult<Investment> = await this.db.query(query, [offeringId]);
    return result.rows.map((row) => this.mapInvestment(row));
  }

  /**
   * Get aggregate stats for an offering
   * @param offeringId Offering ID
   * @returns Aggregate statistics
   */
  async getAggregateStats(offeringId: string): Promise<{ totalInvested: string; investorCount: number }> {
    const query = `
      SELECT
        COALESCE(SUM(amount), 0) as total_invested,
        COUNT(DISTINCT investor_id) as investor_count
      FROM investments
      WHERE offering_id = $1 AND status = 'completed'
    `;

    const result = await this.db.query<{ total_invested: string; investor_count: string }>(
      query,
      [offeringId]
    );
    const row = result.rows[0];

    return {
      totalInvested: row.total_invested.toString(),
      investorCount: parseInt(row.investor_count, 10),
    };
  }

  /**
   * Map database row to Investment entity
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapInvestment(row: any): Investment {
    return {
      id: row.id,
      investor_id: row.investor_id,
      offering_id: row.offering_id,
      amount: row.amount,
      asset: row.asset,
      status: row.status,
      tx_hash: row.tx_hash || undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
