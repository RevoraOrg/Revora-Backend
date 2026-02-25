import { Pool, QueryResult } from 'pg';

/**
 * Offering entity
 */
export interface Offering {
  id: string;
  contract_address: string;
  status: 'draft' | 'active' | 'closed' | 'completed';
  total_raised: string; // Decimal as string to preserve precision
  created_at: Date;
  updated_at: Date;
}

/**
 * Input for updating offering state from chain
 */
export interface UpdateOfferingStateInput {
  status?: 'draft' | 'active' | 'closed' | 'completed';
  total_raised?: string;
}

/**
 * Offering Repository
 * Handles database operations for offerings
 */
export class OfferingRepository {
  constructor(private db: Pool) {}

  /**
   * Find an offering by ID
   */
  async findById(id: string): Promise<Offering | null> {
    const query = `SELECT * FROM offerings WHERE id = $1 LIMIT 1`;
    const result: QueryResult<Offering> = await this.db.query(query, [id]);
    return result.rows.length > 0 ? this.mapOffering(result.rows[0]) : null;
  }

  /**
   * Find an offering by contract address
   */
  async findByContractAddress(
    contractAddress: string
  ): Promise<Offering | null> {
    const query = `SELECT * FROM offerings WHERE contract_address = $1 LIMIT 1`;
    const result: QueryResult<Offering> = await this.db.query(query, [
      contractAddress,
    ]);
    return result.rows.length > 0 ? this.mapOffering(result.rows[0]) : null;
  }

  /**
   * List all offerings
   */
  async listAll(): Promise<Offering[]> {
    const query = `SELECT * FROM offerings ORDER BY created_at DESC`;
    const result: QueryResult<Offering> = await this.db.query(query);
    return result.rows.map((row: any) => this.mapOffering(row));
  }

  /**
   * Update offering state (status and/or total_raised)
   */
  async updateState(
    id: string,
    input: UpdateOfferingStateInput
  ): Promise<Offering | null> {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (input.status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(input.status);
    }
    if (input.total_raised !== undefined) {
      fields.push(`total_raised = $${idx++}`);
      values.push(input.total_raised);
    }

    if (fields.length === 0) return this.findById(id);

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const query = `
      UPDATE offerings
      SET ${fields.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `;

    const result: QueryResult<Offering> = await this.db.query(query, values);
    return result.rows.length > 0 ? this.mapOffering(result.rows[0]) : null;
  }

  /**
   * Map database row to Offering entity
   */
  private mapOffering(row: any): Offering {
    return {
      id: row.id,
      contract_address: row.contract_address,
      status: row.status,
      total_raised: row.total_raised,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}