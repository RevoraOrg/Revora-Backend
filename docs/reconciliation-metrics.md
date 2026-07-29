# Reconciliation Dashboard Metrics

## Purpose

The `/metrics/reconciliation` endpoint exposes reconciliation drift metrics in
**OpenMetrics text format (v1.0.0)** so that Prometheus / Grafana can scrape
machine-consumable time-series for dashboards and alerting.

All metrics are collected in-memory by the application's `MetricsCollector`
singleton and are emitted on demand.

---

## Endpoint

```
GET /metrics/reconciliation
```

### Authentication

The endpoint is protected by the same `METRICS_BEARER_TOKEN` middleware used by
the global `/metrics` endpoint. Include the token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer ${METRICS_TOKEN}" \
  http://localhost:4000/metrics/reconciliation
```

In development and test environments (`NODE_ENV=development`, `NODE_ENV=test`)
the token check is bypassed for convenience.

---

## Metric Reference

### reconciliation_drift_amount

| Field     | Value                          |
|-----------|--------------------------------|
| Type      | gauge                          |
| Labels    | `offering_id`                  |
| Help      | Monetary drift amount for the offering (in settlement currency) |

The current discrepancy amount from the latest reconciliation run. Emitted by
`ReconciliationScheduler.emitMetrics()` on each successful tick.

### reconciliation_last_run_timestamp

| Field     | Value                          |
|-----------|--------------------------------|
| Type      | gauge                          |
| Labels    | `offering_id`                  |
| Help      | Unix epoch seconds of the last completed reconciliation run |

Timestamp of the most recent successful reconciliation for each offering.

### reconciliation_errors_total

| Field     | Value                          |
|-----------|--------------------------------|
| Type      | counter                        |
| Labels    | `offering_id`                  |
| Help      | Cumulative count of failed reconciliation runs |

Incremented in the `ReconciliationScheduler` catch block whenever a tick fails
for an offering.

### reconciliation_discrepancy_total

| Field     | Value                          |
|-----------|--------------------------------|
| Type      | counter                        |
| Labels    | `offering_id`                  |
| Help      | Total reconciliation discrepancies detected by the scheduled job |

Running sum of all discrepancies found across scheduler-triggered runs for an
offering.

### reconciliation_alarm_open

| Field     | Value                          |
|-----------|--------------------------------|
| Type      | gauge                          |
| Labels    | `offering_id`                  |
| Help      | Dead-letter alarm: 1 when reconciliation found discrepancies or errored |

Opens (1) when a run is imbalanced or errors; clears (0) upon the next
balanced run.

---

## Example Output

```
# HELP reconciliation_alarm_open Dead-letter alarm: 1 when reconciliation found discrepancies or errored
# TYPE reconciliation_alarm_open gauge
reconciliation_alarm_open{offering_id="abc12345"} 1 1751280000
reconciliation_alarm_open_created{offering_id="abc12345"} 1751280000
# HELP reconciliation_drift_amount Monetary drift amount for the offering (in settlement currency)
# TYPE reconciliation_drift_amount gauge
reconciliation_drift_amount{offering_id="abc12345"} 12.34 1751280000
reconciliation_drift_amount_created{offering_id="abc12345"} 1751280000
# HELP reconciliation_errors_total Cumulative count of failed reconciliation runs
# TYPE reconciliation_errors_total counter
reconciliation_errors_total{offering_id="abc12345"} 1 1751280000
reconciliation_errors_total_created{offering_id="abc12345"} 1751280000
# EOF
```

---

## Security Assumptions

| Concern | Mitigation |
|---|---|
| **Unauthenticated access** | `createMetricsAuthMiddleware()` validates a bearer token via `crypto.timingSafeEqual` before reaching the handler. |
| **Token theft** | `METRICS_TOKEN` should be a cryptographically-random string ≥ 32 characters, stored in environment config. |
| **PII in labels** | `MetricsCollector.sanitizeLabels()` filters email, phone, IP, and UUID patterns from label values. Offering IDs are truncated to the first UUID segment via `shortLabel()`. |
| **Cardinality explosion** | The `cardinalityLimit` (default 50) caps individually-labelled offerings. Beyond this count, metrics are aggregated under `offering_id="overflow"`. |

---

## Alerting Guidance (PromQL)

```promql
# Any offering with drift > 1.00
reconciliation_drift_amount > 1.00

# Offerings where the alarm has been open for > 1 hour
(reconciliation_alarm_open - reconciliation_alarm_open offset 1h) > 0

# Error rate per offering
rate(reconciliation_errors_total[5m])

# Grafana: last run timestamp too old (> 24h)
time() - reconciliation_last_run_timestamp > 86400
```
