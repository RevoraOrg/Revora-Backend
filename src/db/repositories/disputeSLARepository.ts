import { Pool, QueryResult } from 'pg';

/**
 * Dispute SLA record entity.
 */
export interface DisputeSLARecord {
  id: string;
  dispute_id: string;
  jurisdiction: string;
  state: string;
  sla_duration_hours: number;
  started_at: Date;
  paused_at: Date | null;
  total_paused_ms: number;
  escalated_at: Date | null;
  escalated: boolean;
  resolved_at: Date | null;
  assigned_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Input for creating a new dispute SLA record.
 */
export interface CreateDisputeSLAInput {
  dispute_id: string;
  jurisdiction: string;
  state: string;
  sla_duration_hours: number;
  assigned_user_id?: string | null;
}

/**
 * Input for updating a dispute SLA record.
 */
export interface UpdateDisputeSLAInput {
  state?: string;
  paused_at?: Date | null;
  total_paused_ms?: number;
  escalated?: boolean;
  escalated_at?: Date | null;
  resolved_at?: Date | null;
  assigned_user_id?: string | null;
}

/**
 * SLA burn report row.
 */
export interface SLABurnReportRow {
  dispute_id: string;
  jurisdiction: string;
  state: string;
  sla_duration_hours: number;
  elapsed_hours: number;
  remaining_hours: number;
  is_breached: boolean;
  escalated: boolean;
  paused: boolean;
  started_at: Date;
  resolved_at: Date | null;
  assigned_user_id: string | null;
}

/**
 * Repository for dispute SLA records.
 */
export class DisputeSLARepository {
  constructor(private db: Pool) {}

  /**
   * Create a new dispute SLA record.
   */
  async create(input: CreateDisputeSLAInput): Promise<DisputeSLARecord> {
    const query = `
      INSERT INTO dispute_slas (
        dispute_id, jurisdiction, state, sla_duration_hours,
        assigned_user_id, started_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), NOW())
      RETURNING *
    `;

    const values = [
      input.dispute_id,
      input.jurisdiction,
      input.state,
      input.sla_duration_hours,
      input.assigned_user_id ?? null,
    ];

    const result: QueryResult<DisputeSLARecord> = await this.db.query(query, values);

    if (result.rows.length === 0) {
      throw new Error('Failed to create dispute SLA record');
    }

    return this.mapRecord(result.rows[0]);
  }

  /**
   * Find the active SLA record for a dispute.
   * An active record is one that has not been resolved or closed.
   */
  async findActiveByDisputeId(disputeId: string): Promise<DisputeSLARecord | null> {
    const query = `
      SELECT * FROM dispute_slas
      WHERE dispute_id = $1
        AND resolved_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const result: QueryResult<DisputeSLARecord> = await this.db.query(query, [disputeId]);

    return result.rows.length > 0 ? this.mapRecord(result.rows[0]) : null;
  }

  /**
   * Find all SLA records for a dispute, ordered by creation time.
   */
  async findByDisputeId(disputeId: string): Promise<DisputeSLARecord[]> {
    const query = `
      SELECT * FROM dispute_slas
      WHERE dispute_id = $1
      ORDER BY created_at DESC
    `;

    const result: QueryResult<DisputeSLARecord> = await this.db.query(query, [disputeId]);

    return result.rows.map((row) => this.mapRecord(row));
  }

  /**
   * Update an SLA record by ID.
   */
  async update(id: string, input: UpdateDisputeSLAInput): Promise<DisputeSLARecord> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.state !== undefined) {
      setClauses.push(`state = $${paramIndex++}`);
      values.push(input.state);
    }

    if (input.paused_at !== undefined) {
      setClauses.push(`paused_at = $${paramIndex++}`);
      values.push(input.paused_at);
    }

    if (input.total_paused_ms !== undefined) {
      setClauses.push(`total_paused_ms = $${paramIndex++}`);
      values.push(input.total_paused_ms);
    }

    if (input.escalated !== undefined) {
      setClauses.push(`escalated = $${paramIndex++}`);
      values.push(input.escalated);
    }

    if (input.escalated_at !== undefined) {
      setClauses.push(`escalated_at = $${paramIndex++}`);
      values.push(input.escalated_at);
    }

    if (input.resolved_at !== undefined) {
      setClauses.push(`resolved_at = $${paramIndex++}`);
      values.push(input.resolved_at);
    }

    if (input.assigned_user_id !== undefined) {
      setClauses.push(`assigned_user_id = $${paramIndex++}`);
      values.push(input.assigned_user_id);
    }

    if (setClauses.length === 0) {
      throw new Error('No fields to update');
    }

    values.push(id);

    const query = `
      UPDATE dispute_slas
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result: QueryResult<DisputeSLARecord> = await this.db.query(query, values);

    if (result.rows.length === 0) {
      throw new Error(`Dispute SLA record not found: ${id}`);
    }

    return this.mapRecord(result.rows[0]);
  }

