import {Pool, QueryResult} from "pg";

/**
 * Offering entity
 */
export interface Offering {
  id: string;
  name: string;
  description?: string;
  target_amount: string;
  min_investment: string;
  max_investment?: string;
  status: "active" | "closed" | "cancelled";
  issuer_id: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Offering Repository
 * Handles database operations for offerings
 */
export class OfferingRepository {
  constructor(private db: Pool) {}

  /**
   * Find an offering by ID
   * @param id Offering ID
   * @returns Offering if found, undefined otherwise
   */
  async findById(id: string): Promise<Offering | undefined> {
    const query = `
      SELECT * FROM offerings
      WHERE id = $1
    `;

    const result: QueryResult<Offering> = await this.db.query(query, [id]);

    if (result.rows.length === 0) {
      return undefined;
    }

    return this.mapOffering(result.rows[0]);
  }

  /**
   * Find an active offering by ID
   * @param id Offering ID
   * @returns Active offering if found, undefined otherwise
   */
  async findActiveById(id: string): Promise<Offering | undefined> {
    const query = `
      SELECT * FROM offerings
      WHERE id = $1 AND status = 'active'
    `;

    const result: QueryResult<Offering> = await this.db.query(query, [id]);

    if (result.rows.length === 0) {
      return undefined;
    }

    return this.mapOffering(result.rows[0]);
  }

  /**
   * Map database row to Offering entity
   */
  private mapOffering(row: any): Offering {
    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      target_amount: row.target_amount,
      min_investment: row.min_investment,
      max_investment: row.max_investment || undefined,
      status: row.status,
      issuer_id: row.issuer_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
