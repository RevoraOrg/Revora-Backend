"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OfferingRepository = void 0;
/**
 * Offering Repository
 * Handles database operations for offerings
 */
class OfferingRepository {
    constructor(db) {
        this.db = db;
    }
    /**
     * Find an offering by ID
     * @param id Offering ID
     * @returns Offering if found, undefined otherwise
     */
    async findById(id) {
        const query = `
      SELECT * FROM offerings
      WHERE id = $1
    `;
        const result = await this.db.query(query, [id]);
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
    async findActiveById(id) {
        const query = `
      SELECT * FROM offerings
      WHERE id = $1 AND status = 'active'
    `;
        const result = await this.db.query(query, [id]);
        if (result.rows.length === 0) {
            return undefined;
        }
        return this.mapOffering(result.rows[0]);
    }
    /**
     * Map database row to Offering entity
     */
    mapOffering(row) {
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
exports.OfferingRepository = OfferingRepository;
