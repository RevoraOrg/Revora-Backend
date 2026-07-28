# Webhook Auth: Constant-Time Comparison & Clock Skew Tolerance

**Issue:** [#249](https://github.com/RevoraOrg/Revora-Backend/issues/249) — RC26Q2-B18  
**Branch:** `be18-webhook-auth`

---

## Overview

This document covers two security hardening additions to the webhook authentication layer:

1. **Constant-time HMAC comparison** — already present via Node's `crypto.timingSafeEqual`; this document records the design intent and test evidence.
2. **Clock skew tolerance (`clockSkewMs`)** — new configurable window that allows webhook senders whose system clocks run slightly ahead of the server to still pass timestamp validation.

---

## Constant-Time Comparison

All HMAC-SHA256 comparisons in `src/lib/webhookSignature.ts` use `timingSafeEqual` from Node's built-in `crypto` module.

```typescript
// src/lib/webhookSignature.ts — verifyWebhookPayload
const signatureBuffer = Buffer.from(signatureStr, 'utf8');
const expectedBuffer  = Buffer.from(expectedSignature, 'utf8');
return timingSafeEqual(signatureBuffer, expectedBuffer);
```

### Why it matters

A naive `===` comparison short-circuits on the first mismatching byte, leaking timing information an attacker can use to reconstruct the correct HMAC one byte at a time (timing oracle). `timingSafeEqual` compares every byte in constant time regardless of where the mismatch occurs.

### Length guard

Before calling `timingSafeEqual`, the code verifies that both buffers have the same length:

```typescript
if (signatureStr.length !== expectedSignature.length) {
  return false; // fail fast — same length is a prerequisite for timingSafeEqual
}
```

This prevents a panic / exception path that could itself be a timing side-channel.

---

## Clock Skew Tolerance

### Problem

Distributed systems — including Stellar Horizon nodes, Soroban RPC relays, and third-party webhook senders — often have clocks that are a few seconds ahead of the receiving server. Without a tolerance window, a valid webhook with a timestamp 5 seconds in the future is rejected even though it was legitimately signed and sent within the replay window.

### Solution: `clockSkewMs`

A new option `clockSkewMs` has been added to all three configuration interfaces:

| Interface | Location |
|-----------|----------|
| `WebhookVerificationConfig` | `src/lib/webhookSignature.ts` |
| `WebhookAuthOptions` | `src/middleware/webhookAuth.ts` |
| `WebhookRouterConfig` | `src/routes/webhooks.ts` |

**Default:** `30_000` ms (30 seconds) — consistent with Stripe's and GitHub's published recommendations.

### Timestamp window

```
  rejected          ← allowed window →          rejected
──────────┬────────────────────────────────┬──────────────────▶ time
          │                                │
  now - maxAgeMs                  now + clockSkewMs
```

The validation formula is:

```typescript
const age = Date.now() - timestamp.getTime();

// age < 0  ⟹  timestamp is in the future
// Reject if the future drift exceeds clockSkewMs OR if the timestamp is too old
if (age < -clockSkewMs || age > maxAgeMs) {
  // reject
}
```

### Usage

```typescript
// Allow 30 s of clock drift (default)
webhookAuth({
  secret: process.env.WEBHOOK_SECRET!,
  requireTimestamp: true,
  maxAgeMs: 300_000,       // 5-minute replay window
  clockSkewMs: 30_000,     // 30-second forward tolerance (default)
})

// Zero tolerance — reject any future-dated timestamp
webhookAuth({
  secret: process.env.WEBHOOK_SECRET!,
  requireTimestamp: true,
  clockSkewMs: 0,
})
```

### Security Assumptions

1. `clockSkewMs` does **not** widen the replay window. An attacker who captures a legitimate webhook cannot re-submit it `clockSkewMs` later and have it accepted because the `maxAgeMs` clock runs from the actual wall-clock time the request is processed.
2. A `clockSkewMs` of 30 seconds is a conservative choice. If your environment has larger clock drift, prefer fixing NTP synchronisation over increasing this value.
3. Signature verification always runs **before** timestamp validation so that an attacker cannot probe the timestamp window with unsigned requests.

---

## Structured Logging

All rejection events in `webhookAuth`, `webhookVerify`, `webhookAuthWithProvider`, and the route handlers now emit structured log entries via `globalLogger.warn(...)` rather than `console.error`. Success paths log at `debug` level.

Example log entry on rejection:

```json
{
  "timestamp": "2025-04-24T08:00:00.000Z",
  "level": "WARN",
  "message": "Webhook rejected: timestamp outside acceptable window",
  "context": {
    "path": "/webhooks",
    "age": -45000,
    "maxAgeMs": 300000,
    "clockSkewMs": 30000
  }
}
```

Sensitive fields (`secret`, `token`, etc.) are automatically redacted by the logger's `redactSensitive` pass.

---

## Error Response Shape

All auth-layer rejections now return the standard `ErrorResponse` from `src/lib/errors.ts`:

```typescript
interface ErrorResponse {
  code: ErrorCode;   // 'UNAUTHORIZED' | 'FORBIDDEN' | 'BAD_REQUEST'
  message: string;  // safe, generic message — no internal details
  requestId?: string;
}
```

| Condition | HTTP | `code` |
|-----------|------|--------|
| Missing signature header | 401 | `UNAUTHORIZED` |
| Invalid / tampered signature | 403 | `FORBIDDEN` |
| Payload too large | 403 | `FORBIDDEN` |
| Missing timestamp header | 403 | `FORBIDDEN` |
| Invalid timestamp format | 403 | `FORBIDDEN` |
| Timestamp outside window | 403 | `FORBIDDEN` |

This replaces the previous ad-hoc JSON that leaked internal `WebhookSignatureError.code` values (`MISSING_SIGNATURE`, `VERIFICATION_FAILED`, `INVALID_FORMAT`) to API consumers.

---

## Test Coverage

Run the targeted webhook test suite:

```bash
# All three webhook-related test files
npx jest --testPathPattern="webhookSignature|webhookAuth|routes/webhooks" --coverage

# Single file
npx jest src/lib/webhookSignature.test.ts --coverage
npx jest src/middleware/webhookAuth.test.ts --coverage
npx jest src/routes/webhooks.test.ts --coverage
```

New test cases added:

| File | Test description |
|------|-----------------|
| `webhookSignature.test.ts` | Accept future timestamp within default 30 s skew |
| `webhookSignature.test.ts` | Reject future timestamp beyond default 30 s skew |
| `webhookSignature.test.ts` | Accept future timestamp within custom `clockSkewMs` |
| `webhookSignature.test.ts` | Reject all future timestamps when `clockSkewMs = 0` |
| `webhookSignature.test.ts` | Error message includes `clock skew` on rejection |
| `webhookAuth.test.ts` | Accept slightly-future timestamp within default skew (middleware) |
| `webhookAuth.test.ts` | Reject future timestamp beyond default skew (middleware) |
| `webhookAuth.test.ts` | Accept future timestamp within custom `clockSkewMs` (middleware) |
| `webhookAuth.test.ts` | Reject all future timestamps when `clockSkewMs = 0` (middleware) |
| `webhooks.test.ts` | Accept slightly-future timestamp within skew (integration) |
| `webhooks.test.ts` | Reject future timestamp beyond skew window (integration) |

---

## Security Risk Note

| Risk | Mitigation |
|------|-----------|
| Timing attack on HMAC | `crypto.timingSafeEqual` + length pre-check |
| Replay attack | Timestamp required in production; `maxAgeMs` default 5 min |
| Clock-skew abuse | `clockSkewMs` default 30 s — narrow enough to be non-exploitable |
| Secret leakage in logs | `globalLogger` auto-redacts fields matching `secret`, `token`, etc. |
| Internal error strings in responses | `lib/errors` factories used — no raw exception messages in JSON |
