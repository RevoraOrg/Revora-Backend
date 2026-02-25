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

    const result = await this.db.query(query, [offeringId]);
    const row = result.rows[0];

    return {
      totalInvested: row.total_invested.toString(),
      investorCount: parseInt(row.investor_count, 10),
    };
  }

  /**
   * Map database row to Investment entity
   */
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
