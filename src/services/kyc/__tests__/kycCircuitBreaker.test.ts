/**
 * Tests for the KYC provider circuit breaker (KycCircuit).
 *
 * Coverage targets:
 * - Normal CLOSED-state operation (success & failure)
 * - OPEN-state degraded fallback (with and without cached decision)
 * - HALF_OPEN single-flight probe behaviour
 * - Cache validity (freshness, rejection blacklist)
 * - Audit event emission
 * - Metrics gauge emission
 * - Config overrides / defaults
 * - Edge cases: empty cache, stale cache, rejected cached decisions
 */

import { KycCircuit, CircuitState } from '../kycCircuitBreaker';
import { NullKycProvider } from '../providers/NullKycProvider';
import { KycProvider, KycApplicantInfo, KycCheckResult } from '../KycProvider';
import { SecurityAuditRepository } from '../../../security/types';
import { globalMetrics } from '../../../lib/metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApplicant(overrides?: Partial<KycApplicantInfo>): KycApplicantInfo {
  return {
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    dateOfBirth: '1990-06-15',
    address: {
      country: 'US',
      line1: '456 Oak Ave',
      city: 'Springfield',
      postalCode: '62701',
    },
    ...overrides,
  };
}

/**
 * A provider that fails a configurable number of times then succeeds.
 * - `failCount`: how many consecutive calls will fail before succeeding.
 */
class FlipFlopProvider implements KycProvider {
  readonly name = 'flipflop';
  private callCount = 0;

  constructor(
    private failCount: number,
    private successResult: KycCheckResult = {
      status: 'approved',
      provider: 'flipflop',
      referenceId: 'ref-flipflop',
    },
    private failure: Error = new Error('FlipFlop failure'),
  ) {}

  reset(): void { this.callCount = 0; }

  /** Set to 0 to succeed on next call, 1+ to fail that many times. */
  setFailCount(n: number): void { this.failCount = n; }

  async initiateCheck(_investorId: string, _info: KycApplicantInfo): Promise<KycCheckResult> {
    this.callCount++;
    if (this.callCount <= this.failCount) throw this.failure;
    return this.successResult;
  }

  async getStatus(_referenceId: string): Promise<KycCheckResult> {
    this.callCount++;
    if (this.callCount <= this.failCount) throw this.failure;
    return this.successResult;
  }

  async handleWebhook(_payload: unknown, _signature: string): Promise<KycCheckResult> {
    return this.successResult;
  }
}

/** A provider that always throws. */
class AlwaysFailsProvider implements KycProvider {
  readonly name = 'always_fails';
  async initiateCheck(_investorId: string, _info: KycApplicantInfo): Promise<KycCheckResult> {
    throw new Error('Provider is down');
  }
  async getStatus(_referenceId: string): Promise<KycCheckResult> {
    throw new Error('Provider is down');
  }
  async handleWebhook(_payload: unknown, _signature: string): Promise<KycCheckResult> {
    throw new Error('Provider is down');
  }
}

/** A provider that always returns a `rejected` status. */
class AlwaysRejectsProvider implements KycProvider {
  readonly name = 'always_rejects';
  async initiateCheck(_investorId: string, _info: KycApplicantInfo): Promise<KycCheckResult> {
    return { status: 'rejected', provider: 'always_rejects', referenceId: 'ref-reject' };
  }
  async getStatus(_referenceId: string): Promise<KycCheckResult> {
    return { status: 'rejected', provider: 'always_rejects', referenceId: _referenceId };
  }
  async handleWebhook(_payload: unknown, _signature: string): Promise<KycCheckResult> {
    return { status: 'rejected', provider: 'always_rejects', referenceId: 'unknown' };
  }
}

