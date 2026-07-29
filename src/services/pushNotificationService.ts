/**
 * @fileoverview Push notification delivery service with stale-token pruning.
 *
 * Handles delivery to FCM/APNs with the following lifecycle:
 *
 * - 410 Gone → the device token is marked pruned, a metric is emitted,
 *   and an audit event is recorded.  No retry.
 * - 5xx / 429 → retried with exponential backoff (respecting provider
 *   max-delay).  The token is **not** evicted.
 * - Other 4xx → failed immediately; no retry, no pruning.
 *
 * Backoff formula:
 *   delay = min(initialDelayMs * backoffFactor^(attempt-1), maxDelayMs)
 *   final  = delay * (1 + random(0, 0.3))   // jitter
 *
 * @module services/pushNotificationService
 */

import { randomUUID } from 'crypto';
import {
  PushToken,
  PushTokenProvider,
  PushTokenRepository,
} from '../db/repositories/pushTokenRepository';
import { MetricsCollector, globalMetrics } from '../lib/metrics';
import { AuditEvent, SecurityAuditRepository } from '../security/types';
import { PushPayload } from './pushQuietHoursService';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result returned by a single provider send attempt. */
export interface PushSendResult {
  /** Whether the provider accepted the push (2xx). */
  success: boolean;
  /** HTTP status code from the provider, if available. */
  statusCode?: number;
  /** Human-readable error, if any. */
  error?: string;
  /** Retry-After hint from the provider (seconds), if provided. */
  retryAfterSec?: number;
}

/** Signature of a raw provider send function (FCM / APNs / mock). */
export type PushSendFn = (
  token: string,
  payload: PushPayload,
) => Promise<PushSendResult>;

/**
 * Configuration knobs for the backoff strategy.
 *
 * `maxDelayMs` should be set to the provider's documented maximum retry
 * interval (e.g. 64 s for FCM, 32 s for APNs).
 */
export interface PushNotificationServiceOptions {
  /** Maximum number of delivery attempts (including the first). Default: 5. */
  maxRetries: number;
  /** Base backoff delay in ms. Default: 1000. */
  initialDelayMs: number;
  /** Hard ceiling on backoff delay in ms. Default: 64_000. */
  maxDelayMs: number;
  /** Multiplier applied each retry step. Default: 2. */
  backoffFactor: number;
  /** Maximum jitter fraction (0–1). Default: 0.3 (30 %). */
  jitter: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: PushNotificationServiceOptions = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 64_000,
  backoffFactor: 2,
  jitter: 0.3,
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Push notification delivery orchestrator.
 *
 * Wraps a raw provider send function so that every delivery automatically:
 * - Prunes stale tokens on 410
 * - Applies exponential backoff for transient errors
 * - Emits Prometheus-compatible counters
 * - Records audit events for security-relevant outcomes
 *
 * Usage:
 * ```typescript
 * const svc = new PushNotificationService(tokenRepo, auditRepo, metrics, opts);
 * const token = await tokenRepo.findByToken('fcm-token-abc');
 * const result = await svc.send(token, payload, myFcmSendFn);
 * ```
 */
export class PushNotificationService {
  private readonly opts: PushNotificationServiceOptions;

  constructor(
    private readonly tokenRepo: PushTokenRepository,
    private readonly auditRepo: SecurityAuditRepository,
    private readonly metrics: MetricsCollector = globalMetrics,
    options: Partial<PushNotificationServiceOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...options };
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Send a push notification to a single device token.
   *
   * Behaviour per response status:
   * | Status     | Action                                      |
   * |------------|---------------------------------------------|
   * | 2xx        | Success, emit `push_send_success_total`     |
   * | 410        | Prune token, emit metric + audit, no retry  |
   * | 5xx / 429  | Retry with backoff (token NOT pruned)       |
   * | other 4xx  | Fail immediately, no retry                   |
   *
   * @param token   The PushToken entity (must include `.id` and `.provider`).
   * @param payload The push notification payload.
   * @param sendFn  Raw provider delivery function.
   * @returns The result of the final attempt.
   */
  async send(
    token: PushToken,
    payload: PushPayload,
    sendFn: PushSendFn,
  ): Promise<PushSendResult> {
    // Do not attempt delivery to already-pruned tokens.
    if (token.status === 'pruned') {
      return { success: false, error: 'Token already pruned' };
    }

    const provider: PushTokenProvider = token.provider;
    let lastResult: PushSendResult = { success: false };

    for (let attempt = 1; attempt <= this.opts.maxRetries; attempt++) {
      // -- Wait before retry (skip on first attempt) -----------------------
      if (attempt > 1) {
        const hintMs =
          lastResult.retryAfterSec !== undefined
            ? lastResult.retryAfterSec * 1000
            : undefined;
        await this.backoff(attempt - 1, hintMs);
      }

      // -- Perform the send -------------------------------------------------
      try {
        lastResult = await sendFn(token.token, payload);
      } catch (err) {
        // Treat thrown errors as transient network failures.
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        lastResult = { success: false, error: errorMessage };
      }

      this.metrics.incrementCounter(
        'push_send_attempts_total',
        { provider, status: String(lastResult.statusCode ?? 'unknown') },
        1,
        'Total push send attempts by provider and HTTP status',
      );

      // -- Success -----------------------------------------------------------
      if (lastResult.success) {
        this.metrics.incrementCounter(
          'push_send_success_total',
          { provider },
          1,
          'Successful push notification deliveries',
        );
        return lastResult;
      }

      // -- 410 Gone → prune token -------------------------------------------
      if (lastResult.statusCode === 410) {
        await this.pruneToken(token);
        return lastResult;
      }

      // -- Non-retryable 4xx (except 429) → fail immediately ---------------
      if (
        lastResult.statusCode !== undefined &&
        lastResult.statusCode >= 400 &&
        lastResult.statusCode < 500 &&
        lastResult.statusCode !== 429
      ) {
        this.metrics.incrementCounter(
          'push_send_failures_total',
          { provider, reason: '4xx_non_retryable' },
          1,
          'Push send failures (non-retryable 4xx)',
        );
        return lastResult;
      }

      // -- 5xx / 429 / network error → will retry if attempts remain -------
    }

    // Exhausted all retries.
    this.metrics.incrementCounter(
      'push_send_failures_total',
      { provider, reason: 'max_retries_exceeded' },
      1,
      'Push send failures after exhausting all retries',
    );
    return lastResult;
  }

