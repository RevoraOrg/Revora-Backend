# Reconciliation Replay CLI

## Overview

The `scripts/reconcile-replay.ts` CLI re-runs a single reconciliation period against an archived Horizon snapshot, allowing engineers to prove or refute drift anomalies that are discovered late.

It takes an `offering_id`, `period_start`, and a Horizon fixture URL, fetches the archived Horizon data, computes the fixture's SHA-256 for auditability, runs the reconciliation, and writes a signed JSON report to stdout.

## Usage

```bash
npx ts-node scripts/reconcile-replay.ts <offering_id> <period_start> <horizon_fixture_url> [period_end]
```

### Arguments

| Argument              | Description                                                    | Required |
| --------------------- | -------------------------------------------------------------- | -------- |
| `offering_id`         | The offering ID to reconcile.                                  | Yes      |
| `period_start`        | ISO-8601 start date of the reconciliation window.              | Yes      |
| `horizon_fixture_url` | URL to an archived Horizon snapshot (JSON).                    | Yes      |
| `period_end`          | Optional ISO-8601 end date. Defaults to the current timestamp. | No       |

### Environment Variables

| Variable                  | Description                                      | Required |
| ------------------------- | ------------------------------------------------ | -------- |
| `DATABASE_URL`            | PostgreSQL connection string for the local DB.   | Yes      |
| `REPLAY_SIGNING_SECRET`   | HMAC-SHA256 secret used to sign the report.      | Yes      |

### Example

```bash
DATABASE_URL="postgres://..." \
REPLAY_SIGNING_SECRET="my-secret" \
npx ts-node scripts/reconcile-replay.ts \
  offering-abc \
  2023-01-01 \
  https://archive.example.com/horizon-2023-01.json \
  2023-01-31
```

## Output

The CLI writes a signed JSON report to stdout. All diagnostic/progress messages are written to stderr.

### Report Schema

```json
{
  "report": {
    "schema_version": 1,
    "generated_at": "2023-01-15T10:00:00.000Z",
    "fixture_sha256": "abc123...",
    "fixture_url": "https://archive.example.com/horizon-2023-01.json",
    "parameters": {
      "offering_id": "offering-abc",
      "period_start": "2023-01-01T00:00:00.000Z",
      "period_end": "2023-01-31T00:00:00.000Z"
    },
    "reconciliation": {
      "offeringId": "offering-abc",
      "isBalanced": true,
      "discrepancies": [],
      "summary": { ... }
    }
  },
  "signature": "sha256=..."
}
```

### Signature Verification

The report is signed using HMAC-SHA256 with the `REPLAY_SIGNING_SECRET`. The signature covers the canonical JSON of the `report` object (deterministic `JSON.stringify`). To verify externally:

```typescript
import { createHmac } from 'node:crypto';

const expected = createHmac('sha256', secret).update(JSON.stringify(report)).digest('hex');
const isValid = `sha256=${expected}` === signature;
```

## Exit Codes

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| 0    | Reconciliation complete and balanced (no discrepancies).         |
| 1    | Reconciliation complete with discrepancies OR an error occurred. |

## Metrics

The CLI emits the following metrics via `globalMetrics`:

| Metric                                        | Description                                   |
| --------------------------------------------- | --------------------------------------------- |
| `reconciliation_replay_completed_total`        | Counter incremented on each successful run.   |
| `reconciliation_replay_discrepancies`          | Gauge set to the number of discrepancies.     |
| `reconciliation_replay_errors_total`           | Counter for errors (fixture fetch, DB, etc.). |

## Security Assumptions

1. **Fixture URL is trusted**: The operator provides the fixture URL. The CLI does not follow redirects or allowlist origins.
2. **Fixture SHA-256 is recorded**: The report includes the SHA-256 of the raw fixture response body, enabling post-hoc verification that the fixture data was not tampered with between the replay and any subsequent audit.
3. **Signing secret is secure**: The `REPLAY_SIGNING_SECRET` must be kept confidential. It is used only for HMAC-SHA256 signing and never included in the output.
4. **No live RPC calls**: The `HorizonFixtureClient` adapter reads all on-chain state from the archived fixture, so no live Stellar network calls are made during the replay.
5. **Database connection**: The CLI uses the same `DATABASE_URL` as the main application. It connects, runs the reconciliation, and closes the pool.

## Edge Cases & Failure Modes

| Scenario                                | Behavior                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Fixture URL unreachable (DNS, timeout)  | Actionable error with URL in message, exit code 1.                       |
| Fixture returns HTTP 404                | Actionable error: "snapshot may be missing or inaccessible", exit code 1.|
| Fixture returns empty body              | Actionable error: "empty response body", exit code 1.                    |
| Fixture returns non-JSON                | Actionable error: "non-JSON content", exit code 1.                       |
| Missing `DATABASE_URL`                  | Error message, exit code 1.                                              |
| Missing `REPLAY_SIGNING_SECRET`         | Error message at signing time, exit code 1.                              |
| Invalid date format                     | Validation error with expected format, exit code 1.                      |
| `period_end` <= `period_start`          | Validation error, exit code 1.                                           |
| Reconciliation service throws           | Error details printed, exit code 1.                                      |

## Testing

```bash
npx jest scripts/reconcile-replay.test.ts --coverage
```

Tests cover:
- Argument validation (missing args, invalid dates, empty offering ID)
- Fixture fetching (success, 404, 500, empty body, non-JSON, connection failure)
- `HorizonFixtureClient` adapter (returns fixture data, defaults missing fields)
- Report signing (valid format, consistency, different inputs produce different signatures, independent verification)
- Report structure validation (all required fields, SHA-256 format, unbalanced reconciliations)
