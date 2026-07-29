# KYC Provider Webhook Signature Rotation with Dual-Key Acceptance Window

## Overview

During KYC vendor secret key rotation, forcing an immediate hard cutover risks dropping in-flight callbacks from the vendor due to clock variance, request queueing, or out-of-order webhook delivery.

To achieve zero-downtime key rotation for KYC webhooks, Revora-Backend supports a **Dual-Key Acceptance Window** allowing incoming callbacks to be verified by either the primary active key (`current`) or the secondary next key (`next`). The acceptance window for the secondary/next key is bounded by a hard expiry deadline. Additionally, Prometheus-compatible counter metrics (`kyc.webhook.verified_by_key`) track deliveries verified by each key slot.

---

## Configuration & Environment Variables

| Variable | Type | Description | Example |
| :--- | :--- | :--- | :--- |
| `KYC_WEBHOOK_SECRET` | String | Primary signing secret key for KYC vendor callbacks | `kyc_sec_prod_991823` |
| `KYC_WEBHOOK_KEY` | String | Alias for primary signing secret key | `kyc_sec_prod_991823` |
| `KYC_WEBHOOK_KEY_NEXT` | String | Secondary/next signing secret key during rotation | `kyc_sec_prod_100234` |
| `KYC_WEBHOOK_KEY_NEXT_EXPIRY` | String / Number | Hard expiry deadline timestamp for secondary key acceptance | `2026-08-01T00:00:00Z` or `1785542400000` |

---

## Architecture & Verification Flow

```
+-------------------------------------------------------------------+
|                        Incoming Webhook                           |
+-------------------------------------------------------------------+
                                  |
                                  v
+-------------------------------------------------------------------+
|               Check Signature with Primary Secret                 |
|               (KYC_WEBHOOK_SECRET / KYC_WEBHOOK_KEY)               |
+-------------------------------------------------------------------+
                                  |
            +---------------------+---------------------+
            | Matches                                   | Does not match
            v                                           v
+-----------------------+               +-------------------------------+
|  Verify Succeeded     |               |   Is KYC_WEBHOOK_KEY_NEXT     |
|  Key Slot: 'current'  |               |          Configured?          |
+-----------------------+               +-------------------------------+
            |                                           |
            |                                  +--------+--------+
            |                                  | Yes             | No
            v                                  v                 v
+-----------------------+               +--------------+   +---------------+
| Emit Metric Counter   |               | Is Expiry    |   | Reject (403)  |
| key: 'current'        |               | Passed?      |   +---------------+
+-----------------------+               +--------------+
                                               |
                                     +---------+---------+
                                     | No                | Yes (Expired)
                                     v                   v
                        +----------------------+   +---------------+
                        | Check Signature with |   | Reject (403)  |
                        | KYC_WEBHOOK_KEY_NEXT |   +---------------+
                        +----------------------+
                                     |
                       +-------------+-------------+
                       | Matches                   | Mismatch
                       v                           v
         +-----------------------+         +---------------+
         |  Verify Succeeded     |         | Reject (403)  |
         |  Key Slot: 'next'     |         +---------------+
         +-----------------------+
                       |
                       v
         +-----------------------+
         | Emit Metric Counter   |
         | key: 'next'           |
         +-----------------------+
```

---

## Key Rotation Workflow

1. **Phase 1: Pre-Rotation Window Setup**
   - Keep current key in `KYC_WEBHOOK_SECRET`.
   - Set the newly generated vendor secret in `KYC_WEBHOOK_KEY_NEXT`.
   - Set `KYC_WEBHOOK_KEY_NEXT_EXPIRY` to an ISO date string or epoch timestamp corresponding to the scheduled end of rotation (e.g., 48 hours out).

2. **Phase 2: Dual Acceptance Window**
   - Webhooks signed with the existing key are verified under key slot `current`.
   - Webhooks signed with the new key are verified under key slot `next`.
   - Monitor the `kyc.webhook.verified_by_key` metric to observe traffic shifting from `current` to `next`.

3. **Phase 3: Final Cutover & Cleanup**
   - Once all traffic has shifted to the new key, update `KYC_WEBHOOK_SECRET` to the new secret key.
   - Unset `KYC_WEBHOOK_KEY_NEXT` and `KYC_WEBHOOK_KEY_NEXT_EXPIRY`.

---

## Metrics & Monitoring

Metric Name: `kyc.webhook.verified_by_key`
Type: Monotonically Increasing Counter

### Labels:
- `key`: `'current'` | `'next'`

### Example Prometheus Output:
```prometheus
# HELP kyc_webhook_verified_by_key Number of KYC webhooks verified per key slot
# TYPE kyc_webhook_verified_by_key counter
kyc_webhook_verified_by_key{key="current"} 1420 1785542400000
kyc_webhook_verified_by_key{key="next"} 85 1785542400000
```

---

## Security Assumptions & Boundary Enforcement

1. **Constant-Time Comparison**:
   All HMAC-SHA256 signature checks use `crypto.timingSafeEqual` to eliminate timing side-channel attack vectors regardless of key slot.
2. **Hard Deadline Expiry**:
   Secondary/Next keys are rejected unconditionally after `KYC_WEBHOOK_KEY_NEXT_EXPIRY` elapses, preventing stale keys from remaining permanently active.
3. **Payload Sanitization & Size Limits**:
   Raw body payload size is capped (default: 1MB) prior to verification to mitigate denial-of-service vulnerabilities.
