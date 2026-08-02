# Scheduler Jitter Test Plan

## Unit Tests
- [ ] `JitteredScheduler.scheduleTick()` respects maxJitterMs bound
- [ ] `JitteredScheduler.scheduleMultiOffering()` respects minSpacingMs between ticks
- [ ] Jitter provider is injectable for deterministic testing
- [ ] Negative jitter values are clamped to 0
- [ ] Zero maxJitterMs produces immediate execution (no delay)

## Integration Tests
- [ ] 50 simultaneous offering ticks with 5s maxJitter complete within maxJitterMs + tolerance
- [ ] No two ticks fire within minSpacingMs of each other
- [ ] Database connection pool never exceeds max during jittered batch

## Stress Tests
- [ ] 200 offerings at same cron tick complete without connection exhaustion
- [ ] Jittered scheduler recovers from handler failure without affecting other ticks
