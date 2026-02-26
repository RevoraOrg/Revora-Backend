"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BalanceSnapshotRepository = void 0;
/**
 * Balance Snapshot Repository
 * Handles database operations for token balance snapshots
 * Used by the distribution engine to compute payouts
 */
class BalanceSnapshotRepository {
    constructor(db) {
        this.db = db;
    }
    /**
     * Insert a new token balance snapshot
     * @param input Snapshot data
     * @returns Created snapshot
     */
    async insert(input) {
        const query = `
      INSERT INTO token_balance_snapshots (
        offering_id,
        period_id,
        holder_address_or_id,
        balance,
        snapshot_at,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `;
        const values = [
            input.offering_id,
            input.period_id,
            input.holder_address_or_id,
            input.balance,
            input.snapshot_at ?? new Date(),
        ];
        const result = await this.db.query(query, values);
        if (result.rows.length === 0) {
            throw new Error('Failed to insert token balance snapshot');
        }
        return this.mapSnapshot(result.rows[0]);
    }
    /**
     * Insert multiple snapshots in a single transaction
     * @param inputs Array of snapshot data
     * @returns Array of created snapshots
     */
    async insertMany(inputs) {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            const snapshots = [];
            for (const input of inputs) {
                const result = await client.query(`INSERT INTO token_balance_snapshots
            (offering_id, period_id, holder_address_or_id, balance, snapshot_at, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           RETURNING *`, [
                    input.offering_id,
                    input.period_id,
                    input.holder_address_or_id,
                    input.balance,
                    input.snapshot_at ?? new Date(),
                ]);
                snapshots.push(this.mapSnapshot(result.rows[0]));
            }
            await client.query('COMMIT');
            return snapshots;
        }
        catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        finally {
            client.release();
        }
    }
    /**
     * Get all snapshots for a given offering and period
     * @param offeringId Offering ID
     * @param periodId Period ID
     * @returns Array of snapshots
     */
    async findByOfferingAndPeriod(offeringId, periodId) {
        const query = `
      SELECT *
      FROM token_balance_snapshots
      WHERE offering_id = $1
        AND period_id = $2
      ORDER BY snapshot_at DESC, created_at DESC
    `;
        const result = await this.db.query(query, [offeringId, periodId]);
        return result.rows.map((row) => this.mapSnapshot(row));
    }
    /**
     * Get all snapshots for a given offering
     * @param offeringId Offering ID
     * @returns Array of snapshots
     */
    async findByOffering(offeringId) {
        const query = `
      SELECT *
      FROM token_balance_snapshots
      WHERE offering_id = $1
      ORDER BY snapshot_at DESC, created_at DESC
    `;
        const result = await this.db.query(query, [offeringId]);
        return result.rows.map((row) => this.mapSnapshot(row));
    }
    /**
     * Map database row to TokenBalanceSnapshot entity
     */
    mapSnapshot(row) {
        return {
            id: row.id,
            offering_id: row.offering_id,
            period_id: row.period_id,
            holder_address_or_id: row.holder_address_or_id,
            balance: row.balance,
            snapshot_at: row.snapshot_at,
            created_at: row.created_at,
        };
    }
}
exports.BalanceSnapshotRepository = BalanceSnapshotRepository;
