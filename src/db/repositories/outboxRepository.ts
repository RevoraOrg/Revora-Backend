/**
 * OutboxRepository — persistence for webhook_outbox.
 *
 * @see ../../docs/architecture/distribution-reconciliation.md
 *      Architecture map (see §5 — Database tables and ownership).
 * @see ../docs/transactional-outbox.md
 */
import { Pool, PoolClient, QueryResult } from 'pg';
import { randomUUID } from 'crypto';
import { WebhookEventType } from '../../services/webhookService';

export interface OutboxRow {
  id: string;
  event_id: string;
  event_type: WebhookEventType;
  payload: unknown;
  status: 'pending' | 'dispatching' | 'dispatched' | 'failed';
  locked_until: Date | null;
  lease_token: string | null;
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
 * `drainPending` atomically persists a lease while holding SKIP LOCKED row
 * locks. Only one worker owns an unexpired lease; expired claims may be retried
 * with the same event_id. Delivery is still at least once.
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
   * Claim ready pending rows or recover expired leases in one autocommit
   * statement. The token fences completions from superseded workers.
   * The lease must cover delivery of the entire claimed batch.
   */
  async drainPending(limit = 50, leaseMs = 60_000): Promise<OutboxRow[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('limit must be a non-negative safe integer');
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new RangeError('leaseMs must be a positive safe integer');
    const result: QueryResult<OutboxRow> = await this.db.query(
      `UPDATE webhook_outbox
       SET status = 'dispatching',
           locked_until = NOW() + ($2::double precision * INTERVAL '1 millisecond'),
           lease_token = $3::uuid
       WHERE id IN (
         SELECT id FROM webhook_outbox
         WHERE (status = 'pending' AND available_at <= NOW())
            OR (status = 'dispatching' AND locked_until <= NOW())
         ORDER BY available_at ASC, id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [limit, leaseMs, randomUUID()]
    );
    return result.rows.map((r) => this.map(r));
  }

  /** Complete only the matching, unexpired claim; stale workers are a no-op. */
  async markDispatched(id: string, leaseToken: string | null): Promise<void> {
    await this.db.query(
      `UPDATE webhook_outbox
       SET status = 'dispatched', attempts = attempts + 1,
           locked_until = NULL, lease_token = NULL
       WHERE id = $1 AND status = 'dispatching'
         AND lease_token = $2::uuid AND locked_until > NOW()`,
      [id, leaseToken]
    );
  }

  /**
   * Record a failed dispatch attempt.
   * If `retryAfter` is provided the row returns to pending and becomes available
   * again at that time; otherwise it is marked failed.
   */
  async markFailed(id: string, leaseToken: string | null, retryAfter?: Date): Promise<void> {
    if (retryAfter) {
      await this.db.query(
        `UPDATE webhook_outbox
         SET status = 'pending', attempts = attempts + 1, available_at = $3,
             locked_until = NULL, lease_token = NULL
         WHERE id = $1 AND status = 'dispatching'
           AND lease_token = $2::uuid AND locked_until > NOW()`,
        [id, leaseToken, retryAfter]
      );
    } else {
      await this.db.query(
        `UPDATE webhook_outbox
         SET status = 'failed', attempts = attempts + 1,
             locked_until = NULL, lease_token = NULL
         WHERE id = $1 AND status = 'dispatching'
           AND lease_token = $2::uuid AND locked_until > NOW()`,
        [id, leaseToken]
      );
    }
  }

  /**
   * Fetch the oldest ready or expired outbox row (by created_at).
   * Active leases and scheduled retries do not contribute to pending lag.
   * Used for measuring outbox lag without claiming the row.
   *
   * @returns The oldest pending row, or null if no pending records exist.
   */
  async getOldestPending(): Promise<OutboxRow | null> {
    const result: QueryResult<OutboxRow> = await this.db.query(
      `SELECT * FROM webhook_outbox
       WHERE (status = 'pending' AND available_at <= NOW())
          OR (status = 'dispatching' AND locked_until <= NOW())
       ORDER BY created_at ASC
       LIMIT 1`
    );
    return result.rows.length > 0 ? this.map(result.rows[0]) : null;
  }

  private map(row: OutboxRow): OutboxRow {
    return {
      id: row.id,
      event_id: row.event_id,
      event_type: row.event_type as WebhookEventType,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
      status: row.status,
      locked_until: row.locked_until == null ? null : new Date(row.locked_until),
      lease_token: row.lease_token ?? null,
      attempts: row.attempts,
      available_at: new Date(row.available_at),
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
    };
  }
}
