/**
 * OutboxHmacRotationService — automatic HMAC secret rotation for outbox signing.
 *
 * ## Design Overview
 *
 * Outbox rows are signed at delivery time (not at insertion time). This service
 * manages the lifecycle of HMAC secrets used to sign outgoing webhook payloads:
 *
 *   1. A KMS client (real or mock) supplies new secret material on demand.
 *   2. On each rotation cycle the current secret becomes the "previous" secret,
 *      and the newly fetched secret becomes "current".
 *   3. During the **overlap window** (bounded by `overlapWindowMs`) both the
 *      current and previous secrets are available so that receivers that cached
 *      the old signing key still have time to verify in-flight deliveries.
 *   4. Once the overlap window expires the previous secret is cleared and any
 *      signature produced with it MUST be rejected by receivers.
 *   5. After each successful rotation a `secret.rotation.completed` audit event
 *      is emitted via the provided audit sink, recording enough metadata for a
 *      complete audit trail without leaking the secret values themselves.
 *
 * ## Overlap Window Enforcement
 *
 * The overlap window is enforced by `overlapWindowMs` (default: 5 minutes).
 * `getPreviousSecret()` returns `undefined` once `Date.now() > overlapExpiresAt`.
 * Callers performing dual-key verification MUST check `isOverlapWindowActive()`
 * or use `getDualKeyConfig()` which handles expiry automatically.
 *
 * ## KMS Abstraction
 *
 * The `KmsClient` interface is intentionally minimal so it can be backed by:
 *   - AWS KMS `GenerateRandom` + `GetSecretValue` (production)
 *   - `crypto.randomBytes` (development / default)
 *   - A deterministic mock (testing)
 *
 * @see docs/outbox-hmac-secret-rotation.md
 */

import { randomBytes } from 'crypto';
import { MetricsCollector, globalMetrics } from '../lib/metrics';

// ─── KMS abstraction ────────────────────────────────────────────────────────

/**
 * Minimal KMS client interface.  Real implementations back this with
 * AWS Secrets Manager, Vault, or similar.  The default implementation
 * generates cryptographically secure random bytes locally.
 */
export interface KmsClient {
  /**
   * Generate a new HMAC secret value suitable for outbox signing.
   * @returns A hex-encoded secret string (≥ 32 bytes of entropy recommended).
   */
  generateSecret(): Promise<string>;
}

/**
 * Default KMS client that uses Node's `crypto.randomBytes`.
 * Suitable for development and environments without an external KMS.
 */
export class LocalKmsClient implements KmsClient {
  constructor(private readonly byteLength: number = 32) {}

  async generateSecret(): Promise<string> {
    return randomBytes(this.byteLength).toString('hex');
  }
}

// ─── Audit sink abstraction ─────────────────────────────────────────────────

/**
 * Audit event emitted when a rotation completes successfully.
 *
 * Secret values are NEVER included — only version/timing metadata so the
 * event is safe to store in an audit log that may be accessible to auditors.
 */
export interface RotationAuditEvent {
  /** Always `'secret.rotation.completed'` for this event type. */
  action: 'secret.rotation.completed';
  /** ISO 8601 timestamp of when the rotation completed. */
  rotatedAt: string;
  /** Opaque identifier for the outgoing secret version rotated IN. */
  incomingSecretVersion: string;
  /** Opaque identifier for the secret version rotated OUT (now in overlap). */
  outgoingSecretVersion: string;
  /** Epoch ms at which the overlap window closes (old key stops being accepted). */
  overlapExpiresAtMs: number;
  /** Duration of the overlap window in milliseconds. */
  overlapWindowMs: number;
  /** Optional resource identifier (e.g. endpoint scope, 'global', etc.). */
  resource?: string;
}

/**
 * Sink that persists the rotation audit event.  Wire up to AuditLogRepository
 * in production; use a jest.fn() in tests.
 */
export type AuditSink = (event: RotationAuditEvent) => Promise<void>;

// ─── Rotation service options ────────────────────────────────────────────────

export interface OutboxHmacRotationOptions {
  /**
   * How long (ms) the old secret remains accepted for verification after a
   * rotation.  Must be > 0.  Default: 5 minutes (300_000 ms).
   *
   * Once this window closes, `getPreviousSecret()` returns `undefined` and
   * the old secret is permanently discarded — callers must reject signatures
   * produced with it.
   */
  overlapWindowMs?: number;

  /**
   * How often (ms) the scheduler calls `rotate()` automatically.
   * Default: 24 hours (86_400_000 ms).
   */
  rotationIntervalMs?: number;