  /**
   * Get SLA burn report for a date range.
   * Returns all SLA records that are active or were active within the range.
   */
  async getSLABurnReport(
    startDate: Date,
    endDate: Date,
    jurisdiction?: string,
  ): Promise<SLABurnReportRow[]> {
    const conditions: string[] = [
      `ds.created_at <= $2`,
      `(ds.resolved_at IS NULL OR ds.resolved_at >= $1)`,
    ];
    const values: unknown[] = [startDate, endDate];

    let paramIndex = 3;
    if (jurisdiction) {
      conditions.push(`ds.jurisdiction = $${paramIndex++}`);
      values.push(jurisdiction);
    }

    const query = `
      SELECT
        ds.id,
        ds.dispute_id,
        ds.jurisdiction,
        ds.state,
        ds.sla_duration_hours,
        ds.started_at,
        ds.paused_at,
        ds.total_paused_ms,
        ds.escalated,
        ds.resolved_at,
        ds.assigned_user_id,
        EXTRACT(EPOCH FROM (
          COALESCE(ds.resolved_at, NOW()) - ds.started_at
        )) * 1000 AS elapsed_ms
      FROM dispute_slas ds
      WHERE ${conditions.join(' AND ')}
      ORDER BY ds.jurisdiction, ds.started_at DESC
    `;

    const result = await this.db.query(query, values);

    return result.rows.map((row: any) => {
      const elapsedMs = Number(row.elapsed_ms) - Number(row.total_paused_ms);
      const elapsedHours = Math.max(0, elapsedMs / (1000 * 60 * 60));
      const slaDurationHours = Number(row.sla_duration_hours);

      return {
        dispute_id: row.dispute_id,
        jurisdiction: row.jurisdiction,
        state: row.state,
        sla_duration_hours: slaDurationHours,
        elapsed_hours: Math.round(elapsedHours * 100) / 100,
        remaining_hours: Math.round(Math.max(0, slaDurationHours - elapsedHours) * 100) / 100,
        is_breached: elapsedHours > slaDurationHours,
        escalated: row.escalated,
        paused: row.paused_at !== null,
        started_at: row.started_at,
        resolved_at: row.resolved_at,
        assigned_user_id: row.assigned_user_id,
      };
    });
  }

  /**
   * Find all SLA records that are overdue (elapsed time > SLA duration)
   * and have not been escalated yet.
   */
  async findOverdueNonEscalated(): Promise<DisputeSLARecord[]> {
    const query = `
      SELECT * FROM dispute_slas
      WHERE escalated = FALSE
        AND resolved_at IS NULL
        AND (
          EXTRACT(EPOCH FROM (
            CASE WHEN paused_at IS NOT NULL
              THEN paused_at - started_at
              ELSE NOW() - started_at
            END
          )) * 1000
        ) - total_paused_ms > sla_duration_hours * 3600 * 1000
    `;

    const result: QueryResult<DisputeSLARecord> = await this.db.query(query);

    return result.rows.map((row) => this.mapRecord(row));
  }

  private mapRecord(row: any): DisputeSLARecord {
    return {
      id: row.id,
      dispute_id: row.dispute_id,
      jurisdiction: row.jurisdiction,
      state: row.state,
      sla_duration_hours: row.sla_duration_hours,
      started_at: row.started_at,
      paused_at: row.paused_at,
      total_paused_ms: row.total_paused_ms,
      escalated_at: row.escalated_at,
      escalated: row.escalated,
      resolved_at: row.resolved_at,
      assigned_user_id: row.assigned_user_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
