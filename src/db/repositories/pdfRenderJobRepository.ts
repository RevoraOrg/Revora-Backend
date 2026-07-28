import { createHash, randomUUID } from 'crypto';
import { Pool, PoolClient, QueryResult } from 'pg';

export type PdfRenderJobStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type PdfRenderBatchStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PdfRenderBatchRow {
  id: string;
  period_id: string;
  total_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  status: PdfRenderBatchStatus;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface PdfRenderJobRow {
  id: string;
  batch_id: string;
  investor_id: string;
  period_id: string;
  status: PdfRenderJobStatus;
  attempts: number;
  available_at: Date;
  claimed_at: Date | null;
  storage_key: string | null;
  checksum: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Deterministic storage key — resume/re-render overwrites the same object. */
export function buildStatementStorageKey(periodId: string, investorId: string): string {
  return `statements/${periodId}/${investorId}.pdf`;
}

export function checksumPayload(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Repository for pdf_render_batches / pdf_render_jobs.
 *
 * Checkpoints live in Postgres (job status + storage_key + checksum), never in
 * process memory — a crashed worker leaves rows claimable again after the
 * stale window, and completed jobs are never re-enqueued.
 */
export class PdfRenderJobRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Create a batch and enqueue one job per investor.
   * Re-enqueue within the same batch is a no-op via UNIQUE + ON CONFLICT DO NOTHING.
   */
  async enqueueBatch(
    periodId: string,
    investorIds: string[],
    client?: PoolClient,
  ): Promise<{ batch: PdfRenderBatchRow; inserted: number }> {
    const executor = client ?? this.db;
    const uniqueInvestors = [...new Set(investorIds.filter(Boolean))];
    const batchId = randomUUID();

    const batchResult: QueryResult<PdfRenderBatchRow> = await executor.query(
      `INSERT INTO pdf_render_batches (id, period_id, total_jobs, status, started_at)
       VALUES ($1, $2, $3, 'running', NOW())
       RETURNING *`,
      [batchId, periodId, uniqueInvestors.length],
    );
    const batch = this.mapBatch(batchResult.rows[0]);

    let inserted = 0;
    for (const investorId of uniqueInvestors) {
      const result = await executor.query(
        `INSERT INTO pdf_render_jobs (batch_id, investor_id, period_id, storage_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (batch_id, investor_id, period_id) DO NOTHING
         RETURNING id`,
        [batchId, investorId, periodId, buildStatementStorageKey(periodId, investorId)],
      );
      if ((result.rowCount ?? 0) > 0) inserted += 1;
    }

    if (inserted !== uniqueInvestors.length) {
      await executor.query(
        `UPDATE pdf_render_batches SET total_jobs = $2 WHERE id = $1`,
        [batchId, inserted],
      );
      batch.total_jobs = inserted;
    }

    return { batch, inserted };
  }

  /**
   * Claim up to `limit` jobs:
   *  - pending and available, OR
   *  - processing with claimed_at older than `staleAfterMs` (crash reclaim)
   *
   * Uses SKIP LOCKED so concurrent workers never double-claim.
   * Releases the row lock before rendering (status flipped to processing).
   */
  async claimJobs(limit: number, staleAfterMs: number): Promise<PdfRenderJobRow[]> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const staleInterval = `${Math.max(1, Math.floor(staleAfterMs / 1000))} seconds`;
      const result: QueryResult<PdfRenderJobRow> = await client.query(
        `SELECT * FROM pdf_render_jobs
         WHERE (
           (status = 'pending' AND available_at <= NOW())
           OR (
             status = 'processing'
             AND claimed_at IS NOT NULL
             AND claimed_at < NOW() - ($2::text)::interval
           )
         )
         ORDER BY available_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [limit, staleInterval],
      );

      const claimed: PdfRenderJobRow[] = [];
      for (const row of result.rows) {
        const updated: QueryResult<PdfRenderJobRow> = await client.query(
          `UPDATE pdf_render_jobs
           SET status = 'processing', claimed_at = NOW(), attempts = attempts + 1
           WHERE id = $1
           RETURNING *`,
          [row.id],
        );
        if (updated.rows[0]) claimed.push(this.mapJob(updated.rows[0]));
      }

      await client.query('COMMIT');
      return claimed;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Persist successful render checkpoint (storage_key + checksum). */
  async markCompleted(id: string, storageKey: string, checksum: string): Promise<void> {
    await this.db.query(
      `UPDATE pdf_render_jobs
       SET status = 'completed',
           storage_key = $2,
           checksum = $3,
           error = NULL,
           claimed_at = NULL
       WHERE id = $1`,
      [id, storageKey, checksum],
    );
    await this.db.query(
      `UPDATE pdf_render_batches b
       SET completed_jobs = completed_jobs + 1,
           status = CASE
             WHEN completed_jobs + 1 + failed_jobs >= total_jobs THEN 'completed'
             ELSE 'running'
           END,
           completed_at = CASE
             WHEN completed_jobs + 1 + failed_jobs >= total_jobs THEN NOW()
             ELSE completed_at
           END
       WHERE b.id = (SELECT batch_id FROM pdf_render_jobs WHERE id = $1)`,
      [id],
    );
  }

  /**
   * Record failure. With `retryAfter`, row returns to pending (resumable).
   * Without it, row is dead-lettered as failed.
   */
  async markFailed(id: string, error: string, retryAfter?: Date): Promise<void> {
    if (retryAfter) {
      await this.db.query(
        `UPDATE pdf_render_jobs
         SET status = 'pending',
             available_at = $2,
             error = $3,
             claimed_at = NULL
         WHERE id = $1`,
        [id, retryAfter, error],
      );
      return;
    }

    await this.db.query(
      `UPDATE pdf_render_jobs
       SET status = 'failed',
           error = $2,
           claimed_at = NULL
       WHERE id = $1`,
      [id, error],
    );
    await this.db.query(
      `UPDATE pdf_render_batches b
       SET failed_jobs = failed_jobs + 1,
           status = CASE
             WHEN completed_jobs + failed_jobs + 1 >= total_jobs THEN 'completed'
             ELSE 'running'
           END,
           completed_at = CASE
             WHEN completed_jobs + failed_jobs + 1 >= total_jobs THEN NOW()
             ELSE completed_at
           END
       WHERE b.id = (SELECT batch_id FROM pdf_render_jobs WHERE id = $1)`,
      [id],
    );
  }

  async getBatch(batchId: string): Promise<PdfRenderBatchRow | null> {
    const result: QueryResult<PdfRenderBatchRow> = await this.db.query(
      `SELECT * FROM pdf_render_batches WHERE id = $1`,
      [batchId],
    );
    return result.rows[0] ? this.mapBatch(result.rows[0]) : null;
  }

  async countPending(batchId?: string): Promise<number> {
    const result = batchId
      ? await this.db.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pdf_render_jobs
           WHERE batch_id = $1 AND status IN ('pending', 'processing')`,
          [batchId],
        )
      : await this.db.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM pdf_render_jobs
           WHERE status IN ('pending', 'processing')`,
        );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  private mapBatch(row: any): PdfRenderBatchRow {
    return {
      id: row.id,
      period_id: row.period_id,
      total_jobs: Number(row.total_jobs),
      completed_jobs: Number(row.completed_jobs),
      failed_jobs: Number(row.failed_jobs),
      status: row.status,
      started_at: row.started_at ? new Date(row.started_at) : null,
      completed_at: row.completed_at ? new Date(row.completed_at) : null,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }

  private mapJob(row: any): PdfRenderJobRow {
    return {
      id: row.id,
      batch_id: row.batch_id,
      investor_id: row.investor_id,
      period_id: row.period_id,
      status: row.status,
      attempts: Number(row.attempts),
      available_at: new Date(row.available_at),
      claimed_at: row.claimed_at ? new Date(row.claimed_at) : null,
      storage_key: row.storage_key ?? null,
      checksum: row.checksum ?? null,
      error: row.error ?? null,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}
