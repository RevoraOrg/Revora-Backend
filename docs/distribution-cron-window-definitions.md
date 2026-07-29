# Deferred Distribution Scheduling — Cron-Expression Window Definitions

## Overview

`DistributionScheduler` previously triggered on a fixed interval. This feature
adds **per-offering cron-expression window definitions** so treasury operators
can express schedules like:

> "Run every last business day of the month at 03:00 UTC"
> `0 3 28-31 * 5`  (Fridays from the 28th onward)

Expressions are persisted in the `offerings` table (`cron_expression` +
`distribution_timezone` columns) and validated by `CronWindowValidator` before
they are stored.  No code redeploy is needed to change a schedule.

---

## Architecture

```
Treasury operator sets cron_expression on offering
          │
          ▼
  CronWindowValidator.validateAgainstExisting()
    1. Syntax check (5-field cron, value ranges)
    2. Stellar maintenance window conflict check
    3. Overlap check against other offering schedules
          │
   valid? │ yes ──► persist to offerings.cron_expression
          │ no  ──► reject + emit scheduler.window.rejected_total counter
          │
          ▼
  DistributionScheduler.processPendingDistributions()
    resolves cron_expression per offering → CronSchedule
    evaluates in offering's distribution_timezone (IANA)
    applies DST-safe window computation
    de-duplicates via (utcStart, utcEnd) set
    fires DistributionEngine.distribute()
```

---

## Database Schema

Migration: `src/db/migrations/020_add_cron_schedule_to_offerings.sql`

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `cron_expression` | `VARCHAR(100) NULL` | — | 5-field cron expression. NULL = use default fixed-interval trigger. |
| `distribution_timezone` | `VARCHAR(100) NULL` | `'UTC'` | IANA timezone for wall-clock evaluation of the expression. |

### Example values

```sql
UPDATE offerings
SET cron_expression     = '0 3 28-31 * 5',   -- Last Friday of month at 03:00
    distribution_timezone = 'America/New_York'
WHERE id = '<offering-uuid>';
```

---

## CronWindowValidator

```typescript
import { CronWindowValidator, CronWindowDefinition } from './services/distributionScheduler';

const validator = new CronWindowValidator({ lookaheadDays: 60, metrics });

// Validate in isolation (syntax + Stellar maintenance check)
const result = validator.validate({
  expression: '0 3 * * 2',   // Every Tuesday at 03:00
  timezone: 'UTC',
  offeringId: 'off-abc',
});

if (!result.valid) {
  console.error(result.reasons);
}

// Validate against already-registered offering schedules (+ overlap check)
const result2 = validator.validateAgainstExisting(incoming, existingDefinitions);
```

### Validation rules

| Rule | Behaviour on failure |
|------|---------------------|
| 5-field cron syntax | Rejected with field-level error message |
| Value out of range (e.g. minute > 59) | Rejected |
| Invalid IANA timezone | Rejected |
| Expression fires during Stellar weekly maintenance (Sun 06:00–07:00 UTC) | Rejected with `stellarConflict` |
| Expression fires during Stellar monthly upgrade (1st Mon 02:00–04:00 UTC) | Rejected with `stellarConflict` |
| Two offerings fire at the same UTC minute within lookahead horizon | Rejected with `overlapDetail` |

---

## Stellar Maintenance Windows

Known maintenance windows are exported as `STELLAR_MAINTENANCE_WINDOWS`:

| Label | Cron (UTC) | Duration |
|-------|-----------|----------|
| Stellar weekly maintenance | `0 6 * * 0` (Sun 06:00) | 60 min |
| Stellar monthly upgrade window | `0 2 * * 1` (Mon 02:00) | 120 min |

These are intentionally conservative.  If Stellar publishes additional
maintenance windows, add them to the `STELLAR_MAINTENANCE_WINDOWS` constant in
`src/services/distributionScheduler.ts`.  The validator will pick them up
automatically — no other code change is needed.

---

## DST Handling

See the `// ─── DST Transition Policy` comment block at the top of
`src/services/distributionScheduler.ts` for the authoritative description.
Summary:

- **Spring-forward (skipped hour):** The window slides to the nearest valid
  wall-clock time after the gap.  A period is never skipped entirely.
