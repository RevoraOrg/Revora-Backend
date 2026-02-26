import { Pool, QueryResult } from 'pg';

/**
 * Offering entity
 */
export interface Offering {
  id: string;
  contract_address: string;
  status: 'draft' | 'active' | 'closed' | 'completed';
  total_raised: string; // Decimal as string to preserve precision
export type OfferingStatus =
  | 'draft'
  | 'open'
  | 'closed'
  | 'paused'
  | 'cancelled'
  | 'active'
  | 'completed'
  | string;

export interface Offering {
  id: string;
  issuer_user_id?: string;
  issuer_id?: string;
  name?: string;
  symbol?: string;
  status?: OfferingStatus;
  created_at?: Date;
  updated_at?: Date;
  [key: string]: unknown;
}

export type CreateOfferingInput = Record<string, unknown>;
export type UpdateOfferingInput = Record<string, unknown>;

export interface ListOfferingsFilters {
  status?: OfferingStatus;
  limit?: number;
  offset?: number;
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
export class OfferingRepository {
  constructor(private db: Pool) {}

  async create(offering: CreateOfferingInput): Promise<Offering> {
    const entries = this.getDefinedEntries(offering);
    if (entries.length === 0) {
      throw new Error('create requires at least one offering field');
    }

    const columns = entries.map(([column]) => column);
    const values = entries.map(([, value]) => value);
    const placeholders = values.map((_, index) => `$${index + 1}`);

    const query = `
      INSERT INTO offerings (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `;

    const result: QueryResult<Offering> = await this.db.query(query, values);
    if (result.rows.length === 0) {
      throw new Error('Failed to create offering');
    }

    return this.mapOffering(result.rows[0]);
  }

  async getById(id: string): Promise<Offering | null> {
    const query = `
      SELECT *
      FROM offerings
      WHERE id = $1
      LIMIT 1
    `;

    const result: QueryResult<Offering> = await this.db.query(query, [id]);
    if (result.rows.length === 0) {
      return null;
    }

    return this.mapOffering(result.rows[0]);
  }

  async findById(id: string): Promise<Offering | null> {
    return this.getById(id);
  }

  async listByIssuer(
    issuerUserId: string,
    filters: ListOfferingsFilters = {}
  ): Promise<Offering[]> {
    const values: unknown[] = [issuerUserId];
    const whereClauses: string[] = ['(issuer_user_id = $1 OR issuer_id = $1)'];

    if (filters.status !== undefined) {
      values.push(filters.status);
      whereClauses.push(`status = $${values.length}`);
    }

    let query = `
      SELECT *
      FROM offerings
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY created_at DESC
    `;

    if (filters.limit !== undefined) {
      values.push(filters.limit);
      query += ` LIMIT $${values.length}`;
    }

    if (filters.offset !== undefined) {
      values.push(filters.offset);
      query += ` OFFSET $${values.length}`;
    }

    const result: QueryResult<Offering> = await this.db.query(query, values);
    return result.rows.map((row) => this.mapOffering(row));
  }

  async update(id: string, partial: UpdateOfferingInput): Promise<Offering | null> {
    const entries = this.getDefinedEntries(partial);
    if (entries.length === 0) {
      return this.getById(id);
    }

    const setClauses = entries.map(
      ([column], index) => `${column} = $${index + 1}`
    );
    const values = entries.map(([, value]) => value);
    values.push(id);

    const query = `
      UPDATE offerings
      SET ${setClauses.join(', ')}, updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING *
    `;

    const result: QueryResult<Offering> = await this.db.query(query, values);
    if (result.rows.length === 0) {
      return null;
    }

    return this.mapOffering(result.rows[0]);
  }

  async updateStatus(id: string, status: OfferingStatus): Promise<Offering | null> {
    return this.update(id, { status });
  }

  async isOwner(offeringId: string, issuerId: string): Promise<boolean> {
    const offering = await this.findById(offeringId);
    if (!offering) {
      return false;
    }

    return (offering.issuer_id ?? offering.issuer_user_id) === issuerId;
  }

  private getDefinedEntries(payload: Record<string, unknown>) {
    return Object.entries(payload).filter(([, value]) => value !== undefined);
  }

  private mapOffering(row: Record<string, unknown>): Offering {
    const offering = { ...(row as Offering) };
    if (!offering.issuer_id && typeof offering.issuer_user_id === 'string') {
      offering.issuer_id = offering.issuer_user_id;
    }
    return offering;
  }
}
