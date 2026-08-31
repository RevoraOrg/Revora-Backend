/**
 * ScheduledDistributionRepository — persistence for the deferred distribution
 * queue (`scheduled_distributions`).
 *
 * Rows are enqueued by an operator for a future settlement window. The
 * scheduler claims due rows atomically (scheduled -> processing) and marks them
 * completed / failed. Claims are idempotent: an already-claimed row is skipped,
 * and stale `processing` rows (a crashed scheduler) are reclaimed after a lease.
 *
 * @see ../../docs/deferred-distribution-scheduling.md
 */
import { Pool, QueryResult } from 'pg';
import { Errors } from '../../lib/errors';

export type ScheduledDistributionStatus =
  | 'scheduled'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ScheduledDistribution {
  id: string;
  offering_id: string;
  period_id: string;
  period_start?: Date | null;
  period_end?: Date | null;
  total_amount: string;
  run_at: Date;
  status: ScheduledDistributionStatus;
  attempts: number;
  error_message?: string | null;
  created_by?: string | null;
  executed_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateScheduledDistributionInput {
  offering_id: string;
  period_id: string;
  period_start?: Date;
  period_end?: Date;
  total_amount: string | number;
  run_at: Date;
  created_by?: string;
}

interface ScheduledDistributionRow {
  id: string;
  offering_id: string;
  period_id: string;
  period_start: Date | null;
  period_end: Date | null;
  total_amount: string;
  run_at: Date;
  status: ScheduledDistributionStatus;
  attempts: number;
  error_message: string | null;
  created_by: string | null;
  executed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: ScheduledDistributionRow): ScheduledDistribution {
  return {
    id: row.id,
    offering_id: row.offering_id,
    period_id: row.period_id,
    period_start: row.period_start,
    period_end: row.period_end,
    total_amount: row.total_amount,
    run_at: row.run_at,
    status: row.status,
    attempts: row.attempts,
    error_message: row.error_message,
    created_by: row.created_by,
    executed_at: row.executed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const SELECT_COLUMNS = `
  id, offering_id, period_id, period_start, period_end, total_amount,
  run_at, status, attempts, error_message, created_by, executed_at,
  created_at, updated_at
`;

export class ScheduledDistributionRepository {
  constructor(private db: Pool) {}

  /**
   * Enqueue a deferred distribution run. Throws 409 on duplicate
   * (offering_id, period_id) so operators get a structured conflict.
   */
  async create(
    input: CreateScheduledDistributionInput,
  ): Promise<ScheduledDistribution> {
    try {
      const result: QueryResult<ScheduledDistributionRow> = await this.db.query(
        `
        INSERT INTO scheduled_distributions
          (offering_id, period_id, period_start, period_end, total_amount, run_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING ${SELECT_COLUMNS}
        `,
        [
          input.offering_id,
          input.period_id,
          input.period_start ?? null,
          input.period_end ?? null,
          String(input.total_amount),
          input.run_at,
          input.created_by ?? null,
        ],
      );
      return mapRow(result.rows[0]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw Errors.conflict(
          'A scheduled distribution for this offering and period already exists',
        );
      }
      throw err;
    }
  }

  /**
   * Rows that are due now (run_at <= now) plus stale `processing` rows whose
   * lease expired (crashed scheduler mid-run). Ordered by run_at.
   */
  async findDueScheduledDistributions(
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<ScheduledDistribution[]> {
    const result: QueryResult<ScheduledDistributionRow> = await this.db.query(
      `
      SELECT ${SELECT_COLUMNS}
      FROM scheduled_distributions
      WHERE status = 'scheduled' AND run_at <= $1
         OR (status = 'processing' AND updated_at <= $1 - ($2::bigint * INTERVAL '1 millisecond'))
      ORDER BY run_at ASC
      LIMIT $3
      `,
      [now, leaseMs, limit],
    );
    return result.rows.map(mapRow);
  }

  /**
   * Atomically claim a row for processing. Only rows in `scheduled` status, or
   * stale `processing` rows whose lease expired, can be claimed; anything else
   * returns null (already being processed / completed / cancelled / failed).
   */
  async claimScheduledDistribution(
    id: string,
    leaseMs: number,
  ): Promise<ScheduledDistribution | null> {
    const result: QueryResult<ScheduledDistributionRow> = await this.db.query(
      `
      UPDATE scheduled_distributions
      SET status = 'processing',
          attempts = attempts + 1,
          updated_at = NOW()
      WHERE id = $1
        AND (
          status = 'scheduled'
          OR (status = 'processing' AND updated_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond'))
        )
      RETURNING ${SELECT_COLUMNS}
      `,
      [id, leaseMs],
    );
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
  }

  async markCompleted(id: string): Promise<ScheduledDistribution | null> {
    const result: QueryResult<ScheduledDistributionRow> = await this.db.query(
      `
      UPDATE scheduled_distributions
      SET status = 'completed',
          error_message = NULL,
          executed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${SELECT_COLUMNS}
      `,
      [id],
    );
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
  }

  async markFailed(
    id: string,
    errorMessage: string,
  ): Promise<ScheduledDistribution | null> {
    const result: QueryResult<ScheduledDistributionRow> = await this.db.query(
      `
      UPDATE scheduled_distributions
      SET status = 'failed',
          error_message = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${SELECT_COLUMNS}
      `,
      [id, errorMessage],
    );
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
  }

  /**
   * Cancel a pending run. Only rows still in `scheduled` status can be
   * cancelled; returns null for rows already processing/completed/failed.
   */
  async markCancelled(id: string): Promise<ScheduledDistribution | null> {
    const result: QueryResult<ScheduledDistributionRow> = await this.db.query(
      `
      UPDATE scheduled_distributions
      SET status = 'cancelled',
          updated_at = NOW()
      WHERE id = $1 AND status = 'scheduled'
      RETURNING ${SELECT_COLUMNS}
      `,
      [id],
    );
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
  }

  async findById(id: string): Promise<ScheduledDistribution | null> {
    const result: QueryResult<ScheduledDistributionRow> = await this.db.query(
      `
      SELECT ${SELECT_COLUMNS}
      FROM scheduled_distributions
      WHERE id = $1
      `,
      [id],
    );
    return result.rows.length > 0 ? mapRow(result.rows[0]) : null;
  }

  async findByOffering(offeringId: string): Promise<ScheduledDistribution[]> {
    const result: QueryResult<ScheduledDistributionRow> = await this.db.query(
      `
      SELECT ${SELECT_COLUMNS}
      FROM scheduled_distributions
      WHERE offering_id = $1
      ORDER BY run_at ASC
      `,
      [offeringId],
    );
    return result.rows.map(mapRow);
  }

  async findAll(limit: number, offset: number): Promise<ScheduledDistribution[]> {
    const result: QueryResult<ScheduledDistributionRow> = await this.db.query(
      `
      SELECT ${SELECT_COLUMNS}
      FROM scheduled_distributions
      ORDER BY run_at ASC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset],
    );
    return result.rows.map(mapRow);
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === '23505';
}
