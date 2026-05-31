# Distribution Scheduler Idempotency

This change adds a per-report distribution guard on `revenue_reports` to prevent multiple scheduler instances from processing the same approved report concurrently.

## Implementation

- Added `distribution_status` and `distribution_status_updated_at` to `revenue_reports`.
- The scheduler now claims a report by atomically updating `distribution_status` from `NULL`/`failed`/stale `in_progress` to `in_progress` using `UPDATE ... RETURNING`.
- If another scheduler has already claimed the report, the current run skips it.
- After a successful distribution, the scheduler transitions the report to `completed`.
- After a failed distribution attempt, the scheduler transitions the report to `failed` so it can be retried later.

## Safety assumptions

- The atomic `UPDATE` prevents duplicate work across scheduler instances.
- Stale `in_progress` claims become reclaimable after 15 minutes, enabling recovery from crashed workers.
- The report remains `approved` while distribution attempts happen, so review and retry logic can still operate on the same report.
