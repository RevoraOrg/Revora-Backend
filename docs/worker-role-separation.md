# Worker Role Separation

## Overview

The Revora-Backend process can be deployed as separate role-based workers so that
hot-path API traffic and batch/background loads autoscale independently.

## Configuration

Set the `ROLE` environment variable at startup:

```bash
ROLE=api       # Hot-path only (HTTP server + webhook delivery)
ROLE=batch     # Background only (audit purge + payout drift detection)
ROLE=all       # Everything (default in test; backward-compatible single process)
```

## Role Matrix

| Capability        | `api` | `batch` | `all` |
|-------------------|:-----:|:-------:|:-----:|
| HTTP Server       |   ✓   |         |   ✓   |
| WebhookQueue      |   ✓   |         |   ✓   |
| AuditPurgeService |       |    ✓    |   ✓   |
| PayoutDriftDetector|      |    ✓    |   ✓   |

## Behavior

- **Fail-fast on invalid ROLE**: An unknown or missing `ROLE` (outside `test`
  env) causes `process.exit(1)` with an actionable error message.
- **No dynamic switching**: The role is read once at startup; there is no
  runtime mode switching.
- **`all` is the safe default**: When `ROLE` is unset in `development`, the
  process behaves exactly as before — all services start.

## Deployment Recommendations

```
# Hot-path pods (autoscale on CPU / request latency)
ROLE=api PORT=4000

# Batch pods (autoscale on queue depth / CPU)
ROLE=batch

# Monolith (single process, dev/staging)
ROLE=all
```

## Security Assumptions

- The `ROLE` variable is additive — it never grants new permissions; it only
  controls which background services are launched.
- All background services inherit the same database credentials and JWT secrets
  as the API role.
- Batch workers should not be exposed to the public internet (no HTTP server
  when `ROLE=batch`).
