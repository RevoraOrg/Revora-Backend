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
  UPDATE ... SET status = 'dispatching', locked_until = ...
    WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING *
  deliver to endpoints (with stable event_id)
  UPDATE ... SET status = 'dispatched' WHERE lease_token = ... AND locked_until > NOW()
```

## Components

### `029_create_webhook_outbox.sql` and `061_add_webhook_outbox_leases.sql`

Creates the `webhook_outbox` table:

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Row identity |
| `event_id` | UUID UNIQUE | Stable idempotency key forwarded to receivers |
| `event_type` | TEXT | Webhook event type (e.g. `payout.completed`) |
| `payload` | JSONB | Event data |
| `status` | TEXT | `pending` → `dispatching` → `dispatched`, `pending` (retry), or `failed` |
| `attempts` | INTEGER | Delivery attempt count |
| `available_at` | TIMESTAMPTZ | Earliest time the dispatcher may claim this row |
| `locked_until` | TIMESTAMPTZ nullable | Expiry of the current claim, measured by the database clock |
| `lease_token` | UUID nullable | Claim identity; replaced on every reclaim and cleared on completion |

Partial indexes on pending `available_at` and dispatching `locked_until` support ready work and expired-lease recovery.

### `OutboxRepository` (`src/db/repositories/outboxRepository.ts`)

- `insert(input, client?)` — inserts a row. Pass the transactional `PoolClient` to participate in the caller's transaction.
- `drainPending(limit, leaseMs)` — atomically leases ready pending or expired dispatching rows in one update. Defaults: 50 rows, 60,000 ms.
- `markDispatched(id, leaseToken)` — marks a row delivered only while the matching lease is unexpired.
- `markFailed(id, leaseToken, retryAfter?)` — releases the matching unexpired lease and increments attempts. It returns the row to `pending` at `retryAfter`, or marks it `failed`. Stale completions are no-ops.
- `getOldestPending()` — measures ready work, including expired recoverable leases, while excluding live leases and future retries.

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
`api` and `all`). Rows are claimed with an atomic update, so concurrent workers
cannot share an unexpired lease. `OutboxDispatcherOptions.leaseMs` sets the lease
duration; size it above the worst-case delivery time of the **entire sequential
batch**, or reduce `batchSize`. Leases are not renewed automatically.

```bash
OUTBOX_DISPATCHER_ENABLED=true npm start
```

## Idempotency on the Receiver

The `event_id` from the outbox row is forwarded as the webhook payload `id` field on every delivery attempt. The receiver's `webhookEventOrdering` middleware reads `event.id` as the `eventId` and uses sequence-based deduplication to reject events it has already processed. Because the `event_id` is stable, the receiver sees the same identity on every retry and can safely deduplicate.

## Failure Modes Addressed

| Scenario | Behaviour |
|----------|-----------|
| Crash between DB commit and emit | Outbox row survives; dispatcher retries on next poll |
| Dispatcher crash mid-delivery | Row stays `dispatching` until its lease expires; a later poll reclaims it with the same `event_id` |
| Transient 5xx from endpoint | `markFailed` with exponential `retryAfter`; row retried |
| Permanent 4xx from endpoint | After `maxAttempts`, row is dead-lettered (`status = 'failed'`) |
| Two dispatcher workers racing | Atomic claim/update ensures only one active lease per row |
| Producer transaction rollback | Outbox row is rolled back atomically; no phantom event |

## Security Notes

- The outbox table stores raw event payloads. Ensure DB access is restricted to the application role.
- `event_id` is a UUID v4 generated by `crypto.randomUUID()` — not guessable.
- Webhook signatures (`HMAC-SHA256`) are computed at delivery time by the dispatcher, not stored in the outbox.
- Delivery remains **at least once**, not exactly once. A crash after sending but before acknowledging, or processing that outlives its lease, can cause redelivery. Receivers must deduplicate by stable `event_id`. Claim tokens fence database updates, not an already-running external HTTP request.
- Deploy migration 061 before the new workers. Stop/drain old dispatcher instances before enabling the new version: old workers do not respect lease ownership. Rolling back workers requires stopping all dispatchers first and handling active leases; do not run old and new claiming protocols together.
- Lease metadata is internal and does not change webhook signatures or payloads. Status and lease constraints prevent partially populated claims.

## Concurrency regression tests

Run `npx jest --runInBand --coverage=false --runTestsByPath src/db/repositories/outboxRepository.integration.test.ts`. With Docker available, the suite starts PostgreSQL 16 via testcontainers. Alternatively set `OUTBOX_TEST_DATABASE_URL` to a disposable PostgreSQL database; the suite creates/drops its own randomly named schema and never reads the application `DATABASE_URL`. Without either, it reports that the integration suite is skipped. CI supplies a PostgreSQL service so these assertions run.

The blocked-delivery test holds worker A after its claim commits and starts worker B on a separate pool connection. It fails on master because B dispatches the same row. Additional checks cover simultaneous batches, locked-row skipping, crash reclamation, expired and superseded completions, delayed retries, dead-lettering, and lag. A legacy-query test retains the original autocommit failure as an executable demonstration.
