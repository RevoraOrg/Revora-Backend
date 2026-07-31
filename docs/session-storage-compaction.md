# Session Storage Compaction Job (#683)

## Problem

Revoked and expired session rows accumulate indefinitely in the `sessions`
table. Every expired browser session, every revoked token, and every stale
`deleteExpired()` candidate leaves a row behind. Over time these historical rows
bloat the table and the backups taken from it, slowing maintenance operations
and inflating storage cost. Unlike `deleteExpired()`, which only removes rows
whose `expires_at` has already passed, the system never cleaned rows that were
revoked long ago but whose original expiry is still far in the future.

## Solution

A nightly `SessionCompactionService` job deletes revoked and expired session
rows older than the configured retention window (default **30 days**), then
vacuum the table to reclaim space.

```
┌───────────────────┐   every 24h   ┌─────────────────────────────────────────┐
│  Scheduler        │ ─────────────►│  SessionCompactionService.runCompaction() │
│  (setInterval)    │               └─────────────────────────────────────────┘
└───────────────────┘                             │
                                          ┌──────▼──────┐
                                          │  1. lag     │  getOldestCompactedSessionDate()
                                          │  2. purge   │  purgeOlderThan() in bounded batches
                                          │  3. vacuum  │  vacuumSessions()
                                          └─────────────┘
```

### Files

| File | Role |
|---|---|
| `src/services/sessionCompactionService.ts` | Scheduled job: batches, cap, metrics |
| `src/db/repositories/sessionRepository.ts` | `purgeOlderThan`, `getOldestCompactedSessionDate`, `vacuumSessions` |
| `src/index.ts` | Wires the service into the app lifecycle |
| `src/config/env.ts` | `SESSION_RETENTION_DAYS`, `SESSION_COMPACTION_MAX_ROWS_PER_RUN` |

---

## How it works

1. **Boundary** — the retention boundary is `NOW() - SESSION_RETENTION_DAYS`,
   computed **inside the database**. The service never passes a server-computed
   timestamp to the purge query (see Security below).
2. **Lag** — before deleting, the service asks the repository for the oldest
   eligible row and records how far past the retention boundary it sits.
3. **Bounded batches** — rows are deleted with `DELETE ... WHERE id IN
   (SELECT id ... LIMIT $batchSize)`, so no single statement holds locks on
   more than `batchSize` (default 1000) rows.
4. **Per-run cap** — a single cycle stops after deleting
   `SESSION_COMPACTION_MAX_ROWS_PER_RUN` (default 100 000) rows. If the cap is
   hit, the run emits `session.compaction.cap_hit` and leaves the remainder for
   the next cycle.
5. **Vacuum** — if any rows were deleted, `VACUUM sessions` runs on its own
   connection (VACUUM cannot run inside a transaction block) to reclaim space.

### Configuration

| Env var | Default | Description |
|---|---|---|
| `SESSION_RETENTION_DAYS` | `30` | How many days an expired/revoked row is retained before it becomes eligible for deletion |
| `SESSION_COMPACTION_MAX_ROWS_PER_RUN` | `100000` | Hard cap on rows deleted per cycle |

---

## Metrics

Emitted via `MetricsCollector` when the service is constructed with one:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `session.compaction.rows` | counter | `status=success` | Total rows deleted in the run |
| `session.compaction.retention_lag_days` | histogram | `status=success` | Lag of the oldest eligible row behind the retention boundary |
| `session.compaction.duration_ms` | histogram | `status=success\|error` | Run duration |
| `session.compaction.errors_total` | counter | `status=error` | Failed runs |
| `session.compaction.cap_hit` | counter | `status=warning` | Run stopped because it hit the per-run row cap |

---

## Security Assumptions

1. **The retention boundary is always the database clock, never the app clock.**
   The purge query computes `NOW() - INTERVAL` inside Postgres. If the
   application-server clock jumps forward (a bad-clock event from NTP failure,
   host migration, or manual change), the boundary does not move, so the job
   cannot be tricked into deleting rows that have not actually aged past
   retention.
2. **Active rows can never match the predicate.** A session is only deleted
   when `expires_at < boundary` **or** `revoked_at < boundary`. An active
   session has a future `expires_at` and no `revoked_at`, so it satisfies
   neither branch. `deleteExpired()` (active-row sweep) and the compaction job
   are therefore safe to run concurrently.
3. **Blast radius is bounded.** Even in a pathological case where an enormous
   number of rows suddenly become eligible, the per-run cap stops the cycle at
   a fixed, recoverable number of rows and raises `session.compaction.cap_hit`
   so operators can investigate before the next nightly run.
4. **No lock amplification.** Bounded `LIMIT` batches keep individual DELETE
   statements short, avoiding long-held locks on the `sessions` table that
   could stall login/touch traffic.
5. **VACUUM is executed standalone.** It runs on its own connection, never
   inside a transaction block, which is a hard Postgres requirement.

### Failure / abuse paths

| Scenario | Behaviour |
|---|---|
| App clock jumps forward | Boundary is DB-computed → no extra rows become eligible; cap still protects |
| App clock jumps backward | Boundary moves backward → fewer rows eligible; safe |
| Huge backlog of eligible rows | Run hits `maxRowsPerRun`, emits `cap_hit`, resumes next cycle |
| DB unavailable | Run fails fast, emits `session.compaction.errors_total`, keeps the schedule alive |
| Duplicate concurrent runs | Both runs delete disjoint bounded batches idempotently; VACUUM is safe to run concurrently |
| `batchSize` / `maxRowsPerRun` misconfigured (≤ 0 or non-integer) | `runCompaction` throws before touching the DB |

---

## Tests

```bash
npx jest src/services/sessionCompactionService.test.ts src/db/repositories/sessionRepository.test.ts
```

Coverage highlights:

- Batched deletion stops on a partial batch and vacuums exactly once.
- No vacuum when nothing was deleted.
- Error paths emit `session.compaction.errors_total`.
- **Bad-clock safety** — the service passes retention *days* to the repository,
  never a server-derived `Date`; the repository SQL proves the boundary is
  `NOW() - interval` and that only `expires_at`/`revoked_at` are matched.
- **Cap enforcement** — a saturated table stops at the cap, truncates the last
  batch, and emits `session.compaction.cap_hit`; a draining table does not.
- Input validation rejects non-positive / non-integer batch and cap values.
- `start()`/`stop()` scheduling lifecycle.

---

## Related Files

| File | Role |
|---|---|
| `src/services/auditPurgeService.ts` | Parallel scheduled purge job for audit logs |
| `src/db/repositories/sessionRepository.ts` | Session storage repository |
| `src/lib/sessionStore.ts` | `PostgresSessionStore` (lazy expiry + sweep) |
| `docs/session-storage-partial-index.md` | Query-performance baseline for the same table |
