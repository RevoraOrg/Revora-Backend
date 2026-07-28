/**
 * Outbox Lag Saturation Alerts with Backpressure
 * 
 * This document describes the implementation of outbox lag monitoring,
 * saturation alerts, and backpressure signaling for the OutboxDispatcher.
 */

# Outbox Lag Saturation Alerts with Backpressure

## Overview

The `OutboxDispatcher` now monitors the age of pending outbox records and emits saturation alerts with escalating severity tiers. When saturation is detected, backpressure signals are available via the `PressureGauge` to allow producers to pause event emission.

## Components

### 1. PressureGauge (`src/lib/pressureGauge.ts`)

A thread-safe backpressure signaling mechanism that implements escalating severity tiers:

- **NORMAL**: No lag, system operating nominally
- **INFO**: Lag building (default: > 30 seconds), monitor closely
- **WARNING**: Significant lag (default: > 60 seconds), producers should slow down
- **CRITICAL**: Severe lag (default: > 120 seconds), producers must pause

#### Key Features

- **Hysteresis**: Uses recovery buffers (default: 15 seconds) when descending tiers to prevent rapid oscillations
- **State Callbacks**: External systems can register callbacks to react to tier transitions
- **Thread-Safe**: All state transitions are atomic and immutable copies are returned

#### Usage

```typescript
import { PressureGauge, PressureTier } from '../lib/pressureGauge';

const gauge = new PressureGauge({
  infoThresholdSeconds: 30,
  warningThresholdSeconds: 60,
  criticalThresholdSeconds: 120,
  recoveryBufferSeconds: 15,
});

gauge.onStateChange((oldState, newState) => {
  if (newState.tier === PressureTier.CRITICAL) {
    console.log('CRITICAL: Pause producers immediately!');
  }
});

// Update with current lag measurement (in seconds)
gauge.updateLag(45);

// Query current state
const tier = gauge.getTier(); // PressureTier.INFO
const isUnderPressure = gauge.isAtLeast(PressureTier.WARNING); // false
```

### 2. OutboxDispatcher Enhancements (`src/services/outboxDispatcher.ts`)

Enhanced the existing dispatcher with lag monitoring and backpressure integration:

#### New Capabilities

1. **Lag Measurement**: 
   - Measures age of oldest pending record on each drain cycle
   - Emits `outbox_lag_seconds` gauge metric
   - Gracefully handles no pending records (lag = -1)

2. **Pressure Gauge Integration**:
   - Integrated `PressureGauge` instance
   - Updates gauge with measured lag
   - Listens to pressure state changes

3. **Alert Emission**:
   - Emits `outbox_pressure_tier_transitions` counter
   - Emits `outbox_saturation_alerts` counter with severity labels
   - Logs alerts to console with lag deltas

4. **Backpressure Signals**:
   - Public API: `getPressureTier()`, `isUnderPressure()`
   - External consumers can check pressure state
   - `onPressureStateChange()` allows registration of pressure callbacks

#### Usage

```typescript
import { OutboxDispatcher, PressureTier } from '../services/outboxDispatcher';

const dispatcher = new OutboxDispatcher(repo, dispatchFn, {
  pressureConfig: {
    infoThresholdSeconds: 30,
    warningThresholdSeconds: 60,
    criticalThresholdSeconds: 120,
  },
  metrics, // Optional: custom MetricsCollector
});

dispatcher.start();

// Producers can check pressure before emitting
if (dispatcher.isUnderPressure(PressureTier.CRITICAL)) {
  // Reject or defer new events
}

// Or register for pressure change notifications
dispatcher.onPressureStateChange((oldState, newState) => {
  if (newState.tier === PressureTier.CRITICAL) {
    pauseProducers();
  } else if (oldState.tier === PressureTier.CRITICAL && newState.tier !== PressureTier.CRITICAL) {
    resumeProducers();
  }
});
```

### 3. OutboxRepository Enhancement (`src/db/repositories/outboxRepository.ts`)

Added `getOldestPending()` method:

```typescript
async getOldestPending(): Promise<OutboxRow | null> {
  // Returns the oldest pending record without claiming it (no SKIP LOCKED)
  // Used purely for lag measurement
}
```

## Metrics

### Emitted Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `outbox_lag_seconds` | Gauge | `status` (normal/pending) | Age of oldest unsent record in seconds |
| `outbox_pressure_tier_transitions` | Counter | `from`, `to` | Transitions between pressure tiers |
| `outbox_saturation_alerts` | Counter | `severity`, `tier` | Saturation alerts by severity level |

