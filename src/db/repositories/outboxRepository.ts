import { Pool, PoolClient, QueryResult } from 'pg';
import { randomUUID } from 'crypto';
import { WebhookEventType } from '../../services/webhookService';

export interface OutboxRow {
  id: string;
  event_id: string;
  event_type: WebhookEventType;
  payload: unknown;
  status: 'pending' | 'dispatched' | 'failed';
  attempts: number;
  available_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface InsertOutboxInput {
  event_type: WebhookEventType;
  payload: unknown;
  /** Stable idempotency key; defaults to a new UUID v4. */
  event_id?: string;
  /** When the dispatcher may first pick this row up; defaults to NOW(). */
  available_at?: Date;
}

/**
 * Repository for the webhook_outbox table.
 *
 * `insert` is designed to be called inside an existing DB transaction by
 * passing the transactional PoolClient.  This guarantees the outbox row is
 * written atomically with the domain change that produced the event.
 *
 * `drainPending` uses SELECT … FOR UPDATE SKIP LOCKED so concurrent
 * dispatcher instances never process the same row twice.
 */
export class OutboxRepository {
  constructor(private readonly db: Pool) {}

  /**
   * Insert an outbox row.
   *
   * @param input  Event data.
   * @param client Optional transactional client.  When supplied the INSERT
   *               participates in the caller's transaction; when omitted a
   *               pool connection is used (useful in tests / one-off scripts).
   */
  async insert(input: InsertOutboxInput, client?: PoolClient): Promise<OutboxRow> {
    const eventId = input.event_id ?? randomUUID();
    const availableAt = input.available_at ?? new Date();
    const executor = client ?? this.db;

    const result: QueryResult<OutboxRow> = await executor.query(
      `INSERT INTO webhook_outbox (event_id, event_type, payload, available_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [eventId, input.event_type, JSON.stringify(input.payload), availableAt]
    );
    return this.map(result.rows[0]);
  }

  /**
   * Claim up to `limit` pending rows that are ready to dispatch.
   * Uses SKIP LOCKED so concurrent workers never double-process a row.
   */
  async drainPending(limit = 50): Promise<OutboxRow[]> {
    const result: QueryResult<OutboxRow> = await this.db.query(
      `SELECT * FROM webhook_outbox
       WHERE status = 'pending' AND available_at <= NOW()
       ORDER BY available_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit]
    );
    return result.rows.map((r) => this.map(r));
  }

  /** Mark a row as successfully dispatched. */
  async markDispatched(id: string): Promise<void> {
    await this.db.query(
      `UPDATE webhook_outbox
       SET status = 'dispatched', attempts = attempts + 1
       WHERE id = $1`,
      [id]
    );
  }

  /**
   * Record a failed dispatch attempt.
   * If `retryAfter` is provided the row stays pending and becomes available
   * again at that time; otherwise it is marked failed.
   */
  async markFailed(id: string, retryAfter?: Date): Promise<void> {
    if (retryAfter) {
      await this.db.query(
        `UPDATE webhook_outbox
         SET attempts = attempts + 1, available_at = $2
         WHERE id = $1`,
        [id, retryAfter]
      );
    } else {
      await this.db.query(
        `UPDATE webhook_outbox
         SET status = 'failed', attempts = attempts + 1
         WHERE id = $1`,
        [id]
      );
    }
  }

  /**
   * Fetch the oldest pending outbox row (by created_at).
   * Used for measuring outbox lag without claiming the row.
   *
   * @returns The oldest pending row, or null if no pending records exist.
   */
  async getOldestPending(): Promise<OutboxRow | null> {
    const result: QueryResult<OutboxRow> = await this.db.query(
      `SELECT * FROM webhook_outbox
       WHERE status = 'pending' AND available_at <= NOW()
       ORDER BY created_at ASC
       LIMIT 1`
    );
    return result.rows.length > 0 ? this.map(result.rows[0]) : null;
  }

  private map(row: any): OutboxRow {
    return {
      id: row.id,
      event_id: row.event_id,
      event_type: row.event_type as WebhookEventType,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      status: row.status,
      attempts: row.attempts,
      available_at: new Date(row.available_at),
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}
