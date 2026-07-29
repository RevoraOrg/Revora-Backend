# AML Monitoring: Velocity Rule with Sliding-Window Investment Aggregation

## Overview

The AML velocity rule now uses a **true sliding-window aggregator** to detect
smurfing — the practice of breaking a large deposit into many small ones to
stay below reporting thresholds.

Each evaluation:
1. Aggregates all non-failed investments for the investor inside a configurable
   rolling window (`[now − window_minutes, now]`).
2. Compares the aggregate amount and count against configurable thresholds.
3. Persists the aggregate to `aml_investment_velocity` via `VelocityRepository`
   so late-arriving events update the row in-place without duplicating alerts.
4. Attaches `linked_investment_ids` to the alert so analysts can trace exactly
   which investments tripped the rule.
5. Emits an `aml_velocity_triggered_total` metric labelled by reason
   (`amount`, `count`, or `both`).

---

## Rule Configuration (`AMLRule.config`)

```typescript
interface VelocityRuleConfig {
  window_minutes: number;  // Rolling window length (e.g. 60)
  max_amount:     number;  // Max aggregate invested amount (e.g. 1000)
  max_count:      number;  // Max number of investments (e.g. 5)
}
```

Example rule stored in the `aml_rules` table:

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

---

## Alert Details Payload

When the rule triggers, `RuleEvaluationResult.details` contains:

| Field | Type | Description |
|-------|------|-------------|
| `window_minutes` | number | Configured window length |
| `window_start` | ISO-8601 | UTC start of the evaluated window |
| `window_end` | ISO-8601 | UTC end of the evaluated window (= tx timestamp) |
| `transaction_count` | number | Total non-failed investments in window |
| `total_amount` | number | Aggregate invested amount in window |
| `max_amount` | number | Configured threshold |
| `max_count` | number | Configured threshold |
| `amount_exceeded` | boolean | Whether amount threshold was breached |
| `count_exceeded` | boolean | Whether count threshold was breached |
| `linked_investment_ids` | string[] | IDs of all contributing investments |

`linked_investment_ids` is the audit trail linking the alert to the actual
investment events.  Store it in `AMLAlert.details` so analysts can query
individual investment records.

---

## `aml_investment_velocity` Table

Migration: `src/db/migrations/021_create_aml_investment_velocity.sql`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID PK | Row identifier |
| `investor_id` | UUID | Investor this window belongs to |
| `window_start` | TIMESTAMPTZ | Start of the sliding window (UTC) |
| `window_end` | TIMESTAMPTZ | End of the sliding window (UTC) |
| `window_minutes` | INTEGER | Window length in minutes |
| `tx_count` | INTEGER | Non-failed investments in window |
| `total_amount` | NUMERIC | Aggregate invested amount |
| `investment_ids` | JSONB | Array of contributing investment IDs |
| `amount_exceeded` | BOOLEAN | Whether amount threshold was breached |
| `count_exceeded` | BOOLEAN | Whether count threshold was breached |
| `threshold_amount` | NUMERIC | Snapshot of max_amount at evaluation time |
| `threshold_count` | INTEGER | Snapshot of max_count at evaluation time |
| `rule_id` | TEXT | AML rule that produced this row |
| `rule_version` | JSONB | Rule version at evaluation time |

**Unique constraint:** `(investor_id, window_start, window_end, rule_id)`
— ensures late-arriving events upsert the row rather than creating duplicates.

**Indexes:**
- `(investor_id, window_end DESC)` — primary lookup for recent windows
- `(investor_id)` — secondary filter

---

## `VelocityRepository` Interface

```typescript
interface VelocityRepository {
  upsert(record: Omit<InvestmentVelocityRecord, 'id' | 'created_at' | 'updated_at'>):
    Promise<InvestmentVelocityRecord>;

  findByInvestor(investorId: string, from: Date, to: Date):
    Promise<InvestmentVelocityRecord[]>;
}
```

### Implementations