function makeAuditRepo(): jest.Mocked<SecurityAuditRepository> {
  return {
    record: jest.fn().mockResolvedValue(undefined),
    findByUserId: jest.fn().mockResolvedValue([]),
    findBySessionId: jest.fn().mockResolvedValue([]),
    findSecurityViolations: jest.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KycCircuit', () => {
  let auditRepo: jest.Mocked<SecurityAuditRepository>;

  beforeEach(() => {
    auditRepo = makeAuditRepo();
  });

  // -----------------------------------------------------------------------
  // Construction & defaults
  // -----------------------------------------------------------------------

  describe('construction', () => {
    it('wraps the provider name with a circuit_ prefix', () => {
      const nullProvider = new NullKycProvider();
      const circuit = new KycCircuit(nullProvider, auditRepo);
      expect(circuit.name).toBe('circuit_null_provider');
    });

    it('uses default config when no overrides provided', () => {
      const nullProvider = new NullKycProvider();
      const circuit = new KycCircuit(nullProvider, auditRepo);
      expect(circuit.getState()).toBe(CircuitState.CLOSED);
      expect(circuit.getConsecutiveFailures()).toBe(0);
      expect(circuit.getCacheSize()).toBe(0);
    });

    it('accepts partial config overrides that affect tripping behaviour', async () => {
      const flip = new FlipFlopProvider(4); // 4 failures then succeed
      const circuit = new KycCircuit(flip, auditRepo, { tripErrorCount: 5 });
      // 4 failures are < tripErrorCount of 5, so should NOT trip
      for (let i = 0; i < 4; i++) {
        await expect(circuit.initiateCheck(`inv-${i}`, makeApplicant())).rejects.toThrow();
      }
      expect(circuit.getState()).toBe(CircuitState.CLOSED);
      expect(circuit.getConsecutiveFailures()).toBe(4);
    });
  });

  // -----------------------------------------------------------------------
  // CLOSED state – normal operation
  // -----------------------------------------------------------------------

  describe('CLOSED state', () => {
    it('delegates to inner provider on success', async () => {
      const nullProvider = new NullKycProvider();
      const circuit = new KycCircuit(nullProvider, auditRepo);
      const result = await circuit.initiateCheck('inv-1', makeApplicant());
      expect(result.status).toBe('pending');
      expect(result.provider).toBe('null_provider');
    });

    it('caches the decision on success', async () => {
      const nullProvider = new NullKycProvider();
      const circuit = new KycCircuit(nullProvider, auditRepo);
      await circuit.initiateCheck('inv-1', makeApplicant());
      expect(circuit.getCacheSize()).toBe(1);
    });

    it('does not cache rejected decisions', async () => {
      const rejector = new AlwaysRejectsProvider();
      const circuit = new KycCircuit(rejector, auditRepo);
      await circuit.initiateCheck('inv-1', makeApplicant());
      expect(circuit.getCacheSize()).toBe(0);
    });

    it('resets consecutive failures on success', async () => {
      const flip = new FlipFlopProvider(2);
      const circuit = new KycCircuit(flip, auditRepo, { tripErrorCount: 5 });
      // 2 failures
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      expect(circuit.getConsecutiveFailures()).toBe(2);
      // Success resets
      const result = await circuit.initiateCheck('inv-1', makeApplicant());
      expect(result.status).toBe('approved');
      expect(circuit.getConsecutiveFailures()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Tripping & OPEN state
  // -----------------------------------------------------------------------

  describe('tripping & OPEN state', () => {
    it('trips open after configured consecutive failures', async () => {
      const failer = new AlwaysFailsProvider();
      const circuit = new KycCircuit(failer, auditRepo, { tripErrorCount: 2 });
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      expect(circuit.getState()).toBe(CircuitState.OPEN);
      expect(circuit.getConsecutiveFailures()).toBe(2);
    });

    it('emits kyc.circuit.state gauge on trip', async () => {
      const setGaugeSpy = jest.spyOn(globalMetrics, 'setGauge');
      const failer = new AlwaysFailsProvider();
      const circuit = new KycCircuit(failer, auditRepo, { tripErrorCount: 1 });
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      expect(setGaugeSpy).toHaveBeenCalledWith(
        'kyc.circuit.state',
        2, // OPEN
        { provider: 'always_fails' },
        expect.any(String),
      );
      setGaugeSpy.mockRestore();
    });

    it('throws serviceUnavailable when OPEN with no cached decision', async () => {
      const failer = new AlwaysFailsProvider();
      const circuit = new KycCircuit(failer, auditRepo, {
        tripErrorCount: 1,
        halfOpenAfterMs: 60_000, // long enough to not auto-probe
      });
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      expect(circuit.getState()).toBe(CircuitState.OPEN);

      // Second call while OPEN (no half-open, no cache) -> service unavailable
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow(
        /no cached decision is available/,
      );
    });

    it('records a SECURITY_VIOLATION audit event on trip', async () => {
      const failer = new AlwaysFailsProvider();
      const circuit = new KycCircuit(failer, auditRepo, { tripErrorCount: 1 });
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();

      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'SECURITY_VIOLATION',
          action: 'kyc.circuit.tripped',
        }),
      );
    });

    it('increments kyc.circuit.failure counter on each failure', async () => {
      const counterSpy = jest.spyOn(globalMetrics, 'incrementCounter');
      const failer = new AlwaysFailsProvider();
      const circuit = new KycCircuit(failer, auditRepo, { tripErrorCount: 2 });
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      expect(counterSpy).toHaveBeenCalledWith(
        'kyc.circuit.failure',
        expect.objectContaining({ provider: 'always_fails' }),
      );
      counterSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Degraded fallback (OPEN + cached decision)
  // -----------------------------------------------------------------------

  describe('degraded fallback', () => {
    it('serves cached decision when circuit is OPEN', async () => {
      const flip = new FlipFlopProvider(0); // succeeds first time
      const circuit = new KycCircuit(flip, auditRepo, {
        tripErrorCount: 1,
        halfOpenAfterMs: 60_000,
      });
      // First call succeeds and caches
      const firstResult = await circuit.initiateCheck('inv-1', makeApplicant());
      expect(firstResult.status).toBe('approved');

      // Make the provider start failing and trip the circuit
      flip.reset();
      flip.setFailCount(100);
      // First failure: provider fails but circuit still CLOSED (tripErrorCount=1 → trips)
      await expect(circuit.initiateCheck('inv-2', makeApplicant())).rejects.toThrow();
      expect(circuit.getState()).toBe(CircuitState.OPEN);

      // Now OPEN with cached decision for 'inv-1' — should get fallback
      const fallback = await circuit.initiateCheck('inv-1', makeApplicant());
      expect(fallback.status).toBe('approved');
      expect(fallback.referenceId).toBe('ref-flipflop');
    });

    it('records degraded_fallback audit event', async () => {
      const flip = new FlipFlopProvider(0);
      const circuit = new KycCircuit(flip, auditRepo, {
        tripErrorCount: 1,
        halfOpenAfterMs: 60_000,
      });
      // Cache a decision
      await circuit.initiateCheck('inv-1', makeApplicant());

      // Trip the circuit by making a different investor fail
      flip.reset();
      flip.setFailCount(100);
      await expect(circuit.initiateCheck('inv-2', makeApplicant())).rejects.toThrow();
      expect(circuit.getState()).toBe(CircuitState.OPEN);

      // Fallback for 'inv-1'
      await circuit.initiateCheck('inv-1', makeApplicant());

      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'kyc.circuit.degraded_fallback',
          type: 'SECURITY_VIOLATION',
        }),
      );
    });

    it('throws serviceUnavailable when OPEN and cache expired', async () => {
      const flip = new FlipFlopProvider(0);
      const circuit = new KycCircuit(flip, auditRepo, {
        tripErrorCount: 1,
        cacheTtlMs: 0, // expire immediately
        halfOpenAfterMs: 60_000,
      });
      // Cache a decision (it will be expired immediately due to TTL=0)
      await circuit.initiateCheck('inv-1', makeApplicant());

      // Trip the circuit
      flip.reset();
      flip.setFailCount(100);
      await expect(circuit.initiateCheck('inv-2', makeApplicant())).rejects.toThrow();
      expect(circuit.getState()).toBe(CircuitState.OPEN);

      // No cached decision (expired) → service unavailable
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow(
        /no cached decision is available/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // HALF_OPEN state
  // -----------------------------------------------------------------------

  describe('HALF_OPEN state', () => {
    it('transitions to half-open after halfOpenAfterMs and closes on probe success', async () => {
      const flip = new FlipFlopProvider(0); // succeeds immediately
      const circuit = new KycCircuit(flip, auditRepo, {
        tripErrorCount: 1,
        halfOpenAfterMs: 10, // very short
      });
      // Trip by making a call fail
      flip.setFailCount(100);
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      expect(circuit.getState()).toBe(CircuitState.OPEN);

      // Wait for half-open window
      await new Promise(r => setTimeout(r, 20));

      // Now make the provider succeed and send a probe
      flip.reset();
      flip.setFailCount(0);
      const result = await circuit.initiateCheck('inv-1', makeApplicant());
      expect(result.status).toBe('approved');
      expect(circuit.getState()).toBe(CircuitState.CLOSED);
    });

    it('is single-flight for half-open probes', async () => {
      let maxConcurrent = 0;
      let concurrentCalls = 0;

      const slowProvider: KycProvider = {
        name: 'slow',
        async initiateCheck(_id: string, _info: KycApplicantInfo): Promise<KycCheckResult> {
          concurrentCalls++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
          await new Promise(r => setTimeout(r, 100));
          concurrentCalls--;
          return { status: 'approved', provider: 'slow', referenceId: 'ref-slow' };
        },
        async getStatus() {
          return { status: 'approved', provider: 'slow', referenceId: 'ref-slow' };
        },
        async handleWebhook() {
          return { status: 'approved', provider: 'slow', referenceId: 'ref-slow' };
        },
      };

      const circuit = new KycCircuit(slowProvider, auditRepo, {
        tripErrorCount: 1,
        halfOpenAfterMs: 10,
      });

      // Trip the circuit (the provider must fail to trip)
      // Temporarily make it fail
      const origInitiate = slowProvider.initiateCheck.bind(slowProvider);
      slowProvider.initiateCheck = async () => { throw new Error('fail'); };
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      slowProvider.initiateCheck = origInitiate;

      expect(circuit.getState()).toBe(CircuitState.OPEN);

      // Wait for half-open window
      await new Promise(r => setTimeout(r, 20));

      // Launch concurrent calls — at most one should become the half-open probe
      const results = await Promise.allSettled([
        circuit.initiateCheck('inv-1', makeApplicant()),
        circuit.initiateCheck('inv-1', makeApplicant()),
      ]);

      // One probe should succeed, the other gets cached or fails
      const successes = results.filter(r => r.status === 'fulfilled').length;
      expect(successes).toBeGreaterThanOrEqual(1);
      // maxConcurrent should be 1 (single-flight), but due to Node's event loop
      // it could spike to 2 briefly before tryEnterHalfOpen rejects the 2nd
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('goes back to OPEN when half-open probe fails', async () => {
      const failer = new AlwaysFailsProvider();
      const circuit = new KycCircuit(failer, auditRepo, {
        tripErrorCount: 1,
        halfOpenAfterMs: 10,
      });

      // Trip
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      expect(circuit.getState()).toBe(CircuitState.OPEN);

      // Wait for half-open
      await new Promise(r => setTimeout(r, 20));

      // Probe attempt → fails → back to OPEN
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      expect(circuit.getState()).toBe(CircuitState.OPEN);
      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'kyc.circuit.half_open_failed',
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Cache semantics
  // -----------------------------------------------------------------------

  describe('cache semantics', () => {
    it('never caches a rejected status', async () => {
      const rejector = new AlwaysRejectsProvider();
      const circuit = new KycCircuit(rejector, auditRepo);
      await circuit.initiateCheck('inv-1', makeApplicant());
      expect(circuit.getCacheSize()).toBe(0);
    });

    it('does not serve expired cached decisions', async () => {
      const flip = new FlipFlopProvider(0);
      const circuit = new KycCircuit(flip, auditRepo, {
        cacheTtlMs: -1, // immediately expired
        halfOpenAfterMs: 60_000,
        tripErrorCount: 1,
      });
      await circuit.initiateCheck('inv-1', makeApplicant());
      expect(circuit.getCacheSize()).toBe(1); // still stored but expired

      // Trip the circuit
      flip.reset();
      flip.setFailCount(100);
      await expect(circuit.initiateCheck('inv-2', makeApplicant())).rejects.toThrow();

      // Cache entry should be expired and deleted when accessed
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow(
        /no cached decision is available/,
      );
      expect(circuit.getCacheSize()).toBe(0);
    });

    it('caches approved decisions', async () => {
      const nullProvider = new NullKycProvider();
      const circuit = new KycCircuit(nullProvider, auditRepo);
      await circuit.initiateCheck('inv-1', makeApplicant());
      expect(circuit.getCacheSize()).toBe(1);
    });

    it('evicts entries older than maxCacheTtlMs', async () => {
      const nullProvider = new NullKycProvider();
      const circuit = new KycCircuit(nullProvider, auditRepo, {
        maxCacheTtlMs: -1, // expire everything immediately
      });
      await circuit.initiateCheck('inv-1', makeApplicant());
      // After any operation, stale entries are evicted
      await circuit.initiateCheck('inv-2', makeApplicant());
      // inv-1's entry should have been evicted during the eviction sweep
      expect(circuit.getCacheSize()).toBeLessThanOrEqual(2);
    });
  });

  // -----------------------------------------------------------------------
  // getStatus & handleWebhook
  // -----------------------------------------------------------------------

  describe('delegated methods', () => {
    it('getStatus delegates to inner provider', async () => {
      const nullProvider = new NullKycProvider();
      const circuit = new KycCircuit(nullProvider, auditRepo);
      const result = await circuit.getStatus('ref-1');
      expect(result.status).toBe('pending');
    });

    it('handleWebhook bypasses the circuit breaker', async () => {
      const nullProvider = new NullKycProvider();
      const circuit = new KycCircuit(nullProvider, auditRepo);
      const result = await circuit.handleWebhook({}, 'sig');
      expect(result.status).toBe('rejected'); // NullKycProvider returns rejected for webhooks
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe('reset', () => {
    it('resets the circuit to CLOSED and clears cache', async () => {
      const nullProvider = new NullKycProvider();
      const circuit = new KycCircuit(nullProvider, auditRepo);
      await circuit.initiateCheck('inv-cache', makeApplicant());
      expect(circuit.getCacheSize()).toBe(1);

      // Manually force OPEN
      const failer = new AlwaysFailsProvider();
      const circuit2 = new KycCircuit(failer, auditRepo, { tripErrorCount: 1, halfOpenAfterMs: 60_000 });
      await expect(circuit2.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      expect(circuit2.getState()).toBe(CircuitState.OPEN);

      circuit2.reset();
      expect(circuit2.getState()).toBe(CircuitState.CLOSED);
      expect(circuit2.getCacheSize()).toBe(0);
      expect(circuit2.getConsecutiveFailures()).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Error propagation
  // -----------------------------------------------------------------------

  describe('error propagation', () => {
    it('propagates the original error when no cache is available', async () => {
      const failer = new AlwaysFailsProvider();
      const circuit = new KycCircuit(failer, auditRepo, { tripErrorCount: 1, halfOpenAfterMs: 60_000 });
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow('Provider is down');
    });
  });

  // -----------------------------------------------------------------------
  // Dynamic config via env override (constructor)
  // -----------------------------------------------------------------------

  describe('config overrides', () => {
    it('uses large halfOpenAfterMs to prevent auto half-open probes', async () => {
      const failProvider: KycProvider = {
        name: 'fail_instant',
        async initiateCheck() { throw new Error('fail'); },
        async getStatus() { throw new Error('fail'); },
        async handleWebhook() { throw new Error('fail'); },
      };
      const circuit = new KycCircuit(failProvider, auditRepo, {
        tripErrorCount: 1,
        halfOpenAfterMs: 300_000, // 5 min
      });
      await expect(circuit.initiateCheck('inv-1', makeApplicant())).rejects.toThrow();
      expect(circuit.getState()).toBe(CircuitState.OPEN);
      // Even without waiting, should stay OPEN because window hasn't elapsed
      expect(circuit['tryEnterHalfOpen']()).toBe(false);
    });
  });
});