  /**
   * KMS client used to generate new secret material.
   * Defaults to `LocalKmsClient` (crypto.randomBytes).
   */
  kmsClient?: KmsClient;

  /**
   * Audit sink called after each successful rotation.
   * When omitted, audit events are logged to stdout only.
   */
  auditSink?: AuditSink;

  /**
   * Optional metrics collector.  Defaults to the global singleton.
   */
  metrics?: MetricsCollector;

  /**
   * Optional resource label attached to audit events (e.g. 'global', an
   * endpoint ID, or a service name).
   */
  resource?: string;

  /**
   * Initial current secret.  If not provided, `rotate()` must be called
   * (or `start()`) before `getCurrentSecret()` is usable.
   */
  initialSecret?: string;
}

// ─── Secret version record ────────────────────────────────────────────────────

/**
 * Internal bookkeeping record for a secret version.
 * The `value` field is kept in memory only and never serialised.
 */
interface SecretVersion {
  /** Opaque monotonic version identifier (e.g. "v3", "v4"). */
  version: string;
  /** The raw secret value (in memory only — never logged or emitted). */
  value: string;
  /** When this version was promoted to current (epoch ms). */
  activatedAt: number;
}

// ─── OutboxHmacRotationService ────────────────────────────────────────────────

/**
 * Manages automatic rotation of the HMAC secret used to sign outbox webhook
 * deliveries.  Exposes `getCurrentSecret()` and `getDualKeyConfig()` for use
 * by the signing and verification layers.
 *
 * Lifecycle:
 * ```
 * const svc = new OutboxHmacRotationService({ auditSink, kmsClient });
 * await svc.start();          // performs first rotation, starts scheduler
 * // …during operation…
 * const secret = svc.getCurrentSecret();     // sign with this
 * const config = svc.getDualKeyConfig();     // verify with this (dual-key)
 * // …on shutdown…
 * svc.stop();
 * ```
 */
export class OutboxHmacRotationService {
  private readonly overlapWindowMs: number;
  private readonly rotationIntervalMs: number;
  private readonly kmsClient: KmsClient;
  private readonly auditSink: AuditSink;
  private readonly metrics: MetricsCollector;
  private readonly resource?: string;

  /** Current active signing secret. */
  private current: SecretVersion | null = null;
  /** Previous secret — valid for verification until `overlapExpiresAt`. */
  private previous: SecretVersion | null = null;
  /** Epoch ms when the previous secret's acceptance window closes. */
  private overlapExpiresAt: number = 0;

  /** Monotonic version counter (incremented on each rotation). */
  private versionCounter: number = 0;

  /** Scheduler handle. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: boolean = false;

  constructor(options: OutboxHmacRotationOptions = {}) {
    this.overlapWindowMs = options.overlapWindowMs ?? 300_000; // 5 min default
    this.rotationIntervalMs = options.rotationIntervalMs ?? 86_400_000; // 24 h default
    this.kmsClient = options.kmsClient ?? new LocalKmsClient();
    this.metrics = options.metrics ?? globalMetrics;
    this.resource = options.resource;

    // Default audit sink writes a structured log line if none provided
    this.auditSink =
      options.auditSink ??
      (async (event) => {
        console.log(
          `[OutboxHmacRotationService] ${event.action}`,
          JSON.stringify({
            rotatedAt: event.rotatedAt,
            incomingSecretVersion: event.incomingSecretVersion,
            outgoingSecretVersion: event.outgoingSecretVersion,
            overlapExpiresAtMs: event.overlapExpiresAtMs,
            overlapWindowMs: event.overlapWindowMs,
            resource: event.resource,
          }),
        );
      });

    // Seed with a caller-supplied initial secret (useful in tests / dev)
    if (options.initialSecret !== undefined) {
      this.versionCounter = 1;
      this.current = {
        version: this.makeVersionId(1),
        value: options.initialSecret,
        activatedAt: Date.now(),
      };
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Return the current signing secret.
   * Outbox delivery MUST always sign with this value.
   *
   * @throws {Error} If no rotation has occurred yet and no `initialSecret` was
   *   supplied.  Call `start()` or `rotate()` first.
   */
  getCurrentSecret(): string {
    if (!this.current) {
      throw new Error(
        '[OutboxHmacRotationService] No secret available — call rotate() or start() first.',
      );
    }
    return this.current.value;
  }

