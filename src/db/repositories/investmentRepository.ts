import {Pool, QueryResult} from "pg";

/**
 * Investment entity
 */
export interface Investment {
  id: string;
  investor_id: string;
  offering_id: string;
  amount: string; // Decimal as string to preserve precision
  status: "pending" | "completed" | "cancelled" | "failed";
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

    const result: QueryResult<Investment> = await this.db.query(query, values);

    if (result.rows.length === 0) {
      throw new Error("Failed to create investment");
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

    return result.rows.map((row) => this.mapInvestment(row));
  }

  /**
   * List investments by offering
   * @param offeringId Offering ID
   * @returns Array of investments
   */
  async listByOffering(offeringId: string): Promise<Investment[]> {
    const query = `
      SELECT * FROM investments
      WHERE offering_id = $1
      ORDER BY created_at DESC
    `;

    const result: QueryResult<Investment> = await this.db.query(query, [
      offeringId,
    ]);

    return result.rows.map((row) => this.mapInvestment(row));
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
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
