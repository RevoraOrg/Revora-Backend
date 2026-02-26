
import {Pool, QueryResult} from "pg";
import { Pool, QueryResult } from 'pg';


/**
 * Investment entity
 */
export interface Investment {
  id: string;
  investor_id: string;
  offering_id: string;

  amount: string; // Decimal as string to preserve precision
  status: "pending" | "completed" | "cancelled" | "failed";

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
  status?: "pending" | "completed" | "cancelled" | "failed";

  asset: string;
  status?: 'pending' | 'completed' | 'failed';
  tx_hash?: stri
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
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING *
    `;

    const status = input.status || "pending";
    const values = [input.investor_id, input.offering_id, input.amount, status];

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

      throw new Error("Failed to create investment");

      throw new Error('Failed to create investment');

    }

    return this.mapInvestment(result.rows[0]);
  }

  /**

   * Get an investment by ID
   * @param id Investment ID
   * @returns Investment or null if not found
   */
  async getById(id: string): Promise<Investment | null> {
    const query = `
      SELECT * FROM investments
      WHERE id = $1
    `;

    const result: QueryResult<Investment> = await this.db.query(query, [id]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapInvestment(result.rows[0]);
  }

  /**
   * List investments by investor
   * @param investorId Investor ID
   * @returns Array of investments
   */
  async listByInvestor(investorId: string): Promise<Investment[]> {
    const query = `
      SELECT * FROM investments
      WHERE investor_id = $1
      ORDER BY created_at DESC
    `;

    const result: QueryResult<Investment> = await this.db.query(query, [
      investorId,
    ]);
=======
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
