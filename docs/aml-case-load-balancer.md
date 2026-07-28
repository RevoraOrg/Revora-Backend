# AML Case Load Balancer

Capacity-aware automatic assignment of AML cases to analysts.

## Overview

The `CaseAssignmentService` selects the least-loaded eligible reviewer based on:

- **Active case count** — cases in `assigned` or `investigating` status.
- **Cool-down enforcement** — a reviewer cannot receive a new case within N hours after closing or dismissing a case.
- **Case-age SLO histogram** — `aml.case.age_days` is emitted on every assignment for operational visibility.

Reviewer profiles (max capacity, cool-down hours) are passed in at construction time. Active counts and close timestamps are read from the live `aml_cases` table so there is no in-memory state that could drift.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/aml/cases/assign-auto` | Assign a single open case to the least-loaded eligible reviewer. Body: `{ "case_id": "..." }`. |
| `POST` | `/aml/cases/assign-all` | Batch-assign all unassigned open cases (oldest first). |
| `GET`  | `/aml/cases/reviewer-capacities` | Return capacity snapshots for all configured reviewers. |

All three endpoints require admin authorization.

## Eligibility rules

1. The reviewer must have **remaining capacity** (`active_cases < max_capacity`).
2. The reviewer must **not be in cool-down** — the elapsed time since their most recent case closure must exceed `cool_down_hours`.
3. If multiple reviewers tie on remaining capacity, the one with the lexicographically smallest `reviewer_id` wins.

## Metrics

- **`aml.case.age_days`** — histogram observation of case age in whole days at the moment of assignment. Useful for SLO dashboards tracking how long cases wait before an analyst picks them up.

## Security assumptions

- Reviewer profiles are supplied by the caller (typically an admin route). The service does not independently verify that the listed reviewer IDs are valid users.
- All DB queries use parameterized SQL; no user input is interpolated into queries.
- The `assignmentService` is optional on the router — if not injected the endpoints return `503 Service Unavailable`.

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `max_capacity` | 10 | Maximum concurrent open cases per reviewer. |
| `cool_down_hours` | 24 | Hours after closing a case before the reviewer is eligible again. |