### Query Examples (Prometheus)

```promql
# Current outbox lag
outbox_lag_seconds{status="pending"}

# Alert frequency by severity
rate(outbox_saturation_alerts[5m]) by (severity)

# Tier transition rate
rate(outbox_pressure_tier_transitions[5m])
```

## Hysteresis Behavior

Hysteresis prevents rapid oscillations when lag fluctuates around thresholds:

### Climbing (using normal thresholds)
- NORMAL → INFO when lag ≥ 30s
- INFO → WARNING when lag ≥ 60s
- WARNING → CRITICAL when lag ≥ 120s

### Descending (using recovery thresholds)
- CRITICAL → WARNING when lag < (120 - 15) = 105s
- WARNING → INFO when lag < (60 - 15) = 45s
- INFO → NORMAL when lag < (30 - 15) = 15s

Example:
```
Initial: NORMAL
Lag climbs to 35s → INFO tier (lag ≥ 30)
Lag drops to 25s → stays INFO (still > 15 recovery threshold)
Lag drops to 14s → NORMAL tier (below 15 recovery threshold)
Lag rises to 35s → INFO tier again
```

## Security Assumptions

1. **Pressure state is process-local**: Each replica maintains its own gauge state. In multi-replica deployments, coordinate via external systems (e.g., Redis) if cluster-wide pressure decisions are needed.

2. **Lag measurement is read-only**: The `getOldestPending()` query doesn't claim or lock records, so concurrent drains and measurements never interfere.

3. **Metrics labels are sanitized**: Metric labels (e.g., severity, tier names) use only alphanumeric characters and underscores, preventing injection attacks.

4. **Failure isolation**: Lag measurement failures (database errors) are logged but don't stop the dispatcher. The last known pressure state is retained.

5. **Transactional consistency**: Lag measurement happens before draining, so the pressure state reflects conditions at the time of measurement, not after drain completion.

## Test Coverage

### PressureGauge Tests (src/lib/__tests__/pressureGauge.test.ts)

- Initialization and default configuration
- Tier transitions (climbing and descending)
- Hysteresis and recovery buffers
- State change callbacks
- Tier comparison operations (isAtLeast)
- Edge cases (zero lag, very large values, rapid fluctuations)
- State immutability

### OutboxDispatcher Lag Tests (src/services/__tests__/outboxDispatcher.test.ts)

- Lag measurement from oldest pending record
- Gauge metric emission
- Tier transitions in dispatcher context
- Pressure state change callbacks
- Pressure alert metrics
- Backward compatibility
- Hysteresis in drain loop

All tests use explicit thresholds and verify actual implementation behavior.

## Integration Points

### For Producers

Check pressure before emitting events:

```typescript
const outboxDispatcher = /* ... */;

async function emitEvent(event) {
  // Check critical pressure first
  if (outboxDispatcher.isUnderPressure(PressureTier.CRITICAL)) {
    return { success: false, reason: 'system under critical backpressure' };
  }

  // Proceed with event emission
  return await eventService.emit(event);
}
```

### For Monitoring

Query metrics to understand outbox health:

```typescript
// Grafana/Prometheus dashboard
- Graph: `outbox_lag_seconds` over time
- Heatmap: `rate(outbox_saturation_alerts[5m])` by severity
- Stat: Current tier from pressure gauge state
```

### For Operations

Alert when entering CRITICAL or WARNING tiers:

```yaml
# Example Prometheus alert rule
- alert: OutboxSaturationCritical
  expr: outbox_saturation_alerts{severity="critical"} > 0
  for: 2m
  annotations:
    summary: "Webhook outbox under critical backpressure"
```

## Performance Characteristics

- **Lag measurement**: Single database query per drain cycle (minimal overhead)
- **Pressure updates**: O(1) in-memory operation
- **Callback invocation**: Synchronous, avoid long-running operations
- **State transitions**: Only trigger callbacks on actual tier changes (no redundant callbacks)
- **Memory**: Constant space per dispatcher instance

## Future Enhancements

1. **Distributed pressure coordination**: Use Redis to aggregate pressure signals across replicas
2. **Adaptive thresholds**: Adjust thresholds based on historical lag patterns
3. **Automatic producer pause**: Direct integration with producer queues for automatic backpressure application
4. **Pressure trend analysis**: Emit metrics about pressure trajectory (e.g., "rapidly worsening")
