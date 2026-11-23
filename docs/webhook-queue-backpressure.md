# Webhook Queue Back-Pressure and Bounded Depth

## Overview

`WebhookQueue` in `src/index.ts` now enforces an upper bound on the number of
in-flight deliveries. When the queue is full, new deliveries are **persisted as
`deferred`** rather than dropped, ensuring zero event loss. A Prometheus-style
counter tracks every shed delivery.

## Configuration

| Variable                  | Default | Description                                              |
|---------------------------|---------|----------------------------------------------------------|
| `WEBHOOK_QUEUE_MAX_DEPTH` | `100`   | Maximum concurrent in-flight webhook deliveries allowed. |

Set the variable in your environment or `.env` file:

```
WEBHOOK_QUEUE_MAX_DEPTH=200
```

## Behaviour

### Normal path (below capacity)

```
processDelivery(url, payload)
  → inFlight < maxDepth
  → inFlight++
  → HTTP attempt via WebhookService.sendAttempt()
  → inFlight--  (always, via finally)
```

### Back-pressure path (at capacity)

```
processDelivery(url, payload[, deliveryId])
  → inFlight >= maxDepth
  → reuse existing row (when deliveryId is a retry) or
    repo.createDelivery({ status: 'deferred' })   ← persisted, never lost
  → globalMetrics.incrementCounter('webhook_queue_shed_total', { endpoint })
  → globalMetrics.setGauge('webhook_queue_depth', inFlight)
  → return false
```

The delivery row is written to `webhook_deliveries` with `status = 'deferred'`
before the function returns. The durable dispatcher can recover it at any time.

**Shedding is idempotent per delivery.** When a retried delivery (a `deliveryId`)
hits the queue at capacity, the *same* row is deferred in place — its attempt
count and `next_retry_at` are preserved and no duplicate row is inserted. If the
row is already `deferred`, no row mutation happens and the
`webhook_queue_shed_total` counter is **not** re-incremented, so retries cannot
inflate the shed metric.

### Recovery

Call `WebhookQueue.resumeDeferred()` to promote deferred rows back to `pending`
and re-enqueue them, or `WebhookQueue.resumePending()` for pending rows. Both
methods respect the current capacity limit — if the queue is still full, excess
rows remain in their current state and are picked up on the next resume cycle.

```typescript
// Example: run on a schedule or after a burst subsides
await WebhookQueue.resumeDeferred();
await WebhookQueue.resumePending();
```

## Metrics

| Metric name                  | Type    | Labels     | Description                                              |
|------------------------------|---------|------------|----------------------------------------------------------|
| `webhook_queue_shed_total`   | counter | `endpoint` | Total webhook deliveries deferred due to queue depth limit. Idempotent across retries of the same delivery. |
| `webhook_queue_depth`        | gauge   | (none)     | In-flight delivery count at the moment a delivery is shed. Provides a diagnosable view of how full the queue is. |
| `webhook_dead_letter_total`  | gauge   | `endpoint` | Current dead-letter count per endpoint (existing metric).|

Query example (Prometheus):

```promql
# Rate of shedding over the last 5 minutes
rate(webhook_queue_shed_total[5m])

# Endpoints with the most dead letters
topk(5, webhook_dead_letter_total)
```

## Security Assumptions

1. **No event loss** — deferred rows are written atomically before the function
   returns. A crash between the write and the counter increment is safe: the row
   is still recoverable; the counter may under-count by at most 1.
2. **No duplicate deliveries under back-pressure** — a retry that is shed at
   capacity defers its existing delivery row in place rather than inserting a
   fresh row, so `resumePending()` cannot later deliver a duplicate.
3. **SSRF protection is applied before the capacity check** — an unsafe URL is
   rejected before any database write occurs.
4. **`WEBHOOK_QUEUE_MAX_DEPTH` is validated at startup** by the Zod env schema
   (positive integer). An invalid value causes a fatal startup error.
5. **`inFlight` is a process-local counter.** In a multi-replica deployment each
   replica enforces its own limit. Set `WEBHOOK_QUEUE_MAX_DEPTH` per-replica
   accordingly, or use a distributed counter (Redis) for cluster-wide limits.

## Database

No schema migration is required. The `webhook_deliveries.status` column already
accepts arbitrary strings; the application-level TypeScript union type has been
extended to include `'deferred'`.

If you want a DB-level constraint, add `'deferred'` to the check constraint on
`webhook_deliveries.status`:

```sql
ALTER TABLE webhook_deliveries
  DROP CONSTRAINT IF EXISTS webhook_deliveries_status_check;

ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'dead_letter', 'deferred'));
```

## Files Changed

| File                                                    | Change                                                  |
|---------------------------------------------------------|----------------------------------------------------------|
| `src/config/env.ts`                                     | Added `WEBHOOK_QUEUE_MAX_DEPTH` (default `100`)         |
| `src/db/repositories/webhookEndpointRepository.ts`     | Added `'deferred'` to status union; `getDeferredDeliveries()` |
| `src/lib/metrics.ts`                                    | Added `WEBHOOK_QUEUE_SHED_TOTAL` / `WEBHOOK_QUEUE_DEPTH_GAUGE` name constants |
| `src/index.ts` — `WebhookQueue`                         | `inFlight` counter, idempotent back-pressure deferral, `_attempt()` helper, capacity-aware `resumeDeferred()`/`resumePending()` |
| `src/webhook.test.ts`                                   | Tests for deferral, metric increment, idempotent re-shed, capacity-aware resume |
