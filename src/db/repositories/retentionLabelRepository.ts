import { Pool, QueryResult } from 'pg';

export type RetentionPendingAction = 'add' | 'remove';

/**
 * Per-period retention label row used for ledger-export legal holds.
 */
export interface RetentionLabel {
  period_id: string;
  legal_hold: boolean;
  reason: string | null;
  pending_action: RetentionPendingAction | null;
  pending_proposed_by: string | null;
  pending_proposed_at: Date | null;
  activated_by: string | null;
  activated_at: Date | null;
  released_by: string | null;
  released_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export class RetentionLabelRepository {
  constructor(private readonly db: Pool) {}

  async findByPeriodId(periodId: string): Promise<RetentionLabel | null> {
    const result: QueryResult = await this.db.query(
      `SELECT * FROM retention_labels WHERE period_id = $1`,
      [periodId],
    );
    if (result.rows.length === 0) {
      return null;
    }
    return this.mapRow(result.rows[0]);
  }

  async listActiveHolds(): Promise<RetentionLabel[]> {
    const result: QueryResult = await this.db.query(
      `SELECT * FROM retention_labels
       WHERE legal_hold = TRUE
       ORDER BY period_id ASC`,
    );
    return result.rows.map((row) => this.mapRow(row));
  }

  async upsertProposeAdd(input: {
    periodId: string;
    actorId: string;
    reason?: string | null;
  }): Promise<RetentionLabel> {
    const result: QueryResult = await this.db.query(
      `INSERT INTO retention_labels (
         period_id, legal_hold, reason, pending_action, pending_proposed_by, pending_proposed_at
       ) VALUES ($1, FALSE, $2, 'add', $3, NOW())
       ON CONFLICT (period_id) DO UPDATE SET
         reason = COALESCE(EXCLUDED.reason, retention_labels.reason),
         pending_action = 'add',
         pending_proposed_by = EXCLUDED.pending_proposed_by,
         pending_proposed_at = NOW(),
         updated_at = NOW()
       RETURNING *`,
      [input.periodId, input.reason ?? null, input.actorId],
    );
    return this.mapRow(result.rows[0]);
  }

  async approveAdd(input: {
    periodId: string;
    actorId: string;
  }): Promise<RetentionLabel> {
    const result: QueryResult = await this.db.query(
      `UPDATE retention_labels
       SET legal_hold = TRUE,
           pending_action = NULL,
           pending_proposed_by = NULL,
           pending_proposed_at = NULL,
           activated_by = $2,
           activated_at = NOW(),
           updated_at = NOW()
       WHERE period_id = $1
       RETURNING *`,
      [input.periodId, input.actorId],
    );
    if (result.rows.length === 0) {
      throw new Error(`Retention label not found for period ${input.periodId}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async proposeRemove(input: {
    periodId: string;
    actorId: string;
  }): Promise<RetentionLabel> {
    const result: QueryResult = await this.db.query(
      `UPDATE retention_labels
       SET pending_action = 'remove',
           pending_proposed_by = $2,
           pending_proposed_at = NOW(),
           updated_at = NOW()
       WHERE period_id = $1
       RETURNING *`,
      [input.periodId, input.actorId],
    );
    if (result.rows.length === 0) {
      throw new Error(`Retention label not found for period ${input.periodId}`);
    }
    return this.mapRow(result.rows[0]);
  }

  async approveRemove(input: {
    periodId: string;
    actorId: string;
  }): Promise<RetentionLabel> {
    const result: QueryResult = await this.db.query(
      `UPDATE retention_labels
       SET legal_hold = FALSE,
           pending_action = NULL,
           pending_proposed_by = NULL,
           pending_proposed_at = NULL,
           released_by = $2,
           released_at = NOW(),
           updated_at = NOW()
       WHERE period_id = $1
       RETURNING *`,
      [input.periodId, input.actorId],
    );
    if (result.rows.length === 0) {
      throw new Error(`Retention label not found for period ${input.periodId}`);
    }
    return this.mapRow(result.rows[0]);
  }

  private mapRow(row: Record<string, unknown>): RetentionLabel {
    return {
      period_id: String(row.period_id),
      legal_hold: Boolean(row.legal_hold),
      reason: (row.reason as string | null) ?? null,
      pending_action: (row.pending_action as RetentionPendingAction | null) ?? null,
      pending_proposed_by: (row.pending_proposed_by as string | null) ?? null,
      pending_proposed_at: row.pending_proposed_at
        ? new Date(row.pending_proposed_at as string | Date)
        : null,
      activated_by: (row.activated_by as string | null) ?? null,
      activated_at: row.activated_at ? new Date(row.activated_at as string | Date) : null,
      released_by: (row.released_by as string | null) ?? null,
      released_at: row.released_at ? new Date(row.released_at as string | Date) : null,
      created_at: new Date(row.created_at as string | Date),
      updated_at: new Date(row.updated_at as string | Date),
    };
  }
}