  /**
   * Return the previous secret if the overlap window is still active, otherwise
   * `undefined`.
   *
   * Callers performing dual-key verification should use `getDualKeyConfig()`
   * instead, which encapsulates the expiry check.
   */
  getPreviousSecret(): string | undefined {
    if (!this.previous) return undefined;
    if (Date.now() > this.overlapExpiresAt) {
      // Overlap window closed — purge the reference
      this.previous = null;
      return undefined;
    }
    return this.previous.value;
  }

  /**
   * Return `true` if the overlap window is currently active (i.e. both the
   * current and previous secrets should be accepted for verification).
   */
  isOverlapWindowActive(): boolean {
    return this.previous !== null && Date.now() <= this.overlapExpiresAt;
  }

  /**
   * Epoch ms at which the current overlap window closes.
   * Returns `0` if no overlap is active.
   */
  getOverlapExpiresAt(): number {
    return this.isOverlapWindowActive() ? this.overlapExpiresAt : 0;
  }

  /**
   * Return a dual-key configuration object suitable for passing to
   * `verifyWebhookPayloadDualKey()` or `verifyWebhook()`.
   *
   * `nextSecretExpiry` is set to the overlap window deadline so that the old
   * secret is hard-rejected once it expires.
   *
   * Note on terminology: in the verification helpers the *incoming* webhook
   * is verified against the secret pair.  For outbound signing we always use
   * `getCurrentSecret()`; the dual-key config is for the *receiver* side that
   * needs to accept deliveries signed during a rotation transition.
   */
  getDualKeyConfig(): {
    secret: string;
    nextSecret?: string;
    nextSecretExpiry?: number;
  } {
    const secret = this.getCurrentSecret();
    const previousSecret = this.getPreviousSecret();

    if (previousSecret && this.overlapExpiresAt > 0) {
      return {
        secret,
        nextSecret: previousSecret,
        nextSecretExpiry: this.overlapExpiresAt,
      };
    }

    return { secret };
  }

  /**
   * Perform a single rotation cycle:
   *   1. Fetch a new secret from KMS.
   *   2. Demote current → previous (with overlap window).
   *   3. Promote new → current.
   *   4. Emit `secret.rotation.completed` audit event.
   *   5. Emit rotation counter metric.
   *
   * @throws Re-throws KMS errors so callers can handle them (e.g. the
   *   scheduler backs off).
   */
  async rotate(): Promise<void> {
    // 1. Fetch new secret from KMS (may throw — let it propagate)
    const newSecretValue = await this.kmsClient.generateSecret();

    const now = Date.now();
    this.versionCounter += 1;
    const newVersion = this.makeVersionId(this.versionCounter);

    const outgoingVersion = this.current?.version ?? 'none';

    // 2. Demote current → previous with a bounded overlap window
    if (this.current) {
      this.previous = this.current;
      this.overlapExpiresAt = now + this.overlapWindowMs;
    }

    // 3. Promote new → current
    this.current = {
      version: newVersion,
      value: newSecretValue,
      activatedAt: now,
    };

    const overlapExpiresAt = this.overlapExpiresAt;

    // 4. Emit audit event (fire-and-forget errors — audit failure must not
    //    interrupt the rotation itself)
    const auditEvent: RotationAuditEvent = {
      action: 'secret.rotation.completed',
      rotatedAt: new Date(now).toISOString(),
      incomingSecretVersion: newVersion,
      outgoingSecretVersion: outgoingVersion,
      overlapExpiresAtMs: overlapExpiresAt,
      overlapWindowMs: this.overlapWindowMs,
      resource: this.resource,
    };

    try {
      await this.auditSink(auditEvent);
    } catch (err) {
      console.error('[OutboxHmacRotationService] Failed to emit audit event:', err);
    }

    // 5. Emit metrics
    try {
      this.metrics.incrementCounter('outbox_hmac_rotations_total', {
        resource: this.resource ?? 'global',
      });
    } catch {
      // Never let metric emission break rotation
    }
  }

  /**
   * Start the automatic rotation scheduler.
   * Also performs an immediate rotation on first call if no secret is loaded.
   * Safe to call multiple times (idempotent).
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Rotate immediately if no secret is available yet
    if (!this.current) {
      await this.rotate();
    }

    this.scheduleNext();
  }

  /**
   * Stop the automatic rotation scheduler.
   * In-progress rotations are not interrupted.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private makeVersionId(counter: number): string {
    return `v${counter}`;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.rotate();
      } catch (err) {
        console.error('[OutboxHmacRotationService] Scheduled rotation failed:', err);
      }
      this.scheduleNext();
    }, this.rotationIntervalMs);

    // Allow the process to exit even while timer is pending
    if (this.timer.unref) {
      this.timer.unref();
    }
  }
}
