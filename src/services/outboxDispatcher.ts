/**
 * OutboxDispatcher — drains webhook_outbox rows and delivers them to subscribers.
 * See architecture map for how the outbox participates in the producer transaction.
 *
 * @see ../../docs/architecture/distribution-reconciliation.md
 * @see ../docs/transactional-outbox.md
 * @see ../docs/webhook-queue-backpressure.md
 * @see ../docs/webhook-dead-letters.md
 */
import { OutboxRepository, OutboxRow } from '../db/repositories/outboxRepository';
import { WebhookEventType } from './webhookService';
import { PressureGauge, PressureTier, PressureGaugeConfig, PressureStateChangeCallback, PressureState } from '../lib/pressureGauge';
import { MetricsCollector } from '../lib/metrics';

// Re-export for convenient access
export { PressureTier, PressureGaugeConfig, PressureStateChangeCallback } from '../lib/pressureGauge';

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
  /** Configuration for pressure gauge thresholds. */
  pressureConfig?: PressureGaugeConfig;
  /** Metrics collector for emitting outbox.lag_seconds gauge. */
  metrics?: MetricsCollector;
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
 *
 * Outbox lag monitoring:
 * - Continuously measures age of oldest unsent record (outbox.lag_seconds metric).
 * - Emits saturation alerts on escalating pressure tiers (info, warning, critical).
 * - Signals backpressure via PressureGauge to allow producers to pause.
 */
export class OutboxDispatcher {
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly pressureGauge: PressureGauge;
  private readonly metrics: MetricsCollector;
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
    this.pressureGauge = new PressureGauge(options.pressureConfig);
    this.metrics = options.metrics ?? new MetricsCollector({ enabled: true });

    // Listen for pressure state changes and emit alerts
    this.pressureGauge.onStateChange(this.handlePressureStateChange.bind(this));
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
   * Get the current pressure gauge state.
   * Useful for monitoring and testing.
   */
  getPressureState() {
    return this.pressureGauge.getState();
  }

  /**
   * Get the current pressure tier.
   * Can be used by producers to decide whether to pause.
   */
  getPressureTier(): PressureTier {
    return this.pressureGauge.getTier();
  }

  /**
   * Check if pressure is at or above a given tier.
   * @param tier Tier to check against.
   * @returns True if current pressure is at or above the given tier.
   */
  isUnderPressure(tier: PressureTier = PressureTier.WARNING): boolean {
    return this.pressureGauge.isAtLeast(tier);
  }

  /**
   * Register a callback to be invoked when pressure state changes.
   * Allows external consumers to react to backpressure signals.
   */
  onPressureStateChange(callback: PressureStateChangeCallback): void {
    this.pressureGauge.onStateChange(callback);
  }

  /**
   * Run a single drain cycle. Exposed for testing and one-shot use.
   * Returns the number of rows processed.
   *
   * Also measures and updates outbox lag, emitting appropriate metrics
   * and pressure state transitions.
   */
  async drainOnce(): Promise<number> {
    // Measure lag before draining
    await this.measureAndUpdateLag();

    const rows = await this.outboxRepo.drainPending(this.batchSize);
    for (const row of rows) {
      await this.processRow(row);
    }
    return rows.length;
  }

  /**
   * Measure the age of the oldest pending outbox record and update pressure gauge.
   * Emits outbox.lag_seconds gauge metric.
   */
  private async measureAndUpdateLag(): Promise<void> {
    try {
      const oldestRow = await this.outboxRepo.getOldestPending();
      let lagSeconds = -1; // -1 indicates no pending records

      if (oldestRow) {
        // Calculate lag in seconds
        lagSeconds = (Date.now() - oldestRow.created_at.getTime()) / 1000;
      }

      // Update pressure gauge (handles tier transitions internally)
      this.pressureGauge.updateLag(lagSeconds);

      // Emit gauge metric
      this.metrics.setGauge('outbox_lag_seconds', lagSeconds >= 0 ? lagSeconds : 0, {
        status: lagSeconds < 0 ? 'normal' : 'pending',
      });
    } catch (error) {
      // Log but don't throw – lag measurement failure shouldn't stop dispatcher
      console.error('[OutboxDispatcher] Failed to measure lag:', error);
    }
  }

  /**
   * Internal callback invoked when pressure tier changes.
   * Emits appropriate alerts and metrics.
   */
  private handlePressureStateChange(oldState: PressureState, newState: PressureState): void {
    const { tier: oldTier, lagSeconds: oldLag } = oldState;
    const { tier: newTier, lagSeconds: newLag } = newState;

    // Emit metric for tier transition
    this.metrics.incrementCounter('outbox_pressure_tier_transitions', {
      from: oldTier,
      to: newTier,
    });

    // Emit alert based on severity
    const severityMap: Record<string, string> = {
      [PressureTier.NORMAL]: 'info',
      [PressureTier.INFO]: 'info',
      [PressureTier.WARNING]: 'warning',
      [PressureTier.CRITICAL]: 'critical',
    };

    const severity = severityMap[newTier];
    this.metrics.incrementCounter('outbox_saturation_alerts', {
      severity,
      tier: newTier,
    });

    console.log(
      `[OutboxDispatcher] Outbox saturation alert [${severity}] ` +
        `lag: ${oldLag.toFixed(2)}s → ${newLag.toFixed(2)}s, ` +
        `tier: ${oldTier} → ${newTier}`
    );
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
