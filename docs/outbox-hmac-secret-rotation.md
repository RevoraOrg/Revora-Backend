# Outbox HMAC Secret Auto-Rotation with Overlap Window

## Overview

Outbox webhook deliveries are signed with an HMAC-SHA256 secret at dispatch time.
`OutboxHmacRotationService` automates the lifecycle of that secret: it fetches new
secret material from a KMS on a configurable schedule, maintains a **bounded overlap
window** during which both the old and new secrets are accepted for verification, and
emits a `secret.rotation.completed` audit event after each successful rotation.

This design ensures zero-downtime rotation — receivers that have cached the previous
signing key keep working through the overlap window, after which the old key is
permanently discarded.

---

## Architecture & Rotation Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                    OutboxHmacRotationService                         │
│                                                                      │
│  KmsClient.generateSecret()                                          │
│         │                                                            │
│         ▼                                                            │
│   newSecret                                                          │
│         │                                                            │
│  current ──► previous  (overlap window opens: now + overlapWindowMs) │
│  newSecret ──► current                                               │
│         │                                                            │
│         ▼                                                            │
│  AuditSink.emit(secret.rotation.completed)                           │
│  metrics.incrementCounter('outbox_hmac_rotations_total')             │
└──────────────────────────────────────────────────────────────────────┘

During overlap window:
  Signing:      always uses current secret
  Verification: accepts current OR previous secret (via getDualKeyConfig())

After overlap window expires:
  getPreviousSecret() → undefined
  getDualKeyConfig()  → { secret: current }  (no nextSecret)
  Old-key signatures: REJECTED
```

---

## Overlap Window

The overlap window is the **only** period during which signatures produced with the
previous key are accepted for verification.  It is enforced with a hard deadline:

```
                    rotate()
                       │
   [current=v1]        │        [current=v2, previous=v1]
   ───────────────────►│◄──────────────────────────────────────────────
                       │          overlap window: overlapWindowMs
                       │                │
                       │         overlapExpiresAt = now + overlapWindowMs
                       │                │
                       │                ▼
                       │         overlapExpiresAt elapses
                       │                │
                       │         previous = null  ← purged on first access
                       │         old-key signatures: REJECTED
```

The default `overlapWindowMs` is **5 minutes (300,000 ms)**.  Set it via the
`OutboxHmacRotationOptions` constructor parameter or environment variable convention
(see Configuration below).

---

## Configuration

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `overlapWindowMs` | number | 300,000 (5 min) | How long the previous secret is accepted after rotation |
| `rotationIntervalMs` | number | 86,400,000 (24 h) | How often the scheduler calls `rotate()` |
| `kmsClient` | KmsClient | LocalKmsClient | Secret generation backend (AWS KMS, Vault, etc.) |
| `auditSink` | AuditSink | stdout logger | Persists the rotation audit event |
| `metrics` | MetricsCollector | globalMetrics | Prometheus-compatible metrics collector |
| `resource` | string | undefined | Label attached to audit events (e.g. `'global'`) |
| `initialSecret` | string | undefined | Seed secret (skips first rotation — useful in dev/tests) |

---

## Usage

```typescript
import { OutboxHmacRotationService, LocalKmsClient } from './services/outboxHmacRotationService';
import { makeWebhookDispatchFn, OutboxDispatcher } from './services/outboxDispatcher';

// 1. Create and start the rotation service
const rotationSvc = new OutboxHmacRotationService({
  kmsClient: new LocalKmsClient(),   // replace with AwsKmsClient in prod
  auditSink: async (event) => {
    await auditLogRepo.createAuditLog({
      action: event.action,
      details: JSON.stringify(event),
    });
  },
  overlapWindowMs: 5 * 60 * 1_000,  // 5 minutes
  rotationIntervalMs: 24 * 60 * 60 * 1_000,  // 24 hours
  resource: 'outbox-global',
});

await rotationSvc.start();

// 2. Build the dispatch function — pass the rotation service
const dispatchFn = makeWebhookDispatchFn(
  WebhookQueue.processDelivery.bind(WebhookQueue),
  endpointRepo.listActiveByEvent.bind(endpointRepo),
  rotationSvc,         // ← wires in rotation-aware signing
);

