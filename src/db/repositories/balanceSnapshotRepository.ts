import { Pool, QueryResult } from 'pg';

/**
 * Token Balance Snapshot entity
 */
export interface TokenBalanceSnapshot {
  id: string;
  offering_id: string;
  period_id: string;
  holder_address_or_id: string;
  balance: string; // Numeric as string to preserve precision
  snapshot_at: Date;
  created_at: Date;
}

/**
 * Input for creating a snapshot
 * snapshot_at is now REQUIRED (not optional) to enforce determinism at the repository level.
 * Callers must always provide an explicit timestamp.
 */
export interface CreateSnapshotInput {
  offering_id: string;
  period_id: string;
  holder_address_or_id: string;
  balance: string;
  snapshot_at: Date; // REQUIRED, never defaults to now()
}

/**
 * Balance Snapshot Repository
 * Handles database operations for token balance snapshots
 * Used by the distribution engine to compute payouts
 */
export class BalanceSnapshotRepository {
  constructor(private db: Pool) {}

  /**
   * Insert a new token balance snapshot
   * @param input Snapshot data (snapshot_at is required)
   * @returns Created snapshot
   * @throws Error if snapshot_at is not provided
   */
  async insert(input: CreateSnapshotInput): Promise<TokenBalanceSnapshot> {
    if (!input.snapshot_at) {
      throw new Error('snapshot_at is required when inserting a token balance snapshot');
    }

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
      input.snapshot_at,
    ];

    const result: QueryResult<TokenBalanceSnapshot> = await this.db.query(
      query,
      values
    );

    if (result.rows.length === 0) {
      throw new Error('Failed to insert token balance snapshot');
    }

    return this.mapSnapshot(result.rows[0]);
  }

  /**
   * Insert multiple snapshots in a single transaction
   * @param inputs Array of snapshot data (snapshot_at is required for each)
   * @returns Array of created snapshots
   * @throws Error if any snapshot_at is not provided
   */
  async insertMany(
    inputs: CreateSnapshotInput[]
  ): Promise<TokenBalanceSnapshot[]> {
    // Validate that all inputs have snapshot_at
    for (let i = 0; i < inputs.length; i++) {
      if (!inputs[i].snapshot_at) {
        throw new Error(
          `snapshot_at is required for all snapshots; input[${i}] is missing snapshot_at`
        );
      }
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const snapshots: TokenBalanceSnapshot[] = [];
      for (const input of inputs) {
        const result = await client.query(
          `INSERT INTO token_balance_snapshots
            (offering_id, period_id, holder_address_or_id, balance, snapshot_at, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           RETURNING *`,
          [
            input.offering_id,
            input.period_id,
            input.holder_address_or_id,
            input.balance,
            input.snapshot_at,
          ]
        );
        snapshots.push(this.mapSnapshot(result.rows[0]));
      }
      await client.query('COMMIT');
      return snapshots;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get all snapshots for a given offering and period
   * @param offeringId Offering ID
   * @param periodId Period ID
   * @returns Array of snapshots
   */
  async findByOfferingAndPeriod(
    offeringId: string,
    periodId: string
  ): Promise<TokenBalanceSnapshot[]> {
    const query = `
      SELECT *
      FROM token_balance_snapshots
      WHERE offering_id = $1
        AND period_id = $2
      ORDER BY snapshot_at DESC, created_at DESC
    `;

    const result: QueryResult<TokenBalanceSnapshot> = await this.db.query(
      query,
      [offeringId, periodId]
    );

    return result.rows.map((row: any) => this.mapSnapshot(row));
  }

  /**
   * Get all snapshots for a given offering
   * @param offeringId Offering ID
   * @returns Array of snapshots
   */
  async findByOffering(offeringId: string): Promise<TokenBalanceSnapshot[]> {
    const query = `
      SELECT *
      FROM token_balance_snapshots
      WHERE offering_id = $1
      ORDER BY snapshot_at DESC, created_at DESC
    `;

    const result: QueryResult<TokenBalanceSnapshot> = await this.db.query(
      query,
      [offeringId]
    );

    return result.rows.map((row: any) => this.mapSnapshot(row));
  }

  /**
   * Map database row to TokenBalanceSnapshot entity
   */
  private mapSnapshot(row: any): TokenBalanceSnapshot {
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