| Class | Used in | Notes |
|-------|---------|-------|
| `InMemoryVelocityRepository` | Tests, single-node | Upserts by composite key in a `Map` |
| `PgVelocityRepository` *(future)* | Production | Issues `INSERT … ON CONFLICT DO UPDATE` against `aml_investment_velocity` |

Wire the production implementation:

```typescript
const evaluator = new RuleEvaluator(investmentRepo, {
  velocityRepo: new PgVelocityRepository(db),
  metrics,
});
```

---

## Late-Arriving Events

A late-arriving investment with a timestamp inside an already-evaluated window
calls `velocityRepo.upsert()` with updated aggregates.  The unique constraint
ensures only one row exists per `(investor_id, window_start, window_end, rule_id)`.

```
Timeline: window [T-60m, T]

  T-55m  investment A ($200)  ← initial evaluation → row created
  T-50m  investment B ($200)  ← arrives late         → row UPDATED (tx_count=2, total=$400)
  T-45m  investment C ($700)  ← new evaluation        → threshold crossed, alert fired
```

The upsert ensures no duplicate alert rows are created for the same window.
Deduplication of alerts themselves is the responsibility of the AML alert
repository — a separate `(investor_id, rule_id, window_end)` unique index on
`aml_alerts` can enforce this at the DB layer.

---

## Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `aml_velocity_triggered_total` | counter | `investor_id`, `rule_id`, `reason` | Fired when a velocity threshold is breached |

`reason` values:
- `amount` — only `max_amount` was exceeded
- `count` — only `max_count` was exceeded
- `both` — both thresholds exceeded simultaneously

---

## Opening a Case

When `evaluateTransaction` returns a triggered velocity alert, wire it into
`AMLService.createCase`:

```typescript
const alerts = await amlService.evaluateTransaction(context);

const velocityAlerts = alerts.filter(a => {
  // Look up rule type from rule repository if needed
  return a.details.linked_investment_ids !== undefined;
});

if (velocityAlerts.length > 0) {
  await amlService.createCase({
    alert_ids: velocityAlerts.map(a => a.id),
    investor_id: context.investor_id,
    notes: `Velocity threshold exceeded. Linked investments: ${
      (velocityAlerts[0].details.linked_investment_ids as string[]).join(', ')
    }`,
  });
}
```

---

## Security Assumptions

1. **Input validation.** `context.amount` is parsed with `parseFloat`.
   The upstream investment handler must validate that `amount` is a
   non-negative decimal string before passing it to the evaluator.

2. **Failed transactions excluded.** Only `status !== 'failed'` investments
   contribute to the window aggregate.  Pending investments are included
   (conservative — counts intent, not settlement).

3. **No inter-investor data leakage.** The window query filters strictly by
   `investor_id`.  Rows for different investors are never mixed.

4. **Threshold snapshots in the DB row.** `threshold_amount` and
   `threshold_count` are snapshotted at evaluation time so a rule config change
   does not retroactively alter historical rows.

5. **Unique constraint prevents duplicate rows.** The DB constraint on
   `(investor_id, window_start, window_end, rule_id)` is the last line of
   defence against duplicate aggregates in concurrent evaluation scenarios.

---

## Abuse and Failure Paths

| Scenario | Behaviour |
|----------|-----------|
| Investor submits many small deposits just below count threshold | Window shifts with each new investment; as soon as count + 1 > max_count, rule triggers |
| Late-arriving event arrives after alert was already filed | Upsert updates the aggregate row; existing alert is not duplicated |
| `velocityRepo.upsert()` throws | Error propagates to `evaluateRule`; rule returns `triggered: false` with DB error surfaced in logs |
| `window_minutes` set to 0 in rule config | Window is empty (no past tx qualifies); only the current investment counts |
| Very large `window_minutes` (e.g. 525960 = 1 year) | All investments in `previous_transactions` are included; bounded by repo's `listByInvestor` limit of 100 |

---

## Related Documents

- [`docs/aml-transaction-monitoring.md`](aml-transaction-monitoring.md)
- [`docs/aml-case-load-balancer.md`](aml-case-load-balancer.md)
- [`docs/sanctions-screening-fuzzy-matching.md`](sanctions-screening-fuzzy-matching.md)
