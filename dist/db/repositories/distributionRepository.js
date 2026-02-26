"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DistributionRepository = void 0;
/**
 * Distribution Repository
 * Handles database operations for distributions and payouts
 */
class DistributionRepository {
    constructor(db) {
        this.db = db;
    }
    /**
     * Create a new distribution run
     * @param input Distribution run data
     * @returns Created distribution run
     */
    async createDistributionRun(input) {
        const query = `
      INSERT INTO distribution_runs (
        offering_id,
        total_amount,
        distribution_date,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING *
    `;
        const status = input.status || 'pending';
        const values = [
            input.offering_id,
            input.total_amount,
            input.distribution_date,
            status,
        ];
        const result = await this.db.query(query, values);
        if (result.rows.length === 0) {
            throw new Error('Failed to create distribution run');
        }
        return this.mapDistributionRun(result.rows[0]);
    }
    /**
     * Create a new payout
     * @param input Payout data
     * @returns Created payout
     */
    async createPayout(input) {
        const query = `
      INSERT INTO payouts (
        distribution_run_id,
        investor_id,
        amount,
        status,
        transaction_hash,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      RETURNING *
    `;
        const status = input.status || 'pending';
        const values = [
            input.distribution_run_id,
            input.investor_id,
            input.amount,
            status,
            input.transaction_hash || null,
        ];
        const result = await this.db.query(query, values);
        if (result.rows.length === 0) {
            throw new Error('Failed to create payout');
        }
        return this.mapPayout(result.rows[0]);
    }
    /**
     * List distribution runs by offering
     * @param offeringId Offering ID
     * @returns Array of distribution runs
     */
    async listByOffering(offeringId) {
        const query = `
      SELECT *
      FROM distribution_runs
      WHERE offering_id = $1
      ORDER BY distribution_date DESC, created_at DESC
    `;
        const result = await this.db.query(query, [
            offeringId,
        ]);
        return result.rows.map((row) => this.mapDistributionRun(row));
    }
    /**
     * List payouts by investor
     * @param investorId Investor ID
     * @returns Array of payouts
     */
    async listPayoutsByInvestor(investorId) {
        const query = `
      SELECT *
      FROM payouts
      WHERE investor_id = $1
      ORDER BY created_at DESC
    `;
        const result = await this.db.query(query, [
            investorId,
        ]);
        return result.rows.map((row) => this.mapPayout(row));
    }
    /**
     * Map database row to DistributionRun entity
     */
    mapDistributionRun(row) {
        return {
            id: row.id,
            offering_id: row.offering_id,
            total_amount: row.total_amount,
            distribution_date: row.distribution_date,
            status: row.status,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }
    /**
     * Map database row to Payout entity
     */
    mapPayout(row) {
        return {
            id: row.id,
            distribution_run_id: row.distribution_run_id,
            investor_id: row.investor_id,
            amount: row.amount,
            status: row.status,
            transaction_hash: row.transaction_hash || undefined,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }
}
exports.DistributionRepository = DistributionRepository;
