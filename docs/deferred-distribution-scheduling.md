# Deferred Distribution Scheduling

Operators can queue a specific distribution run at a future settlement window and
have the `DistributionScheduler` honor it idempotently, instead of only firing on
cron ticks.

## Overview

A new `scheduled_distributions` table acts as a deferred queue:

- An **admin** enqueues a run for `(offering_id, period_id)` with a `run_at`
  timestamp, an amount, and an optional snapshot boundary
  (`period_start` / `period_end`).
- The scheduler tick calls `processScheduledDistributions()` which picks due rows
  (`run_at <= now`), claims each atomically, and dispatches them through
  `DistributionEngine.distribute(offering_id, period, amount)`.
- Completed runs are marked `completed` and are never picked again, including
  after a restart.

## Data model

Migration: `src/db/migrations/021_create_scheduled_distributions.sql`

| Column          | Type            | Notes                                              |
| --------------- | --------------- | -------------------------------------------------- |
| `id`            | UUID PK         | `gen_random_uuid()`                                |
| `offering_id`   | UUID FK         | references `offerings(id)` (cascade delete)        |
| `period_id`     | UUID            | engine idempotency key                             |
| `period_start`  | timestamptz     | snapshot boundary start (falls back to `run_at`)   |
| `period_end`    | timestamptz     | snapshot boundary end (falls back to `run_at`)     |
| `total_amount`  | numeric(30,10)  | revenue amount to distribute (`> 0`)               |
| `run_at`        | timestamptz     | when the run becomes due                           |
| `status`        | varchar(50)     | `scheduled` / `processing` / `completed` / `failed` / `cancelled` |
| `attempts`      | integer         | incremented on each claim                          |
| `error_message` | text            | sanitized failure summary only                     |
| `created_by`    | UUID            | operator who enqueued the run                      |
| `executed_at`   | timestamptz     | set on completion                                  |
| `created_at` / `updated_at` | timestamptz | audit timestamps                           |

**Unique constraint:** `UNIQUE (offering_id, period_id)` — duplicate enqueue of
the same period is rejected (409) so a period can never be double-scheduled.

## Scheduler behaviour

`DistributionScheduler.processScheduledDistributions(now?)` (in
`src/services/distributionScheduler.ts`):

1. `findDueScheduledDistributions(now, leaseMs, catchupMax)` returns:
   - `status = 'scheduled' AND run_at <= now`
   - stale `status = 'processing'` rows whose `updated_at` is older than the
     lease (default 15 minutes) — a scheduler that crashed mid-run.
2. For each row, `claimScheduledDistribution(id, leaseMs)` atomically flips
   `scheduled → processing` (or reclaims a stale `processing` row) and bumps
   `attempts`. A row already claimed by another scheduler returns `null` and is
   skipped.
3. The engine runs with the stored snapshot boundary; on success the row is
   marked `completed`, on failure `failed` with a sanitized
   `Distribution failed: <CLASS>` message.

### Idempotency across restarts

- `completed` rows are never returned by the due query, so backfill skips
  already-executed rows.
- A `processing` row left behind by a crash is only reclaimed after the lease.
  When re-run, the engine's `findRunByParams(offeringId, periodId, amount)`
  short-circuits an already-completed run and returns the cached result, after
  which the scheduler marks the row `completed`.
- Duplicate enqueue is impossible at the table level.

## Admin endpoints

Router: `src/routes/distributions.ts` (`createDistributionsRouter`). All three
endpoints are **admin-only** (`user.role === 'admin'`).

| Method   | Path                              | Description                                   |
| -------- | --------------------------------- | --------------------------------------------- |
| `POST`   | `/api/v1/distributions/schedule`  | Enqueue a deferred run (201; 409 on duplicate)|
| `GET`    | `/api/v1/distributions/schedule`  | List runs, optional `?offering_id=` filter    |
| `DELETE` | `/api/v1/distributions/schedule/:id` | Cancel a pending (`scheduled`) run (404 if not cancellable) |

### Enqueue payload

```json
{
  "offering_id": "…",
  "period_id": "…",
  "run_at": "2026-08-01T00:00:00Z",
  "total_amount": 1000,
  "period_start": "2026-06-01T00:00:00Z",
  "period_end": "2026-07-01T00:00:00Z"
}
```

Validation: `offering_id`/`period_id` required, `run_at` a valid date,
`total_amount > 0`, and `period_end > period_start` when both are provided.
Past-dated `run_at` is allowed so operators can backfill a settlement window; the
scheduler picks it up on the next tick. The offering must exist (404 otherwise).

## Security & failure modes

- **Authorization:** schedule/list/cancel require the `admin` role; non-admins
  receive 403.
- **Data integrity:** claim is a single atomic `UPDATE ... WHERE status = …`
  guarded statement; no partial reads.
- **Failure isolation:** a failed engine run never aborts the tick — the row is
  marked `failed` with a sanitized error and the loop continues.
- **No secret/raw error leakage:** only the Stellar RPC failure class is
  persisted to `error_message`.
- **Resource bounds:** each tick processes at most `catchupMax` (default 50) due
  rows.

## Repository

`ScheduledDistributionRepository`
(`src/db/repositories/scheduledDistributionRepository.ts`) exposes
`create`, `findDueScheduledDistributions`, `claimScheduledDistribution`,
`markCompleted`, `markFailed`, `markCancelled`, `findById`, `findByOffering`, and
`findAll`.

## Tests

- `src/db/repositories/scheduledDistributionRepository.test.ts` — 100% coverage
  (create + duplicate conflict, due/lease query, claim, complete/fail/cancel,
  id/byl-offering/all lookups, null paths).
- `src/services/distributionScheduler.test.ts` — `processScheduledDistributions`
  happy path, snapshot-boundary fallback, skip-already-claimed, sanitized failure,
  `markFailed` throw, invalid amount, missing repo no-op, custom lease.
- `src/routes/__tests__/distributions.test.ts` — enqueue (201 / 400 / 403 / 404 /
  409), list (with and without filter), cancel (200 / 404 / 403).

Run targeted tests:

```bash
npm test -- src/db/repositories/scheduledDistributionRepository.test.ts src/services/distributionScheduler.test.ts src/routes/__tests__/distributions.test.ts
```
