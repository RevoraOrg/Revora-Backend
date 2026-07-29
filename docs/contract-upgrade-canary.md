# Contract Upgrade Canary Phase

## Overview

The canary phase adds a safe, observable intermediate step between code-id approval and global rollout.
Instead of promoting a new Soroban code-id to all offerings immediately, the orchestrator first activates
it against a single designated *shadow offering* per network.  A configurable hold period must elapse
with clean metrics before general rollout is authorised.

If metrics breach thresholds at any point—either during recording or at promote time—the upgrade is
automatically rolled back to `rolled_back` and an alarm is emitted.

---

## State Machine

```
pending
  │  createUpgrade
  ▼
approved
  │  approveUpgrade (two-key, code-id pin)
  │  simulateUpgrade (dry-run gate)
  │
  ├─ startCanary ──────────────────────────────────────────────────────────────┐
  │                                                                            │
  ▼                                                                            │
canary_active                                                                  │
  │  recordCanaryMetrics (metrics clean → start hold timer)                   │
  │  recordCanaryMetrics (metrics breached → auto rollback) ──────────────────┤
  ▼                                                                            │
hold_period                                                                    │
  │  recordCanaryMetrics (metrics updated in-place)                           │
  │  promoteCanary (hold elapsed + metrics clean)                             │
  │  promoteCanary (metrics still dirty → auto rollback) ─────────────────────┤
  │  rollbackCanary (explicit operator rollback) ──────────────────────────────┤
  ▼                                                                            │
canary_passed                                                                  │
  │  applyUpgrade → general rollout                                           │
  ▼                                                                         ─►rolled_back
applied
  │  monitorPostUpgradeHealth (regression gate)
  ▼
failed  (auto-rollback)
```

---

## Canary Offering Configuration

The `canary_offering_id` is passed per-request and should correspond to the shadow offering
configured for the target network.  Recommended practice is to store this mapping in tenant
settings or environment config so it is consistent across upgrade proposals.

| Network  | Recommended config key                         |
|----------|------------------------------------------------|
| testnet  | `CANARY_OFFERING_ID_TESTNET`                   |
| mainnet  | `CANARY_OFFERING_ID_MAINNET`                   |

---

## Hold Period

The hold period (`hold_period_seconds`, default **300 s / 5 min**) is the minimum wall-clock time
the canary must run with clean metrics before `promoteCanary` is allowed.

The timer starts on the first `recordCanaryMetrics` call that does **not** breach thresholds
(i.e. the transition from `canary_active` → `hold_period`).

---

## Metric Thresholds

Default thresholds applied at every `recordCanaryMetrics` and `promoteCanary` call:

| Metric             | Default threshold | Description                              |
|--------------------|-------------------|------------------------------------------|
| `error_rate`       | `< 0.01` (1 %)    | Fraction of requests returning errors    |
| `p99_latency_ms`   | `< 2000` (2 s)    | 99th-percentile response latency (ms)    |
| `failed_tx_count`  | `= 0`             | On-chain transactions that failed        |

Custom thresholds can be passed in the request body of `/metrics` and `/promote` endpoints.

---

## API Endpoints

All endpoints require the `requireAdmin` middleware (admin JWT).

### POST `/api/v1/contract-upgrades/:id/canary/start`

Activates the canary phase.  Upgrade must be `approved` with `simulate_ok = true`.

**Request body**

```json
{
  "canary_offering_id": "offering-shadow-abc123",
  "actor_id": "operator-uuid",
  "hold_period_seconds": 300
}
```

**Response** `200 OK`

```json
{ "upgrade": { "status": "canary_active", ... } }
```

---

### POST `/api/v1/contract-upgrades/:id/canary/metrics`

Records a metrics snapshot.  Transitions `canary_active → hold_period` on first clean recording.
Auto-rolls back if thresholds are breached.

**Request body**

```json
{
  "actor_id": "operator-uuid",
  "metrics": {
    "error_rate": 0.002,
    "p99_latency_ms": 145,
    "failed_tx_count": 0
  },
  "thresholds": {
    "max_error_rate": 0.01,
    "max_p99_latency_ms": 2000,
    "max_failed_tx_count": 0
  }
}
```

`thresholds` is optional; defaults are used when omitted.

**Response** `200 OK` — returns current upgrade state (may be `hold_period` or `rolled_back`).

---

### POST `/api/v1/contract-upgrades/:id/canary/promote`

Promotes the upgrade to `canary_passed`, authorising general rollout via `applyUpgrade`.

Pre-conditions:
- Status must be `hold_period`
- Hold period must have elapsed
- Latest `canary_metrics` must be within thresholds

**Request body**

```json
{
  "actor_id": "operator-uuid",
  "thresholds": { ... }
}
```

**Response** `200 OK` — returns upgrade with `status: "canary_passed"`, or `status: "rolled_back"` if
metrics were dirty at promote time.

---

### POST `/api/v1/contract-upgrades/:id/canary/rollback`

Explicit operator-initiated rollback.  Idempotent: safe to call multiple times.

**Request body**

```json
{
  "actor_id": "operator-uuid",
  "reason": "Latency spike observed in shadow offering"
}
```

**Response** `200 OK` — returns upgrade with `status: "rolled_back"`.

---

## Audit Events

| Event                                    | Trigger                                             |
|------------------------------------------|-----------------------------------------------------|
| `CONTRACT_UPGRADE_CANARY_STARTED`        | Canary phase activated                              |
| `CONTRACT_UPGRADE_CANARY_METRICS_RECORDED` | Metrics snapshot recorded (clean)                 |
| `CONTRACT_UPGRADE_CANARY_METRICS_BREACHED` | Metric threshold breached (alarm emitted)         |
| `CONTRACT_UPGRADE_CANARY_PROMOTED`       | Hold period elapsed; upgrade ready for rollout      |
| `CONTRACT_UPGRADE_CANARY_ROLLED_BACK`    | Canary rolled back (auto or manual; alarm emitted)  |

---

## Security Assumptions

1. **Two-key approval is preserved.** The canary phase sits *after* dual-key approval and dry-run simulation; it does not bypass either gate.
2. **Code-id pin is maintained.** The `target_code_id` is fixed at proposal time; the canary phase never modifies it.
3. **Rollback is always available.** An operator can call `/canary/rollback` at any point during `canary_active` or `hold_period` without needing a pre-approved rollback plan (unlike the post-`applied` auto-rollback which requires one).
4. **Auto-rollback is deterministic.** Threshold evaluation uses the exact metric values provided by the caller; there is no stochastic component.
5. **Alarm emission on breach.** Both metric breaches and rollbacks log at `warn` level with `alarm: true`, feeding the existing alerting pipeline.
6. **Idempotency on rollback.** Calling `rollbackCanary` on an already-`rolled_back` or `failed` upgrade returns the current state without performing a second write.

---

## Database Changes

Migration `020_contract_upgrades_canary.sql` adds:

- Extended `status` CHECK constraint to include `canary_active`, `hold_period`, `canary_passed`, `rolled_back`.
- Columns: `canary_offering_id`, `canary_started_at`, `hold_period_seconds`, `hold_started_at`, `canary_metrics` (JSONB), `canary_passed_at`, `rolled_back_at`.
- Partial index `idx_contract_upgrades_canary_status` for fast polling of in-flight canary upgrades.
