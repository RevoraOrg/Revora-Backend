import { Pool, PoolClient, QueryResult } from 'pg';

/**
 * Type representing any queryable database object (Pool or PoolClient)
 * Both have the same query interface for transactional support
 */
type Queryable = Pool | PoolClient;

/**
 * Ledger period lock entity (matches 'ledger_period_locks' table)
 * Represents a dual-control authorized lock on a specific period for an offering.
 */
export interface LedgerPeriodLock {
  id: string;
  period_id: string;
  offering_id: string;
  status: 'pending_initiation' | 'initiated' | 'locked';
  initiated_by: string;
  initiated_at: Date;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  locked_at: Date | null;
  export_format: string;
  export_reference: string | null;
  export_hash: string | null;
  export_signature: string | null;
  signing_algorithm: string;
  signing_key_version: number;
  entry_count: number | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Input for creating a new ledger period lock (initiation stage)
 */
export interface CreateLedgerPeriodLockInput {
  period_id: string;
  offering_id: string;
  initiated_by: string;
  export_format?: string;
}

/**
 * Input for confirming an initiated lock
 */
export interface ConfirmLedgerPeriodLockInput {
  export_reference: string;
  export_hash: string;
  export_signature: string;
  signing_algorithm: string;
  signing_key_version: number;
  entry_count: number;
  confirmed_by: string;
}

/**
 * Ledger Period Lock Repository
 * Handles database operations for ledger period locks with dual-control support.
 * Enforces:
 * - Different actors for initiation and confirmation
 * - Atomic transaction boundaries for export materialization
 * - Unique period locks per offering
 */
export class LedgerPeriodLockRepository {
  constructor(private db: Pool) {}

  /**
   * Initiate a period close request (first step of dual-control).
   * Creates a lock in 'initiated' status awaiting confirmation by different actor.
   *
   * @param input Close initiation data
   * @param client Optional transaction client; if provided, query executes within that transaction
   * @returns Created period lock with 'initiated' status
   * @throws Error if period is already locked for this offering
   */
  async initiatePeriodClose(
    input: CreateLedgerPeriodLockInput,
    client?: Queryable
  ): Promise<LedgerPeriodLock> {
    const queryable = client ?? this.db;
    const exportFormat = input.export_format || 'jsonl';

    const query = `
      INSERT INTO ledger_period_locks (
        period_id,
        offering_id,
        initiated_by,
        export_format,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'initiated', NOW(), NOW())
      RETURNING *
    `;

    const values = [
      input.period_id,
      input.offering_id,
      input.initiated_by,
      exportFormat,
    ];

    try {
      const result: QueryResult<any> = await queryable.query(query, values);
      if (result.rows.length === 0) {
        throw new Error('Failed to initiate period close');
      }
      return this.mapLock(result.rows[0]);
    } catch (error: any) {
      // Check for unique constraint violation (already locked)
      if (error.code === '23505') {
        throw new Error(
          `Period ${input.period_id} for offering ${input.offering_id} is already locked or has a pending close`
        );
      }
      throw error;
    }
  }

