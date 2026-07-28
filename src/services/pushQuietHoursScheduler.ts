/**
 * PushQuietHoursScheduler
 *
 * Drives PushQuietHoursService.flush() on a fixed cadence so pushes that were
 * deferred during an investor's quiet hours are released as soon as their window
 * ends. This is the runtime counterpart to the deferral performed by
 * PushQuietHoursService.send().
 *
 * Wiring
 * ──────
 * The scheduler is transport-agnostic: it takes the same injected PushDeliveryFn
 * used elsewhere (FCM/APNs/etc.), so the application bootstrap owns the actual
 * delivery mechanism. Start it once during startup and stop it on shutdown.
 *
 * Metrics (emitted by the underlying service)
 * ────────────────────────────────────────────
 * push_deferred_queue_size            gauge    Set on every flush tick.
 * push_flush_delivered_total          counter  Pushes released by the scheduler.
 * push_flush_errors_total             counter  Flush ticks that threw.
 */

import { Logger, globalLogger } from '../lib/logger';
import { MetricsCollector, globalMetrics } from '../lib/metrics';
import { PushQuietHoursService, PushDeliveryFn } from './pushQuietHoursService';

/** How often to release deferred pushes. Default: every 60s. */
const DEFAULT_INTERVAL_MS = 60_000;

const METRIC_FLUSH_DELIVERED = 'push_flush_delivered_total';
const METRIC_FLUSH_ERRORS = 'push_flush_errors_total';

export interface PushQuietHoursSchedulerOptions {
  /** Flush cadence in milliseconds. Default: 60000. */
  intervalMs?: number;
  logger?: Logger;
  metrics?: MetricsCollector;
}

export class PushQuietHoursScheduler {
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly service: PushQuietHoursService,
    private readonly deliverFn: PushDeliveryFn,
    options: PushQuietHoursSchedulerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.logger = options.logger ?? globalLogger;
    this.metrics = options.metrics ?? globalMetrics;
  }

  /**
   * Begin releasing deferred pushes on the configured interval.
   * Idempotent: calling start() while already running is a no-op.
   * The timer is unref'd so it never keeps the process alive on its own.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Do not hold the event loop open solely for this timer.
    this.timer.unref?.();
    this.logger.info('PushQuietHoursScheduler: started', {
      intervalMs: this.intervalMs,
    });
  }

  /** Stop the scheduler. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('PushQuietHoursScheduler: stopped');
    }
  }

  /**
   * Run a single flush tick. Exposed for tests and manual triggering.
   * Errors are caught, counted, and logged so a transient delivery failure
   * never tears down the interval.
   */
  async tick(): Promise<number> {
    try {
      const delivered = await this.service.flush(this.deliverFn);
      if (delivered > 0) {
        this.metrics.incrementCounter(
          METRIC_FLUSH_DELIVERED,
          undefined,
          delivered,
          'Deferred push notifications released by the quiet-hours scheduler',
        );
      }
      return delivered;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('PushQuietHoursScheduler: flush tick failed', { error: message });
      this.metrics.incrementCounter(
        METRIC_FLUSH_ERRORS,
        undefined,
        1,
        'Quiet-hours flush ticks that threw',
      );
      return 0;
    }
  }
}
