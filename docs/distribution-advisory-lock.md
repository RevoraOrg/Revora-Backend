# Distribution Advisory Lock

## Problem

`DistributionEngine.distributeWithBatch` is not process-safe. Two concurrent
callers for the same `(offering_id, period_id)` — e.g. a manual `POST
/distributions` racing against `DistributionScheduler.processPendingDistributions`
— can both start a run and double-pay investors.

## Solution

`distribute()` (the public entry point) acquires a **Postgres transaction-scoped
advisory lock** keyed on `(offering_id, period_id)` before delegating to
`distributeWithBatch`. The lock is held for the entire duration of the batch and
is automatically released when the surrounding transaction commits or rolls back.

### Lock key derivation

```
advisoryLockKey(offeringId, periodId) → [classId: int4, objectId: int4]
```

The two-argument form of `pg_try_advisory_xact_lock(classId, objectId)` is used.
Both integers are derived from a single FNV-1a 32-bit hash of the concatenated
string `"${offeringId}:${periodId}"`, split into the upper and lower 16-bit
halves and sign-extended to `int4`.

### Behaviour

| Scenario | Result |
|---|---|
| Lock acquired | `distributeWithBatch` runs normally |
| Lock not acquired (another process holds it) | `Errors.conflict(409)` thrown immediately — no blocking |
| Transaction commits | Lock released automatically |
| Transaction rolls back (error) | Lock released automatically |
| No `Pool` provided (test / legacy path) | Runs without locking |

### Error shape

When the lock cannot be acquired the caller receives an `AppError` with:

```json
{
  "code": "CONFLICT",
  "statusCode": 409,
  "message": "Distribution for offering <id> / period <id> is already in progress"
}
```

## Security assumptions

- **No blocking**: `pg_try_advisory_xact_lock` returns immediately. A second
  caller never waits, so there is no risk of connection pool exhaustion from
  lock contention.
- **Automatic release**: transaction-scoped locks cannot be leaked. Even if the
  application process crashes mid-batch, Postgres releases the lock when the
  connection is closed.
- **Hash collision**: the FNV-1a 32-bit hash has a ~1-in-4-billion chance of
  collision per pair. For the expected cardinality of `(offering_id, period_id)`
  in a single deployment this is negligible. A collision would cause two
  unrelated distributions to serialise (one waits for the other to finish) but
  would not cause data corruption.

## Files changed

| File | Change |
|---|---|
| `src/services/distributionEngine.ts` | Added `advisoryLockKey`, `tryAcquireDistributionLock`, updated `distribute()` |
| `src/services/distributionAdvisoryLock.test.ts` | New: race, rollback, parallel, manual+scheduler, no-pool tests |

## Running the tests

```bash
# Advisory lock tests only
npx jest --testPathPatterns="distributionAdvisoryLock" --no-coverage

# Full distribution engine suite
npx jest --testPathPatterns="distributionEngine|distributionAdvisoryLock" --no-coverage
```
