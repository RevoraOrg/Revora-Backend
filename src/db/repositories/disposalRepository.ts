/**
 * Disposal Repository
 *
 * Handles database operations for disposals (lot consumptions for tax reporting).
 * Disposal records are immutable once created — historical evaluations cannot be altered.
 *
 * @module db/repositories/disposalRepository
 */

import { Pool, PoolClient, QueryResult } from 'pg';
import {
  Disposal,
  CreateDisposalInput,
  DisposalStrategy,
  JurisdictionGainsSummary,
} from '../../services/taxation/types';

interface JurisdictionAggregationRow {
  jurisdiction: string;
  total_proceeds: string;
  total_cost_basis: string;
  total_realized_gain_loss: string;
  disposal_count: string;
  strategy: DisposalStrategy;
  strategy_count: string;
  strategy_gain_loss: string;
}

interface DisposalRow {
  id: string;
  investor_id: string;
  offering_id: string;
  lot_id: string;
  quantity_disposed: string;
  cost_basis_per_unit: string;
  total_cost_basis: string;
  proceeds: string;
  realized_gain_loss: string;
  disposal_price_per_unit: string;
  strategy: DisposalStrategy;
  currency: string;
  jurisdiction: string;
  disposed_at: Date;
  tax_report_finalized: boolean;
  tax_report_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export class DisposalRepository {
  constructor(private db: Pool) {}

  /**
   * Create a disposal record within a transaction.
   * Disposals are immutable once created.
   */
  async createWithClient(client: PoolClient, input: CreateDisposalInput): Promise<Disposal> {
    const query = `
      INSERT INTO disposals (
        investor_id, offering_id, lot_id,
        quantity_disposed, cost_basis_per_unit, total_cost_basis,
        proceeds, realized_gain_loss, disposal_price_per_unit,
        strategy, currency, jurisdiction, disposed_at,
        tax_report_finalized, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, FALSE, NOW(), NOW())
      RETURNING *
    `;

    const result: QueryResult<DisposalRow> = await client.query(query, [
      input.investor_id,
      input.offering_id,
      input.lot_id,
      input.quantity_disposed.toString(),
      input.cost_basis_per_unit.toString(),
      input.total_cost_basis.toString(),
      input.proceeds.toString(),
      input.realized_gain_loss.toString(),
      input.disposal_price_per_unit.toString(),
      input.strategy,
      input.currency || 'USD',
      input.jurisdiction || 'US',
      input.disposed_at,
    ]);

    if (result.rows.length === 0) {
      throw new Error('Failed to create disposal record');
    }

    return this.mapDisposal(result.rows[0]);
  }

  /**
   * List all disposals for an investor.
   */
  async listByInvestor(investorId: string): Promise<Disposal[]> {
    const query = `
      SELECT *
      FROM disposals
      WHERE investor_id = $1
      ORDER BY disposed_at DESC
    `;

    const result: QueryResult<DisposalRow> = await this.db.query(query, [investorId]);
    return result.rows.map((row) => this.mapDisposal(row));
  }

  /**
   * List disposals for an investor in a specific offering.
   */
  async listByInvestorAndOffering(investorId: string, offeringId: string): Promise<Disposal[]> {
    const query = `
      SELECT *
      FROM disposals
      WHERE investor_id = $1 AND offering_id = $2
      ORDER BY disposed_at DESC
    `;

    const result: QueryResult<DisposalRow> = await this.db.query(query, [
      investorId,
      offeringId,
    ]);
    return result.rows.map((row) => this.mapDisposal(row));
  }

  /**
   * Get jurisdiction-level gains summary for an investor.
   * Aggregates disposal data per jurisdiction with strategy breakdowns.
   */
  async getJurisdictionGainsSummary(investorId: string): Promise<JurisdictionGainsSummary[]> {
    const query = `
      SELECT
        jurisdiction,
        SUM(proceeds)::text AS total_proceeds,
        SUM(total_cost_basis)::text AS total_cost_basis,
        SUM(realized_gain_loss)::text AS total_realized_gain_loss,
        COUNT(*)::text AS disposal_count,
        strategy,
        COUNT(*)::text AS strategy_count,
        SUM(realized_gain_loss)::text AS strategy_gain_loss
      FROM disposals
      WHERE investor_id = $1
      GROUP BY jurisdiction, strategy
      ORDER BY jurisdiction, strategy
    `;

    const result = await this.db.query<JurisdictionAggregationRow>(query, [investorId]);
    return this.aggregateJurisdictionRows(result.rows);
  }

  /**
   * Get jurisdiction-level gains summary for a specific offering.
   */
  async getJurisdictionGainsSummaryByOffering(
    offeringId: string,
  ): Promise<JurisdictionGainsSummary[]> {
    const query = `
      SELECT
        jurisdiction,
        SUM(proceeds)::text AS total_proceeds,
        SUM(total_cost_basis)::text AS total_cost_basis,
        SUM(realized_gain_loss)::text AS total_realized_gain_loss,
        COUNT(*)::text AS disposal_count,
        strategy,
        COUNT(*)::text AS strategy_count,
        SUM(realized_gain_loss)::text AS strategy_gain_loss
      FROM disposals
      WHERE offering_id = $1
      GROUP BY jurisdiction, strategy
      ORDER BY jurisdiction, strategy
    `;

    const result = await this.db.query<JurisdictionAggregationRow>(query, [offeringId]);
    return this.aggregateJurisdictionRows(result.rows);
  }

  /**
   * Find a disposal by ID.
   */
  async findById(disposalId: string): Promise<Disposal | null> {
    const query = 'SELECT * FROM disposals WHERE id = $1';
    const result: QueryResult<DisposalRow> = await this.db.query(query, [disposalId]);

    if (result.rows.length === 0) return null;
    return this.mapDisposal(result.rows[0]);
  }

  /**
   * Aggregate jurisdiction-level rows into summary objects.
   * Shared by both getJurisdictionGainsSummary and getJurisdictionGainsSummaryByOffering.
   */
  private aggregateJurisdictionRows(
    rows: JurisdictionAggregationRow[],
  ): JurisdictionGainsSummary[] {
    const jurisdictionMap = new Map<string, JurisdictionGainsSummary>();

    for (const row of rows) {
      if (!jurisdictionMap.has(row.jurisdiction)) {
        jurisdictionMap.set(row.jurisdiction, {
          jurisdiction: row.jurisdiction,
          totalProceeds: 0,
          totalCostBasis: 0,
          totalRealizedGainLoss: 0,
          disposalCount: 0,
          strategyBreakdown: {
            FIFO: { count: 0, totalGainLoss: 0 },
            LIFO: { count: 0, totalGainLoss: 0 },
            HIFO: { count: 0, totalGainLoss: 0 },
          },
        });
      }

      const summary = jurisdictionMap.get(row.jurisdiction)!;
      summary.totalProceeds += parseFloat(row.total_proceeds);
      summary.totalCostBasis += parseFloat(row.total_cost_basis);
      summary.totalRealizedGainLoss += parseFloat(row.total_realized_gain_loss);
      summary.disposalCount += parseInt(row.disposal_count, 10);

      if (summary.strategyBreakdown[row.strategy]) {
        summary.strategyBreakdown[row.strategy].count += parseInt(row.strategy_count, 10);
        summary.strategyBreakdown[row.strategy].totalGainLoss += parseFloat(row.strategy_gain_loss);
      }
    }

    return Array.from(jurisdictionMap.values());
  }

  private mapDisposal(row: DisposalRow): Disposal {
    return {
      id: row.id,
      investor_id: row.investor_id,
      offering_id: row.offering_id,
      lot_id: row.lot_id,
      quantity_disposed: parseFloat(row.quantity_disposed),
      cost_basis_per_unit: parseFloat(row.cost_basis_per_unit),
      total_cost_basis: parseFloat(row.total_cost_basis),
      proceeds: parseFloat(row.proceeds),
      realized_gain_loss: parseFloat(row.realized_gain_loss),
      disposal_price_per_unit: parseFloat(row.disposal_price_per_unit),
      strategy: row.strategy,
      currency: row.currency,
      jurisdiction: row.jurisdiction,
      disposed_at: row.disposed_at,
      tax_report_finalized: row.tax_report_finalized,
      tax_report_id: row.tax_report_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
