/**
 * Wash Sale Adjustment Repository
 *
 * Handles database operations for wash-sale cost-basis adjustments.
 * Adjustments are idempotent per (investor_id, offering_id, disposed_at).
 *
 * @module db/repositories/washSaleAdjustmentRepository
 */

import { Pool, PoolClient, QueryResult } from 'pg';

export interface WashSaleAdjustment {
  id: string;
  investor_id: string;
  offering_id: string;
  lot_id: string;
  original_disposal_id: string | null;
  adjustment_amount: number;
  original_cost_basis_per_unit: number;
  adjusted_cost_basis_per_unit: number;
  window_days: number;
  disposed_at: Date;
  created_at: Date;
}

export interface CreateWashSaleAdjustmentInput {
  investor_id: string;
  offering_id: string;
  lot_id: string;
  original_disposal_id?: string | null;
  adjustment_amount: number;
  original_cost_basis_per_unit: number;
  adjusted_cost_basis_per_unit: number;
  window_days: number;
  disposed_at: Date;
}

interface WashSaleAdjustmentRow {
  id: string;
  investor_id: string;
  offering_id: string;
  lot_id: string;
  original_disposal_id: string | null;
  adjustment_amount: string;
  original_cost_basis_per_unit: string;
  adjusted_cost_basis_per_unit: string;
  window_days: string;
  disposed_at: Date;
  created_at: Date;
}

export class WashSaleAdjustmentRepository {
  constructor(private db: Pool) {}

  /**
   * Create a wash-sale adjustment within a transaction.
   */
  async createWithClient(
    client: PoolClient,
    input: CreateWashSaleAdjustmentInput,
  ): Promise<WashSaleAdjustment> {
    const query = `
      INSERT INTO wash_sale_adjustments (
        investor_id, offering_id, lot_id, original_disposal_id,
        adjustment_amount, original_cost_basis_per_unit,
        adjusted_cost_basis_per_unit, window_days, disposed_at, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING *
    `;

    const result: QueryResult<WashSaleAdjustmentRow> = await client.query(query, [
      input.investor_id,
      input.offering_id,
      input.lot_id,
      input.original_disposal_id ?? null,
      input.adjustment_amount.toString(),
      input.original_cost_basis_per_unit.toString(),
      input.adjusted_cost_basis_per_unit.toString(),
      input.window_days.toString(),
      input.disposed_at,
    ]);

    if (result.rows.length === 0) {
      throw new Error('Failed to create wash-sale adjustment');
    }

    return this.mapAdjustment(result.rows[0]);
  }

  /**
   * Find an existing adjustment for the same investor+offering+disposal date.
   * Used for idempotency enforcement.
   */
  async findByInvestorOfferingDate(
    client: PoolClient,
    investorId: string,
    offeringId: string,
    disposedAt: Date,
  ): Promise<WashSaleAdjustment | null> {
    const query = `
      SELECT *
      FROM wash_sale_adjustments
      WHERE investor_id = $1
        AND offering_id = $2
        AND disposed_at = $3
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const result: QueryResult<WashSaleAdjustmentRow> = await client.query(query, [
      investorId,
      offeringId,
      disposedAt,
    ]);

    if (result.rows.length === 0) return null;
    return this.mapAdjustment(result.rows[0]);
  }

  /**
   * List all adjustments for an investor.
   */
  async listByInvestor(investorId: string): Promise<WashSaleAdjustment[]> {
    const query = `
      SELECT *
      FROM wash_sale_adjustments
      WHERE investor_id = $1
      ORDER BY disposed_at DESC
    `;

    const result: QueryResult<WashSaleAdjustmentRow> = await this.db.query(query, [
      investorId,
    ]);

    return result.rows.map((row) => this.mapAdjustment(row));
  }

  /**
   * List adjustments for a specific lot.
   */
  async listByLot(lotId: string): Promise<WashSaleAdjustment[]> {
    const query = `
      SELECT *
      FROM wash_sale_adjustments
      WHERE lot_id = $1
      ORDER BY disposed_at DESC
    `;

    const result: QueryResult<WashSaleAdjustmentRow> = await this.db.query(query, [
      lotId,
    ]);

    return result.rows.map((row) => this.mapAdjustment(row));
  }

  private mapAdjustment(row: WashSaleAdjustmentRow): WashSaleAdjustment {
    return {
      id: row.id,
      investor_id: row.investor_id,
      offering_id: row.offering_id,
      lot_id: row.lot_id,
      original_disposal_id: row.original_disposal_id,
      adjustment_amount: parseFloat(row.adjustment_amount),
      original_cost_basis_per_unit: parseFloat(row.original_cost_basis_per_unit),
      adjusted_cost_basis_per_unit: parseFloat(row.adjusted_cost_basis_per_unit),
      window_days: parseInt(row.window_days, 10),
      disposed_at: row.disposed_at,
      created_at: row.created_at,
    };
  }
}

/**
 * Factory function to create WashSaleAdjustmentRepository.
 */
export function createWashSaleAdjustmentRepository(db: Pool): WashSaleAdjustmentRepository {
  return new WashSaleAdjustmentRepository(db);
}