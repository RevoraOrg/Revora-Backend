/**
 * @fileoverview Push notification quiet-hours enforcement.
 *
 * Investors may configure a quiet window (default 22:00–08:00 local time)
 * during which non-urgent push notifications are deferred into a bounded
 * in-memory queue and released into the next available window. Urgent pushes
 * bypass the window and emit an audit metric.
 *
 * DST safety: hour resolution uses Intl.DateTimeFormat with the investor's
 * IANA timezone, so the runtime's tz database handles DST automatically — no
 * manual offset math. Because flush() re-evaluates the live clock against each
 * item's config, a DST transition can never cause a push to be deferred twice:
 * the window either currently applies or it does not.
 *
 * @module services/pushQuietHoursService
 */

import { QuietHoursConfig, DEFAULT_QUIET_HOURS } from '../lib/notificationPreferencesRepository';
import { MetricsCollector, globalMetrics } from '../lib/metrics';

export { QuietHoursConfig, DEFAULT_QUIET_HOURS };

/** A push notification payload. */
export interface PushPayload {
  userId: string;
  title: string;
  body: string;
  /** When true, bypasses quiet hours and emits an audit metric. */
  urgent?: boolean;
  data?: Record<string, unknown>;
}

/** An entry in the deferred-push queue. */
export interface DeferredPush {
  payload: PushPayload;
  deferredAt: Date;
  quietHours: QuietHoursConfig;
}

/** Delivery function injected by callers (FCM, APNs, etc.). */
export type PushDeliveryFn = (payload: PushPayload) => Promise<void>;

/** Maximum entries in the deferred queue. Oldest are dropped on overflow. */
export const MAX_QUEUE_SIZE = 1000;

/**
 * Returns the local hour (0–23) for `date` in the given IANA timezone.
 * Delegates entirely to Intl.DateTimeFormat, which handles DST correctly.
 * @throws {Error} If the hour part cannot be resolved (invalid timezone).
 */
export function getLocalHour(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    hourCycle: 'h23',
    timeZone: timezone,
  }).formatToParts(date);
  const hourPart = parts.find((p) => p.type === 'hour');
  if (!hourPart) {
    throw new Error(`Cannot resolve hour for timezone: ${timezone}`);
  }
  return parseInt(hourPart.value, 10);
}

/**
 * Returns true when `date` falls inside the quiet-hours window.
 * Handles windows that cross midnight (e.g. 22:00–08:00) and returns false
 * for a disabled config or a degenerate zero-width window (start === end).
 */
export function isInQuietHours(date: Date, config: QuietHoursConfig): boolean {
  if (!config.enabled) return false;
  const { startHour, endHour } = config;
  if (startHour === endHour) return false; // degenerate: zero-width window
  const hour = getLocalHour(date, config.timezone);
  return startHour > endHour
    ? hour >= startHour || hour < endHour // crosses midnight
    : hour >= startHour && hour < endHour; // same day
}

/**
 * Manages quiet-hours enforcement for push notifications.
 *
 * Usage:
 * ```typescript
 * const svc = new PushQuietHoursService();
 * await svc.send(payload, prefs.quietHours ?? DEFAULT_QUIET_HOURS, deliverFn);
 * // later, from a scheduler:
 * await svc.flush(deliverFn);
 * ```
 */
export class PushQuietHoursService {
  private queue: DeferredPush[] = [];
  private readonly metrics: MetricsCollector;

  constructor(metrics: MetricsCollector = globalMetrics) {
    this.metrics = metrics;
  }

  /**
   * Send or defer a push notification based on the investor's quiet-hours config.
   *
   * - Outside quiet hours → delivered immediately.
   * - Inside quiet hours, non-urgent → queued; `push_deferred_count` incremented.
   * - Inside quiet hours, urgent → delivered immediately; `push_urgent_bypass_total`
   *   incremented for audit purposes.
   *
   * @param payload   The push notification to send.
   * @param config    The investor's quiet-hours configuration.
   * @param deliverFn Async function that performs the actual delivery.
   * @param now       Current time (injectable for testing; defaults to `new Date()`).
   * @returns `'sent'` if delivered immediately, `'deferred'` if queued.
   */
  async send(
    payload: PushPayload,
    config: QuietHoursConfig,
    deliverFn: PushDeliveryFn,
    now: Date = new Date(),
  ): Promise<'sent' | 'deferred'> {
    if (!isInQuietHours(now, config)) {
      await deliverFn(payload);
      return 'sent';
    }

    if (payload.urgent) {
      // Audit: urgent push bypassed quiet hours.
      this.metrics.incrementCounter(
        'push_urgent_bypass_total',
        undefined,
        1,
        'Urgent push notifications that bypassed quiet hours',
      );
      await deliverFn(payload);
      return 'sent';
    }

    this.enqueue({ payload, deferredAt: now, quietHours: config });
    this.metrics.incrementCounter(
      'push_deferred_count',
      undefined,
      1,
      'Push notifications deferred due to quiet hours',
    );
    return 'deferred';
  }

  /**
   * Deliver all queued pushes whose quiet-hours window has ended.
   *
   * Safe to call on any schedule. Because each call re-evaluates the current
   * time against each item's config, DST transitions cannot cause a push to be
   * deferred twice — the window either applies or it does not.
   *
   * @param deliverFn Async function that performs the actual delivery.
   * @param now       Current time (injectable for testing; defaults to `new Date()`).
   * @returns Number of notifications delivered.
   */
  async flush(deliverFn: PushDeliveryFn, now: Date = new Date()): Promise<number> {
    const due: DeferredPush[] = [];
    const remaining: DeferredPush[] = [];

    for (const item of this.queue) {
      (isInQuietHours(now, item.quietHours) ? remaining : due).push(item);
    }

    this.queue = remaining;

    for (const item of due) {
      await deliverFn(item.payload);
    }

    this.metrics.setGauge(
      'push_deferred_queue_size',
      this.queue.length,
      undefined,
      'Current size of the deferred push notification queue',
    );

    return due.length;
  }

  /** Current queue depth. */
  get queueSize(): number {
    return this.queue.length;
  }

  /**
   * Enqueue a deferred push, enforcing the bounded-queue invariant.
   * On overflow the oldest entry is dropped and an overflow metric is emitted.
   */
  private enqueue(item: DeferredPush): void {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      this.queue.shift(); // drop oldest
      this.metrics.incrementCounter(
        'push_deferred_queue_overflow_total',
        undefined,
        1,
        'Deferred push notifications dropped due to queue overflow',
      );
    }
    this.queue.push(item);
  }
}
