# Scheduler Jitter / Anti-Thundering-Herd

## Problem
When multiple offering distribution ticks are scheduled at the same wall-clock time, all workers fire simultaneously, causing:
- Database connection pool exhaustion
- Rate-limit contention on external APIs
- Uneven system load with burst/starve pattern

## Solution: Jittered Scheduling

### Implementation
```typescript
interface SchedulerConfig {
  /** Base cron expression for the tick */
  cronExpression: string
  /** Maximum random delay in milliseconds (default: 5000) */
  maxJitterMs: number
  /** Minimum spacing between ticks in ms to avoid herd (default: 1000) */
  minSpacingMs: number
}

class JitteredScheduler {
  private offeringTicks: Map<string, ScheduledTick>
  private jitterProvider: () => number // injectable for testing

  constructor(config: SchedulerConfig) {
    this.jitterProvider = () => Math.floor(Math.random() * config.maxJitterMs)
  }

  async scheduleTick(offeringId: string, handler: () => Promise<void>): Promise<void> {
    const jitter = this.jitterProvider()
    setTimeout(async () => {
      await handler()
    }, jitter)
  }

  async scheduleMultiOffering(offeringIds: string[], handler: (id: string) => Promise<void>): Promise<void> {
    // Stagger ticks to avoid thundering herd
    for (let i = 0; i < offeringIds.length; i++) {
      const stagger = i * this.config.minSpacingMs
      const jitter = this.jitterProvider()
      setTimeout(async () => {
        await handler(offeringIds[i])
      }, stagger + jitter)
    }
  }
}
```

### Benefits
- **Reduced DB contention**: Staggered writes avoid lock contention
- **Predictable load**: Even CPU/memory utilization across tick windows
- **Resilience**: Jitter prevents cascading failures from simultaneous retries

### Testing
- **Deterministic jitter**: Inject fixed jitter provider for reproducible tests
- **Concurrency stress**: Test with 100+ offerings at same cron tick
- **Recovery**: Verify jittered retry on failure
