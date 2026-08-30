# Transactional Outbox for Webhook Events

## Problem

`WebhookService.emit()` is fire-and-forget and runs **outside** the database transaction that produced the domain change. This creates two failure modes:

1. **Lost event** — a crash between the DB commit and the `emit()` call drops the event permanently.
2. **Duplicate with different id** — a retry after a transient delivery failure calls `emit()` again, generating a new `randomUUID()` payload id, so the receiver cannot deduplicate.

## Solution

The transactional outbox pattern captures events **atomically** with the domain change that produced them. A separate dispatcher process drains the outbox and delivers events to webhook endpoints.

```
Producer transaction:
  BEGIN
    INSERT INTO domain_table ...
    INSERT INTO webhook_outbox (event_id, event_type, payload) ...   ← atomic
  COMMIT

Dispatcher (separate process):
  SELECT ... FOR UPDATE SKIP LOCKED   ← claim rows
  deliver to endpoints (with stable event_id)
  UPDATE webhook_outbox SET status = 'dispatched'
```

## Components

### `014_create_webhook_outbox.sql`

Creates the `webhook_outbox` table:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Row identity |
| `event_id` | UUID UNIQUE | Stable idempotency key forwarded to receivers |
| `event_type` | TEXT | Webhook event type (e.g. `payout.completed`) |
| `payload` | JSONB | Event data |
| `status` | TEXT | `pending` → `dispatched` or `failed` |
| `attempts` | INTEGER | Delivery attempt count |
| `available_at` | TIMESTAMPTZ | Earliest time the dispatcher may claim this row |

A partial index on `(available_at) WHERE status = 'pending'` keeps dispatcher polls fast.

### `OutboxRepository` (`src/db/repositories/outboxRepository.ts`)

- `insert(input, client?)` — inserts a row. Pass the transactional `PoolClient` to participate in the caller's transaction.
- `drainPending(limit)` — claims up to `limit` pending rows using `SELECT … FOR UPDATE SKIP LOCKED`.
- `markDispatched(id)` — marks a row delivered.
- `markFailed(id, retryAfter?)` — records a failed attempt; if `retryAfter` is given the row stays `pending` and becomes available again at that time, otherwise it is dead-lettered.

### `WebhookService.emitToOutbox()` (`src/services/webhookService.ts`)

```typescript
const eventId = await webhookService.emitToOutbox(client, event, data);
```

Writes an outbox row inside the caller's transaction. Returns the stable `event_id`. Requires `outboxRepo` to be passed in `WebhookServiceOptions`.

`WebhookService.emit()` is also transactional-capable: pass the producing transaction's `PoolClient` as the third argument and the event is written to the outbox atomically instead of being fire-and-forgotten:

```typescript
await withTransaction(pool, async (client) => {
  await client.query('UPDATE payouts SET status = $1', ['completed']);
  await webhookService.emit(
    WebhookEventType.PAYOUT_COMPLETED,
    { payout_id: 'p-1' },
    client, // ← atomic capture inside the producing transaction
  );
});
```

`emit(event, data, client)` throws when `client` is given but the service has no `outboxRepo` (fail-closed), so an event is never silently emitted outside the transaction. The legacy two-argument `emit(event, data)` keeps its fire-and-forget behaviour for backward compatibility.

**Usage inside a producing transaction:**

```typescript
await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO payouts ...', [...]);
  await webhookService.emitToOutbox(client, WebhookEventType.PAYOUT_COMPLETED, {
    investor_id: '...',
    amount: '100.00',
  });
});
// Both the payout row and the outbox row commit or roll back together.
```

For producers that emit several events, `transaction.ts` exposes
`enqueueWebhookOutboxEvents(client, outboxRepo, events)` which inserts a batch
of outbox rows through the same transactional client and returns their
`event_id`s. If the surrounding transaction rolls back, all of those rows are
discarded with it.

### `OutboxDispatcher` (`src/services/outboxDispatcher.ts`)

Polls `webhook_outbox` on a configurable interval and hands each row to a `DispatchFn`.

```typescript
const dispatcher = new OutboxDispatcher(outboxRepo, dispatchFn, {
  batchSize: 50,      // rows per poll cycle
  intervalMs: 5000,   // ms between cycles
  maxAttempts: 5,     // dead-letter after this many failures
  retryBaseMs: 1000,  // exponential back-off base
});
dispatcher.start();
```

`makeWebhookDispatchFn(processDelivery, listActiveByEvent)` builds a `DispatchFn` that:
1. Looks up active endpoints subscribed to the event type.
2. Constructs the webhook payload with `id: row.event_id` (stable across retries).
3. Calls `processDelivery` for each endpoint.

### `WebhookQueue` idempotency-key propagation (`src/index.ts`)

`WebhookQueue` is the durable delivery layer the outbox hands rows to. When the
payload passed to `processDelivery` carries an `id` — the outbox `event_id` —
that id is forwarded verbatim as the delivered payload `id`. This guarantees
the receiver's `webhookEventOrdering` middleware sees the **same** `event_id`
on every retry of the same outbox row, even when a crash forces the dispatcher
to start a fresh delivery row. Payloads without an `id` (legacy producers) fall
back to the delivery row id, preserving prior behaviour.

### Running the dispatcher

The drain worker runs out of process from the producer. In production it is
started with `WebhookQueue` by setting `OUTBOX_DISPATCHER_ENABLED=true` (roles
`api` and `all`). Rows are claimed with `SELECT … FOR UPDATE SKIP LOCKED`, so
multiple worker instances never process the same row twice.

```bash
OUTBOX_DISPATCHER_ENABLED=true npm start
```

## Idempotency on the Receiver

The `event_id` from the outbox row is forwarded as the webhook payload `id` field on every delivery attempt. The receiver's `webhookEventOrdering` middleware reads `event.id` as the `eventId` and uses sequence-based deduplication to reject events it has already processed. Because the `event_id` is stable, the receiver sees the same identity on every retry and can safely deduplicate.

## Failure Modes Addressed

| Scenario | Behaviour |
|----------|-----------|
| Crash between DB commit and emit | Outbox row survives; dispatcher retries on next poll |
| Dispatcher crash mid-delivery | Row stays `pending`; next poll retries with same `event_id` |
| Transient 5xx from endpoint | `markFailed` with exponential `retryAfter`; row retried |
| Permanent 4xx from endpoint | After `maxAttempts`, row is dead-lettered (`status = 'failed'`) |
| Two dispatcher workers racing | `SKIP LOCKED` ensures each row is claimed by exactly one worker |
| Producer transaction rollback | Outbox row is rolled back atomically; no phantom event |

## Security Notes

- The outbox table stores raw event payloads. Ensure DB access is restricted to the application role.
- `event_id` is a UUID v4 generated by `crypto.randomUUID()` — not guessable.
- Webhook signatures (`HMAC-SHA256`) are computed at delivery time by the dispatcher, not stored in the outbox.
- `SKIP LOCKED` prevents lock contention between dispatcher workers; it does not prevent a single worker from processing a row multiple times if it crashes after claiming but before marking dispatched. The stable `event_id` on the receiver side handles this case.
