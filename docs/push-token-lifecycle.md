# Push Token Lifecycle: 410 Deregistration with Backoff Pruning

## Overview

APNs and FCM return HTTP `410 Gone` for devices that have uninstalled the app,
but the previous push pipeline retried indefinitely. This feature adds a
`PushNotificationService` that:

- Detects `410 Gone` responses from push providers
- Immediately marks the corresponding device token as **pruned** in the database
- Emits Prometheus-compatible metrics on every token pruned
- Records a security audit event for operational visibility
- Applies **exponential backoff with jitter** for transient errors (`5xx`, `429`,
  network failures)
- Never evicts tokens on transient errors — only on definitive `410`

## Architecture

```
┌──────────────┐       ┌──────────────────────┐       ┌──────────┐
│  Quiet Hours │──────▶│ PushNotificationService│──────▶│ FCM/APNs │
│  Service     │       │                      │       │          │
└──────────────┘       │  ┌────────────────┐  │       └──────────┘
                       │  │ send(token,     │  │
                       │  │   payload,fn)   │──┼──▶ 410 → pruneToken()
                       │  └────────────────┘  │      5xx → backoff()
                       │                      │      4xx → fail fast
                       └──────────────────────┘
```

### Component: `PushNotificationService`

**Location:** `src/services/pushNotificationService.ts`

A provider-agnostic orchestrator that wraps a raw `PushSendFn` callback. Callers
inject the actual FCM/APNs delivery logic; the service handles lifecycle,
retries, metrics, and auditing.

## Lifecycle Rules

| Provider Response | Action |
|---|---|
| **2xx** | Success. Emit `push_send_success_total`. |
| **410 Gone** | **Prune token immediately.** No retry. Emit `push_token_pruned_total`, record audit event `push_token_pruned`. |
| **5xx / 429** | Retry with exponential backoff. Token is **NOT** pruned. |
| **Other 4xx** (400, 403, 404) | Fail immediately. No retry, no pruning. |
| **Network error** (sendFn throws) | Treated as transient — retry with backoff. |
| **Already pruned** | Skip delivery, return `{ success: false, error: 'Token already pruned' }`. |

## Backoff Formula

```
exponential = min(initialDelayMs × backoffFactor^(attempt-1), maxDelayMs)
floor       = max(exponential, providerRetryAfterMs)   // respect Retry-After
final       = floor  ×  (1 + random(0, jitter))
```

Defaults:

| Parameter | Default | Description |
|---|---|---|
| `maxRetries` | 5 | Maximum delivery attempts (incl. first) |
| `initialDelayMs` | 1 000 | Base backoff in milliseconds |
| `maxDelayMs` | 64 000 | Hard ceiling on delay (provider max) |
| `backoffFactor` | 2 | Multiplier per retry step |
| `jitter` | 0.3 | Random fraction added to avoid thundering herd |

FCM and APNs provider libraries respect these caps natively; the service layer
adds an additional safety net.

## Metrics Emitted

| Metric | Type | Labels | Description |
|---|---|---|---|
| `push_send_attempts_total` | Counter | `provider`, `status` | Every delivery attempt by provider and HTTP status |
| `push_send_success_total` | Counter | `provider` | Successful deliveries |
| `push_send_failures_total` | Counter | `provider`, `reason` | Failures by reason (`4xx_non_retryable`, `max_retries_exceeded`) |
| `push_token_pruned_total` | Counter | `provider` | Tokens pruned on 410 |
| `push_token_pruned_current` | Gauge | — | Current count of pruned tokens in DB |

## Audit Event

When a token is pruned, the service records an `AuditEvent`:

```typescript
{
  type: 'SECURITY_VIOLATION',
  action: 'push_token_pruned',
  resource: 'push_token:<token_id>',
  outcome: 'BLOCKED',
  details: {
    token_id: string,
    provider: 'fcm' | 'apns',
    reason: '410 Gone — device uninstalled',
  },
}
```

**Type selection rationale:** The `AuditEvent.type` union is limited to
`AUTHENTICATION | AUTHORIZATION | VALIDATION | SECURITY_VIOLATION`.
`SECURITY_VIOLATION` with `BLOCKED` outcome was chosen because the push is
being blocked on security grounds (stale device token). This is recognized as a
trade-off and may be refined when the audit schema supports operational event
types.

## Security Assumptions

1. Token values are opaque provider strings; no PII is logged in metrics or
   audit events.
2. The `provider` label on metrics is limited to `fcm | apns` — cardinality is
   bounded.
3. Pruning is best-effort: if the database write fails, the metric and audit
   event are still emitted so operators are aware of the stale token.
4. The service does not handle token registration — that remains the
   responsibility of `PushTokenRepository.upsert()`.
5. `last_used_at` is NOT automatically updated on successful delivery by this
   service. Callers should call `PushTokenRepository.upsert()` (which sets
   `last_used_at = NOW()`) or a future `touchLastUsed()` method if tracking is
   needed.

## Usage

```typescript
import {
  PushNotificationService,
  createPushNotificationService,
} from './services/pushNotificationService';

const service = createPushNotificationService(tokenRepo, auditRepo);

const token = await tokenRepo.findByToken('fcm-device-token');
const result = await service.send(token, payload, myFcmSendFunction);

if (!result.success && result.statusCode === 410) {
  // Token was pruned automatically — no action needed
}
```

## Testing

```bash
npm test -- src/services/pushNotificationService.test.ts
```

Tests cover:

- Success path with metrics verification
- 410 pruning with metric, gauge, and audit event assertions
- 5xx/429 retry with backoff delay verification
- 4xx non-retryable immediate failure
- Network error (thrown) retry behavior
- Already-pruned token skip
- `sendToUser` multicast with partial failures
- Provider dimension correctness (FCM vs APNs labels)
- Configuration edge cases (custom maxRetries, jitter bounds)
- Graceful degradation when DB or audit repo is down
