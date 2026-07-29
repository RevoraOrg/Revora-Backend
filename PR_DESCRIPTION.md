# feat: KYC provider circuit breaker with cached decision fallback and audit trail

**Closes #489**

## Summary

Adds a production-grade **circuit breaker** (`KycCircuit`) in front of the KYC provider adapter that gracefully handles vendor degradation. When the KYC vendor fails consecutively, the circuit trips **OPEN** and serves cached non-negative decisions (if available and fresh). Half-open probes are **single-flight** to prevent thundering herd.

## Changes

### New files

| File | Purpose |
|------|---------|
| `src/services/kyc/kycCircuitBreaker.ts` | `KycCircuit` class — implements `KycProvider` as a decorator wrapping any provider with circuit breaker logic |
| `src/services/kyc/__tests__/kycCircuitBreaker.test.ts` | 27 tests covering all states, edge cases, security invariants |

### Modified files

| File | Change |
|------|--------|
| `src/config/env.ts` | Added `KYC_CIRCUIT_TRIP_ERRORS`, `KYC_CIRCUIT_CACHE_TTL_MS`, `KYC_CIRCUIT_HALF_OPEN_MS` env var schemas |

## Design

### State machine

```
CLOSED ──(tripErrorCount consecutive failures)──▶ OPEN
  ▲                                                   │
  │                  (halfOpenAfterMs elapsed)         │
  │                        │                          │
  │                        ▼                          │
  │                   HALF_OPEN  ──(probe fails)──────▶
  │                        │
  └──(probe succeeds)──────┘
```

### Security invariants

1. **Never cache `rejected` decisions** — a denied KYC result is never served as a cached positive fallback
2. **Degraded-mode audit trail** — every cached fallback is recorded as a `SECURITY_VIOLATION` audit event with `action: kyc.circuit.degraded_fallback`
3. **Single-flight half-open probes** — `tryEnterHalfOpen()` atomically checks and sets `halfOpenInFlight` to prevent thundering herd
4. **Bounded cache TTL** — default 5-minute TTL, absolute 15-minute max eviction
5. **Circuit trip audit** — tripping and probe failures emit separate audit events

### Metrics

- `kyc.circuit.state` — gauge (0=CLOSED, 1=HALF_OPEN, 2=OPEN)
- `kyc.circuit.failure` — counter (per provider, per state)

### Configuration (via environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `KYC_CIRCUIT_TRIP_ERRORS` | `3` | Consecutive failures before circuit trips |
| `KYC_CIRCUIT_CACHE_TTL_MS` | `300000` (5 min) | How long a cached decision is considered fresh |
| `KYC_CIRCUIT_HALF_OPEN_MS` | `30000` (30 s) | Wait time before attempting a half-open probe |

## Usage

```typescript
const circuit = new KycCircuit(
  underlyingProvider,          // Any KycProvider implementation
  securityAuditRepository,     // SecurityAuditRepository
  { tripErrorCount: 5 },       // Optional config overrides
);

// Use circuit anywhere a KycProvider is expected:
const result = await circuit.initiateCheck(investorId, applicantInfo);
```

## Testing

- **60 KYC-related tests pass** (27 new circuit breaker + 33 existing)
- No regressions in existing KYC router or risk-tier service tests
- Edge cases covered: expired cache, rejected cache blacklist, concurrent half-open probes, error propagation

## Security review

The circuit breaker decorator is stateless with respect to the caller and can be safely wrapped around any `KycProvider` instance. Audit events are fire-and-forget with `.catch(() => {})` — audit failures never block the KYC flow. Cache entries are keyed by investor ID and silently evicted after the max TTL.
