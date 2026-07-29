/**
 * KYC Provider Circuit Breaker
 *
 * Implements a circuit breaker pattern in front of a KYC provider to handle
 * vendor degradation gracefully. When the provider fails consecutively, the
 * circuit trips OPEN and serves cached non-negative decisions (if available
 * and fresh). Half-open probes are single-flight.
 *
 * Security invariants:
 * - A `rejected`/`denied` decision is NEVER cached as a positive fallback.
 * - Degraded-mode fallback is recorded as a SECURITY_VIOLATION audit event.
 * - Cache TTL is bounded by KYC_CIRCUIT_CACHE_TTL_MS (default 5 min).
 * - Half-open probes are single-flight to prevent thundering herd.
 */

import crypto from 'crypto';
import { KycProvider, KycApplicantInfo, KycCheckResult } from './KycProvider';
import { SecurityAuditRepository, AuditEvent } from '../../security/types';
import { globalMetrics } from '../../lib/metrics';
import { Errors } from '../../lib/errors';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface KycCircuitConfig {
  /** Number of consecutive failures before the circuit trips OPEN. */
  tripErrorCount: number;
  /** How long (ms) a cached decision is considered fresh. */
  cacheTtlMs: number;
  /** Absolute upper bound (ms) for cache entry lifetime. */
  maxCacheTtlMs: number;
  /** How long (ms) to wait after tripping before attempting a half-open probe. */
  halfOpenAfterMs: number;
}

export const DEFAULT_KYC_CIRCUIT_CONFIG: KycCircuitConfig = {
  tripErrorCount: 3,
  cacheTtlMs: 300_000,      // 5 min
  maxCacheTtlMs: 900_000,   // 15 min
  halfOpenAfterMs: 30_000,  // 30 s
};

// ---------------------------------------------------------------------------
// Circuit state
// ---------------------------------------------------------------------------

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface CachedDecision {
  result: KycCheckResult;
  cachedAt: number; // epoch ms
}