const dispatcher = new OutboxDispatcher(outboxRepo, dispatchFn);
dispatcher.start();
```

### Signing an outbound payload directly

```typescript
import { signOutboundPayload } from './lib/webhookSignature';

const config = rotationSvc.getDualKeyConfig();
const body = JSON.stringify(webhookPayload);
const timestamp = Date.now().toString();

const { signature, overlapWindowActive, overlapExpiresAtMs } = signOutboundPayload(
  {
    currentSecret: config.secret,
    previousSecret: config.nextSecret,
    overlapExpiresAtMs: config.nextSecretExpiry,
  },
  body,
  timestamp,
);
// Attach `signature` to the X-Revora-Signature header
// Optionally expose `overlapWindowActive` / `overlapExpiresAtMs` in a
// X-Revora-Rotation-Window header so receivers can update their keys.
```

### Dual-key verification on the receiver side

```typescript
import { verifyWebhookPayloadDualKey } from './lib/webhookSignature';

const config = rotationSvc.getDualKeyConfig();
const result = verifyWebhookPayloadDualKey(
  { secret: config.secret, nextSecret: config.nextSecret, nextSecretExpiry: config.nextSecretExpiry },
  rawBody,
  incomingSignature,
);

if (!result.valid) {
  if (result.expired) {
    // Old key expired — reject with 403
  }
  // Unknown key — reject with 403
}
// result.verifiedByKey === 'current' | 'next'
```

---

## Audit Event

A `secret.rotation.completed` event is emitted after every successful rotation.
**Secret values are never included** — only version identifiers and timing metadata.

```json
{
  "action": "secret.rotation.completed",
  "rotatedAt": "2026-07-30T12:00:00.000Z",
  "incomingSecretVersion": "v3",
  "outgoingSecretVersion": "v2",
  "overlapExpiresAtMs": 1753876200000,
  "overlapWindowMs": 300000,
  "resource": "outbox-global"
}
```

| Field | Description |
| :--- | :--- |
| `action` | Always `'secret.rotation.completed'` |
| `rotatedAt` | ISO 8601 timestamp of when rotation completed |
| `incomingSecretVersion` | Opaque version ID of the new active secret |
| `outgoingSecretVersion` | Opaque version ID of the demoted secret (`'none'` for first rotation) |
| `overlapExpiresAtMs` | Epoch ms at which old-key acceptance ends |
| `overlapWindowMs` | Duration of the overlap window in ms |
| `resource` | Optional resource/scope label |

---

## KMS Client Interface

```typescript
export interface KmsClient {
  generateSecret(): Promise<string>;
}
```

Implement this interface to back the service with AWS Secrets Manager, HashiCorp Vault,
GCP Secret Manager, or any other HSM.  The built-in `LocalKmsClient` uses
`crypto.randomBytes` and is suitable for development and testing only.

---

## Metrics

| Metric | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `outbox_hmac_rotations_total` | counter | `resource` | Total completed HMAC rotations |

```prometheus
# TYPE outbox_hmac_rotations_total counter
outbox_hmac_rotations_total{resource="outbox-global"} 42 1753876200000
```

---

## Security Assumptions

1. **Secret values are never logged, emitted, or serialised** — only opaque version
   identifiers appear in audit events and metrics.
2. **Overlap window is strictly bounded** — `overlapWindowMs` defaults to 5 minutes and
   must be set to a finite positive value; no indefinite acceptance is possible.
3. **KMS failures are safe** — a failing `generateSecret()` call leaves the current
   secret unchanged.  The service logs the error and retries on the next scheduled cycle.
4. **Audit sink failures do not block rotation** — errors from the audit sink are caught
   and logged; rotation always completes if KMS succeeds.
5. **Timing-safe comparison** — all signature verification uses `crypto.timingSafeEqual`
   (via `verifyWebhookPayload`) regardless of which key slot is being checked.

---

## Related Docs

- [`docs/kyc-webhook-dual-key.md`](./kyc-webhook-dual-key.md) — Dual-key acceptance window for inbound KYC webhooks (same underlying primitives)
- [`docs/jwt-key-rotation.md`](./jwt-key-rotation.md) — JWT key rotation pattern (env-var based)
- [`docs/transactional-outbox.md`](./transactional-outbox.md) — Outbox architecture and dispatcher design
