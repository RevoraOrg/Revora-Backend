# Webhook Delivery Backoff Queue

## Overview
Implements a deterministic retry mechanism for webhook events using exponential backoff to ensure reliability without exhausting system resources.

## Security Assumptions
1. **SSRF Mitigation:** The `isSafeUrl` validator utilizes a regex boundary to block private IPv4 ranges (RFC 1918) including `10.x.x.x`, `172.16.x.x`, `192.168.x.x`, and `localhost`.
2. **Payload Immutability:** Payloads are passed as read-only objects to prevent side-channel data leaks during retry cycles.

## Technical Behavior
- **Strategy:** Exponential Backoff ($2^n \times 1000ms$).
- **Max Retries:** 5 attempts.
- **Max Delay:** 16,000ms (16 seconds) before final failure.
- **Failure Path:** Returns `false` after the 5th attempt, allowing the caller to move the job to a Dead Letter Queue (DLQ).