- **Fall-back (repeated hour):** The scheduler fires exactly once using the
  first (daylight) occurrence.  De-duplication via the
  `(offering_id, utcStart, utcEnd)` key prevents a second fire.
- **Leap days (Feb 29):** The expression `0 3 29 2 *` is syntactically valid.
  It fires only in leap years.  In non-leap years the lookahead scan finds no
  matching minute and the window is skipped cleanly.
- **Year-skipping expressions:** Expressions covering only one specific month or
  day-of-month may produce no fires in a 60-day horizon.
  `findNextCronWindow` returns `null` in that case and logs a warning; it does
  not throw.

---

## Overlap Detection and Diff Logging

When `validateAgainstExisting` detects a collision it:

1. Emits a `scheduler_window_rejected_total` counter (labelled by `offering_id`).
2. Logs a `warn`-level `scheduler.window.rejected` event containing:
   ```json
   {
     "offeringId": "off-abc",
     "collidingOfferingId": "off-xyz",
     "collisionAt": "2026-08-05T04:00:00.000Z",
     "diff": {
       "incoming": "0 4 * * 3",
       "existing": "0 4 * * 3"
     }
   }
   ```
3. Returns `{ valid: false, overlapDetail: { offeringIdA, offeringIdB, collisionAt } }`.

The caller is responsible for persisting the rejection and surfacing it to the
operator — the validator itself does not write to the database.

---

## Environment Variables

No new environment variables are introduced.  Existing variables continue to
apply:

| Variable | Purpose |
|----------|---------|
| `SCHEDULER_CATCHUP_MAX` | Max reports to enqueue in a single catch-up pass (default 50) |

---

## Security Assumptions

1. **Input validation before persistence.** `CronWindowValidator.validate()` or
   `validateAgainstExisting()` **must** be called before inserting or updating
   `offerings.cron_expression`.  The DB column has no expression-level
   constraint — enforcement is at the application layer.

2. **Expressions are not executed as shell commands.** Cron expressions are
   evaluated by `evaluateCronAt()` (pure in-process arithmetic).  There is no
   shell execution, subprocess spawning, or dynamic code evaluation.

3. **Timezone injection prevention.** `normalizeTimezone()` and
   `isValidTimezone()` normalise aliases and validate against `Intl.DateTimeFormat`
   before any timezone string is used.  An invalid or adversarial timezone is
   silently coerced to UTC.

4. **Stellar maintenance windows are hardcoded.** They cannot be modified via
   operator input.  Adding or removing windows requires a code change and PR review.

5. **Overlap lookahead is bounded.** Default 60-day horizon.  An operator
   cannot trigger unbounded CPU consumption by providing a pathological expression
   because the validator exits after the horizon is exhausted.

---

## Abuse and Failure Paths

| Scenario | Behaviour |
|----------|-----------|
| Operator submits `null` as `cron_expression` | No cron evaluation; default fixed-interval trigger applies |
| Expression with 6 fields (Quartz-style seconds) | Rejected with "Expected 5 fields" |
| Expression fires every minute (`* * * * *`) | Passes syntax check; operator should be warned by UI (scheduler fires on every tick) |
| Expression fires inside Stellar maintenance | Rejected by `CronWindowValidator.validate()` |
| Two offerings share the same expression | Rejected by `validateAgainstExisting()` with overlap detail |
| `Intl.DateTimeFormat` unavailable (very old Node) | `isValidTimezone` returns false; falls back to UTC |
| DB column is updated directly (bypassing validator) | Invalid expression is silently ignored at runtime (`evaluateCronAt` returns false for 5-field mismatches); no crash |

---

## Related Documents

- [`docs/distribution-engine-atomic-transactions.md`](distribution-engine-atomic-transactions.md)
- [`docs/distribution-scheduler-idempotency.md`](distribution-scheduler-idempotency.md)
- [`docs/distribution-advisory-lock.md`](distribution-advisory-lock.md)
- [`docs/distribution-engine-retry-strategy.md`](distribution-engine-retry-strategy.md)
- [`docs/holiday-calendar-service.md`](holiday-calendar-service.md)
