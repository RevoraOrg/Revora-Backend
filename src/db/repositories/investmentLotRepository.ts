/**
 * Investment Lot Repository
 *
 * Handles database operations for investment lots used in cost-basis tax tracking.
 * Lots are immutable once created — cost_basis_per_unit, quantity, and acquired_at are never modified.
 * Only remaining_quantity and status are updated as disposals consume lots.
 *
 * @module db/repositories/investmentLotRepository
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import { InvestmentLot, CreateInvestmentLotInput, LotStatus } from '../../services/taxation/types';

interface InvestmentLotRow {
  id: string;
  investor_id: string;
  offering_id: string;
  investment_id: string;
  asset: string;
  quantity: string;
  cost_basis_per_unit: string;
  total_cost_basis: string;
  remaining_quantity: string;
  cost_currency: string;
  acquired_at: Date;
  jurisdiction: string;
  status: LotStatus;
  created_at: Date;
  updated_at: Date;
}

export class InvestmentLotRepository {
  constructor(private db: Pool) {}

  /**
   * Create a new investment lot.
   */
  async create(input: CreateInvestmentLotInput): Promise<InvestmentLot> {
    const totalCostBasis = input.quantity * input.cost_basis_per_unit;

    const query = `
      INSERT INTO investment_lots (
        investor_id, offering_id, investment_id, asset,
        quantity, cost_basis_per_unit, total_cost_basis,
        remaining_quantity, cost_currency, acquired_at,
        jurisdiction, status, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', NOW(), NOW())
      RETURNING *
    `;

    const values = [
      input.investor_id,
      input.offering_id,
      input.investment_id,
      input.asset,
      input.quantity.toString(),
      input.cost_basis_per_unit.toString(),
      totalCostBasis.toString(),
      input.quantity.toString(), // remaining_quantity starts at full quantity
      input.cost_currency || 'USD',
      input.acquired_at,
      input.jurisdiction || 'US',
    ];

    const result: QueryResult<InvestmentLotRow> = await this.db.query(query, values);
    if (result.rows.length === 0) {
      throw new Error('Failed to create investment lot');
    }

    return this.mapLot(result.rows[0]);
  }

  /**
   * Create a lot within a transaction.
   */
  async createWithClient(client: PoolClient, input: CreateInvestmentLotInput): Promise<InvestmentLot> {
    const totalCostBasis = input.quantity * input.cost_basis_per_unit;

    const query = `
      INSERT INTO investment_lots (
        investor_id, offering_id, investment_id, asset,
        quantity, cost_basis_per_unit, total_cost_basis,
        remaining_quantity, cost_currency, acquired_at,
        jurisdiction, status, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'open', NOW(), NOW())
      RETURNING *
    `;

    const result: QueryResult<InvestmentLotRow> = await client.query(query, [
      input.investor_id,
      input.offering_id,
      input.investment_id,
      input.asset,
      input.quantity.toString(),
      input.cost_basis_per_unit.toString(),
      totalCostBasis.toString(),
      input.quantity.toString(),
      input.cost_currency || 'USD',
      input.acquired_at,
      input.jurisdiction || 'US',
    ]);

    if (result.rows.length === 0) {
      throw new Error('Failed to create investment lot');
    }

    return this.mapLot(result.rows[0]);
  }

  /**
   * Find all available (open or partially_used) lots for an investor and offering.
   * Ordered by acquired_at ascending (FIFO-ready order).
   */
  async findAvailableLots(investorId: string, offeringId: string): Promise<InvestmentLot[]> {
    const query = `
      SELECT *
      FROM investment_lots
      WHERE investor_id = $1
        AND offering_id = $2
        AND status IN ('open', 'partially_used')
        AND remaining_quantity > 0
      ORDER BY acquired_at ASC
    `;

    const result: QueryResult<InvestmentLotRow> = await this.db.query(query, [
      investorId,
      offeringId,
    ]);

    return result.rows.map((row) => this.mapLot(row));
  }

  /**
   * Find available lots within a transaction (for atomic disposal).
   * Uses FOR UPDATE to lock lots against concurrent disposals.
   */
  async findAvailableLotsForUpdate(
    client: PoolClient,
    investorId: string,
    offeringId: string,
  ): Promise<InvestmentLot[]> {
    const query = `
      SELECT *
      FROM investment_lots
      WHERE investor_id = $1
        AND offering_id = $2
        AND status IN ('open', 'partially_used')
        AND remaining_quantity > 0
      ORDER BY acquired_at ASC
      FOR UPDATE
    `;

    const result: QueryResult<InvestmentLotRow> = await client.query(query, [
      investorId,
      offeringId,
    ]);

    return result.rows.map((row) => this.mapLot(row));
  }

  /**
   * Update a lot's remaining quantity and status within a transaction.
   * Used when consuming lots during a disposal.
   */
  async updateLotAfterDisposal(
    client: PoolClient,
    lotId: string,
    newRemainingQuantity: number,
  ): Promise<void> {
    const newStatus: LotStatus =
      newRemainingQuantity <= 0 ? 'exhausted' : 'partially_used';

    const query = `
      UPDATE investment_lots
      SET remaining_quantity = $1, status = $2, updated_at = NOW()
      WHERE id = $3
      RETURNING id
    `;

    const result: QueryResult<{ id: string }> = await client.query(query, [
      newRemainingQuantity.toString(),
      newStatus,
      lotId,
    ]);

    if (result.rows.length === 0) {
      throw new Error(`Failed to update lot ${lotId} after disposal`);
    }
  }

  /**
   * Find a single lot by ID.
   */
  async findById(lotId: string): Promise<InvestmentLot | null> {
    const query = 'SELECT * FROM investment_lots WHERE id = $1';
    const result: QueryResult<InvestmentLotRow> = await this.db.query(query, [lotId]);

    if (result.rows.length === 0) return null;
    return this.mapLot(result.rows[0]);
  }

  /**
   * List all lots for an investor across all offerings.
   */
  async listByInvestor(investorId: string): Promise<InvestmentLot[]> {
    const query = `
      SELECT *
      FROM investment_lots
      WHERE investor_id = $1
      ORDER BY acquired_at DESC
    `;

    const result: QueryResult<InvestmentLotRow> = await this.db.query(query, [investorId]);
    return result.rows.map((row) => this.mapLot(row));
  }

  /**
   * Get total remaining quantity for an investor+offering pair.
   */
  async getTotalRemainingQuantity(investorId: string, offeringId: string): Promise<number> {
    const query = `
      SELECT COALESCE(SUM(remaining_quantity), 0) as total
      FROM investment_lots
      WHERE investor_id = $1
        AND offering_id = $2
        AND status IN ('open', 'partially_used')
    `;

    const result = await this.db.query<{ total: string }>(query, [investorId, offeringId]);
    return parseFloat(result.rows[0]?.total ?? '0');
  }

  private mapLot(row: InvestmentLotRow): InvestmentLot {
    return {
      id: row.id,
      investor_id: row.investor_id,
      offering_id: row.offering_id,
      investment_id: row.investment_id,
      asset: row.asset,
      quantity: parseFloat(row.quantity),
      cost_basis_per_unit: parseFloat(row.cost_basis_per_unit),
      total_cost_basis: parseFloat(row.total_cost_basis),
      remaining_quantity: parseFloat(row.remaining_quantity),
      cost_currency: row.cost_currency,
      acquired_at: row.acquired_at,
      jurisdiction: row.jurisdiction,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
