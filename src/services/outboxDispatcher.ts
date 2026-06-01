import { OutboxRepository, OutboxRow } from '../db/repositories/outboxRepository';
import { WebhookEventType } from './webhookService';

/**
 * Callback type that the dispatcher uses to hand a row to the delivery layer.
 * Implementations should call WebhookQueue.processDelivery (or equivalent).
 * Returns true on successful dispatch, false on transient failure.
 */
export type DispatchFn = (row: OutboxRow) => Promise<boolean>;

export interface OutboxDispatcherOptions {
  /** How many rows to claim per poll cycle. Default: 50. */
  batchSize?: number;
  /** Milliseconds between poll cycles. Default: 5000. */
  intervalMs?: number;
  /** Max retry attempts before a row is marked failed. Default: 5. */
  maxAttempts?: number;
  /** Base delay (ms) for exponential retry back-off. Default: 1000. */
  retryBaseMs?: number;
}

/**
 * OutboxDispatcher polls webhook_outbox for pending rows and hands each one
 * to the provided `dispatch` function (typically WebhookQueue.processDelivery).
 *
 * Guarantees:
 * - A row is only claimed by one worker at a time (SKIP LOCKED in OutboxRepository).
 * - A crash mid-dispatch leaves the row pending; the next poll retries it with
 *   the same event_id, so the receiver can deduplicate via webhookEventOrdering.
 * - After maxAttempts failures the row is marked 'failed' (dead-letter).
 */
export class OutboxDispatcher {
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly outboxRepo: OutboxRepository,
    private readonly dispatch: DispatchFn,
    options: OutboxDispatcherOptions = {}
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.intervalMs = options.intervalMs ?? 5000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
  }

  /** Start the polling loop. Safe to call multiple times (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /** Stop the polling loop. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single drain cycle. Exposed for testing and one-shot use.
   * Returns the number of rows processed.
   */
  async drainOnce(): Promise<number> {
    const rows = await this.outboxRepo.drainPending(this.batchSize);
    for (const row of rows) {
      await this.processRow(row);
    }
    return rows.length;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.drainOnce();
      } catch {
        // swallow – individual row errors are handled in processRow
      }
      this.scheduleNext();
    }, this.intervalMs);
    // Allow the process to exit even if the timer is pending
    if (this.timer.unref) this.timer.unref();
  }

  private async processRow(row: OutboxRow): Promise<void> {
    let success = false;
    try {
      success = await this.dispatch(row);
    } catch {
      success = false;
    }

    if (success) {
      await this.outboxRepo.markDispatched(row.id);
      return;
    }

    const nextAttempts = row.attempts + 1;
    if (nextAttempts >= this.maxAttempts) {
      // Exhausted retries – mark failed (dead-letter)
      await this.outboxRepo.markFailed(row.id);
    } else {
      // Exponential back-off: retryBaseMs * 2^attempt
      const delayMs = this.retryBaseMs * Math.pow(2, nextAttempts - 1);
      const retryAfter = new Date(Date.now() + delayMs);
      await this.outboxRepo.markFailed(row.id, retryAfter);
    }
  }
}

/**
 * Build a DispatchFn that bridges an outbox row to WebhookQueue.processDelivery.
 *
 * The event_id from the outbox row is forwarded as the webhook payload `id` so
 * the receiver's webhookEventOrdering middleware sees the same UUID on every
 * retry and can deduplicate.
 */
export function makeWebhookDispatchFn(
  processDelivery: (url: string, payload: unknown, deliveryId?: string) => Promise<boolean>,
  listActiveByEvent: (event: string) => Promise<Array<{ url: string }>>
): DispatchFn {
  return async (row: OutboxRow): Promise<boolean> => {
    const endpoints = await listActiveByEvent(row.event_type);
    if (endpoints.length === 0) {
      // No subscribers – treat as dispatched so the row doesn't pile up
      return true;
    }

    const webhookPayload = {
      id: row.event_id,          // stable idempotency key
      event: row.event_type as WebhookEventType,
      payload: row.payload,
      timestamp: row.created_at.toISOString(),
    };

    const results = await Promise.all(
      endpoints.map((ep) => processDelivery(ep.url, webhookPayload))
    );
    return results.every(Boolean);
  };
}