  /**
   * Send a push to all active tokens belonging to a user.
   *
   * Each token delivery is independent; pruning of one token does not affect
   * delivery to others.
   *
   * @returns Array of per-token results.
   */
  async sendToUser(
    userId: string,
    payload: PushPayload,
    sendFn: PushSendFn,
  ): Promise<Array<{ token: PushToken; result: PushSendResult }>> {
    const tokens = await this.tokenRepo.findActiveByUser(userId);
    const results: Array<{ token: PushToken; result: PushSendResult }> = [];

    for (const token of tokens) {
      const result = await this.send(token, payload, sendFn);
      results.push({ token, result });
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Prune a token: mark it as pruned in the DB, emit a metric, and record
   * an audit event.
   *
   * Pruning is best-effort — failures are logged but never surfaced to the
   * caller, because the delivery already failed and the caller only cares
   * about whether the notification was accepted.
   */
  private async pruneToken(token: PushToken): Promise<void> {
    try {
      await this.tokenRepo.markPruned(token.id);
    } catch (err) {
      // Best-effort: log and continue.  The metric + audit still fire so
      // operators are aware of the stale token.
      console.error(
        `[PushNotificationService] Failed to mark token ${token.id} as pruned:`,
        err,
      );
    }

    // Metric — always emitted, even if DB write failed.
    this.metrics.incrementCounter(
      'push_token_pruned_total',
      { provider: token.provider },
      1,
      'Total push tokens pruned (device uninstalled / 410 from provider)',
    );

    // Gauge to track current pruned count.
    try {
      const prunedCount = await this.tokenRepo.countPruned();
      this.metrics.setGauge(
        'push_token_pruned_current',
        prunedCount,
        undefined,
        'Current count of pruned push tokens',
      );
    } catch {
      // Gauge update is non-critical.
    }

    // Audit event.
    const event: AuditEvent = {
      id: randomUUID(),
      type: 'SECURITY_VIOLATION',
      userId: token.user_id,
      action: 'push_token_pruned',
      resource: `push_token:${token.id}`,
      outcome: 'BLOCKED',
      details: {
        token_id: token.id,
        provider: token.provider,
        reason: '410 Gone — device uninstalled',
      },
      securityContext: {
        requestId: 'push-notification-service',
        ipAddress: '0.0.0.0',
        userAgent: 'push-notification-service/1.0',
        timestamp: new Date(),
      },
      timestamp: new Date(),
    };

    try {
      await this.auditRepo.record(event);
    } catch (err) {
      console.error(
        `[PushNotificationService] Failed to record audit event for pruned token ${token.id}:`,
        err,
      );
    }
  }

  /**
   * Sleep for a backoff delay computed from the attempt number.
   *
   * If the last result included a `retryAfterSec` hint from the provider,
   * that value (converted to ms) is used as a floor — we never wait less
   * than what the provider requested.
   *
   * Formula:
   *   delay = min(initialDelayMs * backoffFactor^(attempt-1), maxDelayMs)
   *   final = max(delay, providerHintMs) * (1 + random(0, jitter))
   */
  private async backoff(
    attempt: number,
    providerHintMs?: number,
  ): Promise<void> {
    const exponential = Math.min(
      this.opts.initialDelayMs *
        Math.pow(this.opts.backoffFactor, attempt - 1),
      this.opts.maxDelayMs,
    );
    const floor = Math.max(exponential, providerHintMs ?? 0);
    const jittered = floor * (1 + Math.random() * this.opts.jitter);
    const delayMs = Math.round(jittered);

    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Convenience factory that creates a PushNotificationService with sensible
 * defaults and the global metrics collector.
 */
export function createPushNotificationService(
  tokenRepo: PushTokenRepository,
  auditRepo: SecurityAuditRepository,
  options?: Partial<PushNotificationServiceOptions>,
): PushNotificationService {
  return new PushNotificationService(tokenRepo, auditRepo, globalMetrics, options);
}