  /**
   * Get an initiated lock by offering and period ID.
   * Used to retrieve the lock before confirmation.
   *
   * @param offeringId The offering ID
   * @param periodId The period ID
   * @param client Optional transaction client
   * @returns The lock if found and in 'initiated' status, null otherwise
   */
  async getInitiatedLock(
    offeringId: string,
    periodId: string,
    client?: Queryable
  ): Promise<LedgerPeriodLock | null> {
    const queryable = client ?? this.db;

    const query = `
      SELECT *
      FROM ledger_period_locks
      WHERE offering_id = $1
        AND period_id = $2
        AND status = 'initiated'
      LIMIT 1
    `;

    const result: QueryResult<any> = await queryable.query(query, [
      offeringId,
      periodId,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapLock(result.rows[0]);
  }

  /**
   * Get an existing lock by offering and period ID (any status).
   * Used to check current lock state.
   *
   * @param offeringId The offering ID
   * @param periodId The period ID
   * @param client Optional transaction client
   * @returns The lock if found, null otherwise
   */
  async getLock(
    offeringId: string,
    periodId: string,
    client?: Queryable
  ): Promise<LedgerPeriodLock | null> {
    const queryable = client ?? this.db;

    const query = `
      SELECT *
      FROM ledger_period_locks
      WHERE offering_id = $1
        AND period_id = $2
      LIMIT 1
    `;

    const result: QueryResult<any> = await queryable.query(query, [
      offeringId,
      periodId,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapLock(result.rows[0]);
  }

  /**
   * Confirm an initiated close (second step of dual-control).
   * Atomically transitions lock to 'locked' status and stores export/hash/signature.
   * Enforces that confirmed_by is different from initiated_by (dual-control).
   *
   * @param lockId The lock ID to confirm
   * @param input Confirmation data (export details, different actor)
   * @param client Optional transaction client
   * @returns Updated lock with 'locked' status
   * @throws Error if lock not found, wrong status, or same actor attempts to confirm
   */
  async confirmPeriodClose(
    lockId: string,
    input: ConfirmLedgerPeriodLockInput,
    client?: Queryable
  ): Promise<LedgerPeriodLock> {
    const queryable = client ?? this.db;

    // First, get the lock to check initiated_by
    const getLockQuery = `
      SELECT * FROM ledger_period_locks WHERE id = $1 FOR UPDATE
    `;

    const getLockResult: QueryResult<any> = await queryable.query(
      getLockQuery,
      [lockId]
    );

    if (getLockResult.rows.length === 0) {
      throw new Error(`Lock ${lockId} not found`);
    }

    const lock = this.mapLock(getLockResult.rows[0]);

    // Enforce different actors (dual-control)
    if (lock.initiated_by === input.confirmed_by) {
      throw new Error(
        'Dual-control violation: Lock cannot be confirmed by the same actor who initiated it'
      );
    }

    // Enforce correct status
    if (lock.status !== 'initiated') {
      throw new Error(
        `Cannot confirm lock in '${lock.status}' status. Only 'initiated' locks can be confirmed.`
      );
    }

    // Atomically update lock to confirmed/locked state
    const updateQuery = `
      UPDATE ledger_period_locks
      SET status = 'locked',
          confirmed_by = $2,
          confirmed_at = NOW(),
          locked_at = NOW(),
          export_reference = $3,
          export_hash = $4,
          export_signature = $5,
          signing_algorithm = $6,
          signing_key_version = $7,
          entry_count = $8,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;

    const updateValues = [
      lockId,
      input.confirmed_by,
      input.export_reference,
      input.export_hash,
      input.export_signature,
      input.signing_algorithm,
      input.signing_key_version,
      input.entry_count,
    ];

    const result: QueryResult<any> = await queryable.query(
      updateQuery,
      updateValues
    );

    if (result.rows.length === 0) {
      throw new Error('Failed to confirm period close');
    }

    return this.mapLock(result.rows[0]);
  }

  /**
   * Check if a period is locked for an offering (read-only check).
   * Used during journal entry writes to reject writes to locked periods.
   *
   * @param offeringId The offering ID
   * @param periodId The period ID
   * @param client Optional transaction client
   * @returns true if period is locked, false otherwise
   */
  async isPeriodLocked(
    offeringId: string,
    periodId: string,
    client?: Queryable
  ): Promise<boolean> {
    const queryable = client ?? this.db;

    const query = `
      SELECT 1
      FROM ledger_period_locks
      WHERE offering_id = $1
        AND period_id = $2
        AND status = 'locked'
      LIMIT 1
    `;

    const result: QueryResult<any> = await queryable.query(query, [
      offeringId,
      periodId,
    ]);

    return result.rows.length > 0;
  }

  /**
   * Get a locked period's export hash and signature for verification.
   * Used by clients to independently verify the export integrity.
   *
   * @param offeringId The offering ID
   * @param periodId The period ID
   * @returns Object with hash, signature, and signing info, or null if not locked
   */
  async getLockedExportMetadata(
    offeringId: string,
    periodId: string
  ): Promise<{
    export_hash: string;
    export_signature: string;
    signing_algorithm: string;
    signing_key_version: number;
    locked_at: Date;
    entry_count: number | null;
  } | null> {
    const query = `
      SELECT export_hash, export_signature, signing_algorithm, signing_key_version, locked_at, entry_count
      FROM ledger_period_locks
      WHERE offering_id = $1
        AND period_id = $2
        AND status = 'locked'
      LIMIT 1
    `;

    const result: QueryResult<any> = await this.db.query(query, [
      offeringId,
      periodId,
    ]);

    if (result.rows.length === 0) {
      return null;
    }

    return {
      export_hash: result.rows[0].export_hash,
      export_signature: result.rows[0].export_signature,
      signing_algorithm: result.rows[0].signing_algorithm,
      signing_key_version: result.rows[0].signing_key_version,
      locked_at: result.rows[0].locked_at,
      entry_count: result.rows[0].entry_count,
    };
  }

  /**
   * List all locked periods for an offering (for audit/reporting).
   *
   * @param offeringId The offering ID
   * @returns Array of locked period locks
   */
  async listLockedPeriods(offeringId: string): Promise<LedgerPeriodLock[]> {
    const query = `
      SELECT *
      FROM ledger_period_locks
      WHERE offering_id = $1
        AND status = 'locked'
      ORDER BY locked_at DESC
    `;

    const result: QueryResult<any> = await this.db.query(query, [offeringId]);
    return result.rows.map((row) => this.mapLock(row));
  }

  /**
   * Map database row to LedgerPeriodLock entity.
   */
  private mapLock(row: any): LedgerPeriodLock {
    return {
      id: row.id,
      period_id: row.period_id,
      offering_id: row.offering_id,
      status: row.status,
      initiated_by: row.initiated_by,
      initiated_at: row.initiated_at,
      confirmed_by: row.confirmed_by,
      confirmed_at: row.confirmed_at,
      locked_at: row.locked_at,
      export_format: row.export_format,
      export_reference: row.export_reference,
      export_hash: row.export_hash,
      export_signature: row.export_signature,
      signing_algorithm: row.signing_algorithm,
      signing_key_version: row.signing_key_version,
      entry_count: row.entry_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
