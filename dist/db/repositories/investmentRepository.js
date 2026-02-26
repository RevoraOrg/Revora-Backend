"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvestmentRepository = void 0;
/**
 * Investment Repository
 * Handles database operations for investments
 */
class InvestmentRepository {
    constructor(db) {
        this.db = db;
    }
    /**
     * Create a new investment
     * @param input Investment data
     * @returns Created investment
     */
    async create(input) {
        const query = `
      INSERT INTO investments (
        offering_id,
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
        const status = input.status || "pending";
        const values = [
            input.offering_id,
            input.investor_id,
            input.amount,
            status,
            input.transaction_hash || null,
        ];
        const result = await this.db.query(query, values);
        if (result.rows.length === 0) {
            throw new Error("Failed to create investment");
        }
        return this.mapInvestment(result.rows[0]);
    }
    /**
     * Find an investment by ID
     * @param id Investment ID
     * @returns Investment if found, undefined otherwise
     */
    async findById(id) {
        const query = `
      SELECT * FROM investments
      WHERE id = $1
    `;
        const result = await this.db.query(query, [id]);
        if (result.rows.length === 0) {
            return undefined;
        }
        return this.mapInvestment(result.rows[0]);
    }
    /**
     * Find investments by offering
     * @param offeringId Offering ID
     * @returns Array of investments
     */
    async findByOffering(offeringId) {
        const query = `
      SELECT * FROM investments
      WHERE offering_id = $1
      ORDER BY created_at DESC
    `;
        const result = await this.db.query(query, [
            offeringId,
        ]);
        return result.rows.map((row) => this.mapInvestment(row));
    }
    /**
     * Find investments by investor
     * @param investorId Investor ID
     * @returns Array of investments
     */
    async findByInvestor(investorId) {
        const query = `
      SELECT * FROM investments
      WHERE investor_id = $1
      ORDER BY created_at DESC
    `;
        const result = await this.db.query(query, [
            investorId,
        ]);
        return result.rows.map((row) => this.mapInvestment(row));
    }
    /**
     * Map database row to Investment entity
     */
    mapInvestment(row) {
        return {
            id: row.id,
            offering_id: row.offering_id,
            investor_id: row.investor_id,
            amount: row.amount,
            status: row.status,
            transaction_hash: row.transaction_hash || undefined,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }
}
exports.InvestmentRepository = InvestmentRepository;