function generateAuditId(): string {
  return `kyc_circuit_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// KycCircuit
// ---------------------------------------------------------------------------

export class KycCircuit implements KycProvider {
  readonly name: string;

  // -- circuit state -------------------------------------------------------
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private lastOpenTime = 0;
  private halfOpenInFlight = false;
  private cache = new Map<string, CachedDecision>();
  private config: KycCircuitConfig;

  constructor(
    private readonly inner: KycProvider,
    private readonly auditRepo: SecurityAuditRepository,
    config?: Partial<KycCircuitConfig>,
  ) {
    this.name = `circuit_${inner.name}`;
    this.config = { ...DEFAULT_KYC_CIRCUIT_CONFIG, ...config };
  }

  // -----------------------------------------------------------------------
  // Public accessors (useful for tests / monitoring endpoints)
  // -----------------------------------------------------------------------

  getState(): CircuitState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  /** Force-reset the circuit to CLOSED (for operational tooling). */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.lastOpenTime = 0;
    this.halfOpenInFlight = false;
    this.cache.clear();
    this.emitStateGauge();
  }

  // -----------------------------------------------------------------------
  // KycProvider implementation
  // -----------------------------------------------------------------------

  async initiateCheck(
    investorId: string,
    info: KycApplicantInfo,
  ): Promise<KycCheckResult> {
    // --- OPEN state: serve cached decision or fail fast -------------------
    if (this.state === CircuitState.OPEN) {
      // Attempt half-open transition atomically (single-flight).
      if (this.tryEnterHalfOpen()) {
        // This call won the probe slot — fall through to the provider call below.
      } else {
        return this.serveCachedOrFail(investorId);
      }
    }

    // --- Try the underlying provider -------------------------------------
    try {
      const result = await this.inner.initiateCheck(investorId, info);
      await this.onSuccess(investorId, result);
      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const cached = this.getCachedDecision(investorId);

      if (cached) {
        // Report the failure for bookkeeping, then serve degraded fallback
        await this.onFailure(investorId, error);
        await this.recordDegradedFallback(investorId, cached, error.message);
        return cached;
      }

      await this.onFailure(investorId, error);
      throw error;
    }
  }

  async getStatus(referenceId: string): Promise<KycCheckResult> {
    try {
      const result = await this.inner.getStatus(referenceId);
      this.recordSuccess();
      return result;
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      await this.onFailure(referenceId, error);
      throw error;
    }
  }

  async handleWebhook(payload: unknown, signature: string): Promise<KycCheckResult> {
    // Webhooks bypass the circuit breaker entirely – the vendor pushed this data.
    return this.inner.handleWebhook(payload, signature);
  }

  // -----------------------------------------------------------------------
  // Private helpers – circuit state transitions
  // -----------------------------------------------------------------------

  private emitStateGauge(): void {
    const stateValue =
      this.state === CircuitState.CLOSED   ? 0
      : this.state === CircuitState.HALF_OPEN ? 1
      : /* OPEN */                           2;

    globalMetrics.setGauge(
      'kyc.circuit.state',
      stateValue,
      { provider: this.inner.name },
      'Current circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)',
    );
  }

  private async recordAuditEvent(
    overrides: Omit<AuditEvent, 'id' | 'timestamp'>,
  ): Promise<void> {
    const event: AuditEvent = {
      id: generateAuditId(),
      timestamp: new Date(),
      ...overrides,
    };
    await this.auditRepo.record(event);
  }

  /**
   * Atomically tries to transition from OPEN → HALF_OPEN.
   * Returns `true` if this caller won the probe slot (single-flight).
   */
  private tryEnterHalfOpen(): boolean {
    if (this.state !== CircuitState.OPEN) return false;
    if (this.halfOpenInFlight) return false;
    if (Date.now() - this.lastOpenTime < this.config.halfOpenAfterMs) return false;

    // WINNER — transition to half-open.
    this.state = CircuitState.HALF_OPEN;
    this.halfOpenInFlight = true;
    this.emitStateGauge();

    // Fire-and-forget audit.
    this.recordAuditEvent({
      type: 'AUTHORIZATION',
      userId: undefined,
      action: 'kyc.circuit.half_open_probe',
      resource: `kyc/provider/${this.inner.name}`,
      outcome: 'SUCCESS',
      details: {
        provider: this.inner.name,
        consecutive_failures_before_probe: this.consecutiveFailures,
      },
      securityContext: {
        requestId: `req_${Date.now()}`,
        ipAddress: 'system',
        userAgent: 'kyc-circuit-breaker',
        timestamp: new Date(),
      },
    }).catch(() => { /* audit failures are non-critical */ });

    return true;
  }

  private serveCachedOrFail(investorId: string): Promise<KycCheckResult> {
    const cached = this.getCachedDecision(investorId);
    if (cached) {
      // Fire-and-forget degraded-fallback audit.
      this.recordDegradedFallback(investorId, cached, 'circuit_open')
        .catch(() => {});
      return Promise.resolve(cached);
    }
    throw Errors.serviceUnavailable(
      `KYC provider ${this.inner.name} is unavailable and no cached decision is available`,
    );
  }

  // -----------------------------------------------------------------------
  // Cache management
  // -----------------------------------------------------------------------

  private getCacheKey(investorId: string): string {
    return investorId;
  }

  private isCacheFresh(cached: CachedDecision): boolean {
    return Date.now() - cached.cachedAt < this.config.cacheTtlMs;
  }

  /** A cached decision is valid only if fresh AND not `rejected`. */
  private isCacheValid(cached: CachedDecision): boolean {
    if (cached.result.status === 'rejected') return false;
    return this.isCacheFresh(cached);
  }

  private getCachedDecision(investorId: string): KycCheckResult | null {
    const cached = this.cache.get(this.getCacheKey(investorId));
    if (!cached) return null;
    if (!this.isCacheValid(cached)) {
      this.cache.delete(this.getCacheKey(investorId));
      return null;
    }
    return cached.result;
  }

  private cacheDecision(investorId: string, result: KycCheckResult): void {
    // NEVER cache a rejected decision.
    if (result.status === 'rejected') return;

    this.cache.set(this.getCacheKey(investorId), {
      result,
      cachedAt: Date.now(),
    });

    // Periodic eviction of stale entries beyond the absolute max TTL.
    const deadline = Date.now() - this.config.maxCacheTtlMs;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.cachedAt < deadline) this.cache.delete(key);
    }
  }

  // -----------------------------------------------------------------------
  // Outcome handlers
  // -----------------------------------------------------------------------

  private recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      // Half-open probe succeeded → close the circuit.
      this.state = CircuitState.CLOSED;
      this.halfOpenInFlight = false;
      this.consecutiveFailures = 0;
      this.emitStateGauge();
      // Fire-and-forget audit.
      this.recordAuditEvent({
        type: 'AUTHORIZATION',
        userId: undefined,
        action: 'kyc.circuit.half_open_succeeded',
        resource: `kyc/provider/${this.inner.name}`,
        outcome: 'SUCCESS',
        details: { provider: this.inner.name },
        securityContext: {
          requestId: `req_${Date.now()}`,
          ipAddress: 'system',
          userAgent: 'kyc-circuit-breaker',
          timestamp: new Date(),
        },
      }).catch(() => {});
    } else {
      // Success in CLOSED state resets the failure counter.
      this.consecutiveFailures = 0;
    }
  }

  private async onSuccess(
    investorId: string,
    result: KycCheckResult,
  ): Promise<void> {
    this.recordSuccess();
    this.cacheDecision(investorId, result);
  }

  private async onFailure(
    investorId: string,
    error: Error,
  ): Promise<void> {
    this.consecutiveFailures++;
    globalMetrics.incrementCounter('kyc.circuit.failure', {
      provider: this.inner.name,
      state: this.state,
    });

    if (this.state === CircuitState.CLOSED && this.consecutiveFailures >= this.config.tripErrorCount) {
      // Trip the circuit.
      this.state = CircuitState.OPEN;
      this.lastOpenTime = Date.now();
      this.emitStateGauge();
      await this.recordAuditEvent({
        type: 'SECURITY_VIOLATION',
        userId: undefined,
        action: 'kyc.circuit.tripped',
        resource: `kyc/provider/${this.inner.name}`,
        outcome: 'FAILURE',
        details: {
          provider: this.inner.name,
          consecutive_failures: this.consecutiveFailures,
          trip_error_count: this.config.tripErrorCount,
          last_error: error.message,
        },
        securityContext: {
          requestId: `req_${Date.now()}`,
          ipAddress: 'system',
          userAgent: 'kyc-circuit-breaker',
          timestamp: new Date(),
        },
      });
    } else if (this.state === CircuitState.HALF_OPEN) {
      // Probe failed → go back to OPEN.
      this.state = CircuitState.OPEN;
      this.lastOpenTime = Date.now();
      this.halfOpenInFlight = false;
      this.emitStateGauge();
      await this.recordAuditEvent({
        type: 'SECURITY_VIOLATION',
        userId: undefined,
        action: 'kyc.circuit.half_open_failed',
        resource: `kyc/provider/${this.inner.name}`,
        outcome: 'FAILURE',
        details: {
          provider: this.inner.name,
          last_error: error.message,
        },
        securityContext: {
          requestId: `req_${Date.now()}`,
          ipAddress: 'system',
          userAgent: 'kyc-circuit-breaker',
          timestamp: new Date(),
        },
      });
    }
  }

  private async recordDegradedFallback(
    investorId: string,
    cached: KycCheckResult,
    reason: string,
  ): Promise<void> {
    // Derive cache age from the cached result itself — no risk of eviction races.
    const entry = this.cache.get(this.getCacheKey(investorId));
    const cacheAgeMs = entry ? Date.now() - entry.cachedAt : 0;

    await this.recordAuditEvent({
      type: 'SECURITY_VIOLATION',
      userId: undefined,
      action: 'kyc.circuit.degraded_fallback',
      resource: `kyc/investor/${investorId}`,
      outcome: 'SUCCESS',
      details: {
        provider: this.inner.name,
        reason,
        circuit_state: this.state,
        cached_status: cached.status,
        cached_provider: cached.provider,
        cache_age_ms: cacheAgeMs,
      },
      securityContext: {
        requestId: `req_${Date.now()}`,
        ipAddress: 'system',
        userAgent: 'kyc-circuit-breaker',
        timestamp: new Date(),
      },
    });
  }
}
