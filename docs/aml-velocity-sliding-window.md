# AML Monitoring: Velocity Rule with Sliding-Window Investment Aggregation

The `velocity` rule detects smurfing by aggregating an investor's non-failed
investments in a rolling window. The current investment is included in both
the amount and count, and the rule triggers when either maximum is exceeded.

## Configuration

```json
{
  "type": "velocity",
  "severity": "high",
  "config": {
    "window_minutes": 60,
    "max_amount": 5000,
    "max_count": 10
  }
}
```

Alert details include the window bounds, aggregate values, exceeded thresholds,
and `linked_investment_ids` so analysts can trace the contributing events.

## Persistence and late events

`PgVelocityRepository` persists aggregates in
`aml_investment_velocity` using `INSERT ... ON CONFLICT DO UPDATE`. The unique
key `(investor_id, window_start, window_end, rule_id)` means a late-arriving
event updates the existing aggregate for that fixed window rather than creating
a duplicate row. The `(investor_id, window_end DESC)` index supports recent
window lookups.

The live AML factory wires the PostgreSQL repository. The in-memory repository
remains available for tests. Repeated evaluation of the same investment and
rule version is idempotent at the service boundary; a later rule version may
create a new alert intentionally.

## Aggregate fields

| Field | Description |
|-------|-------------|
| `window_start`, `window_end` | UTC bounds of the evaluated window |
| `tx_count`, `total_amount` | Non-failed investment count and total |
| `investment_ids` | JSONB array of contributing investment IDs |
| `amount_exceeded`, `count_exceeded` | Threshold decisions at evaluation time |
| `threshold_amount`, `threshold_count` | Threshold snapshots |
| `rule_id`, `rule_version` | Rule identity used for evaluation |

## Security assumptions

- Investment identity, investor identity, amount, status, and timestamp come
  from trusted transaction persistence and are validated before evaluation.
- Failed investments are excluded. Pending investments are included because
  they may represent an in-flight deposit requiring review.
- PostgreSQL stores monetary aggregates as `NUMERIC`; the evaluator currently
  converts amounts to JavaScript numbers, so deployments requiring precision
  beyond ordinary monetary ranges should use decimal arithmetic.
- Alert details contain investment identifiers only, not credentials or payment
  secrets. AML routes must continue to enforce analyst authorization.

## Metrics

Each triggered velocity evaluation emits
`aml_velocity_triggered_total` with `investor_id`, `rule_id`, and a `reason` of
`amount`, `count`, or `both`.
