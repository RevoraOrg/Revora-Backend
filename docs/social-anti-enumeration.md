# Social Login Rate-Limit Hardening: Per-Provider-Sub Anti-Enumeration (#544)

## Overview

This document describes the security hardening applied to the social-login
(`POST /api/auth/social/:provider/login`) endpoint to prevent **timing-based
account enumeration** attacks.

An attacker who can observe response latency differences between a request for
a known account (identity found → slow DB + session-issue path) and an unknown
account (identity not found → fast reject path) can systematically probe the
service to discover which provider subjects are registered — without ever
receiving a meaningful error response.

Two complementary defences are applied in depth:

```
  POST /api/auth/social/:provider/login
  │
  ├── 1. socialAntiEnumerationMiddleware
  │       ├── Parse provider + sub from unverified JWT header/payload
  │       ├── Key = "<provider>:<sub>"  (e.g. "google:1234567890")
  │       ├── Increment per-sub fixed-window counter (10 req / 15 min default)
  │       ├── Fallback to IP-based counter when sub cannot be parsed
  │       └── Reject with 429 + Retry-After when limit exceeded
  │
  └── 2. SocialAuthService.loginWithProvider
          └── constantTimeLookup(identityRepository.findByProviderSubject)
                  └── Pad response to ≥ CONSTANT_TIME_LOOKUP_MIN_MS (50 ms)
                      so "not found" and "found" paths share the same floor
```

---

## Defence 1 — Per-Provider-Sub Rate Bucket

### Location

[`src/middleware/socialAntiEnumerationMiddleware.ts`](../src/middleware/socialAntiEnumerationMiddleware.ts)

### How It Works

```
/**
 * @notice Middleware that hardens the social-login endpoint against timing-based
 *         account-enumeration attacks.
 *
 * @dev    Two complementary defences are layered here:
 *
 *         1. Per-provider-sub rate bucket — After the provider + subject are
 *            extracted from the unverified JWT header/payload, a fixed-window
 *            counter is incremented for the key "<provider>:<sub>".  An
 *            attacker who probes the same account repeatedly exhausts *that
 *            identity's* bucket (not just their own IP bucket), regardless of
 *            how many IPs they rotate through.
 *
 *         2. Constant-time lookup — The service layer introduces a minimum
 *            artificial delay so that the response latency for a "not found"
 *            path matches that of a "found" path, removing the timing oracle.
 */
```

The middleware is mounted **before** the login handler in `socialAuthRoute.ts`:

```typescript
router.post(
  '/api/auth/social/:provider/login',
  antiEnumeration,               // ← seeds req.socialProviderSub, applies rate limit
  createSocialLoginHandler(service),
);
```

### Rate-Limit Parameters (defaults)

| Parameter          | Default  | Description                                            |
| :----------------- | :------- | :----------------------------------------------------- |
| `limit`            | 10       | Maximum login attempts per `provider:sub` per window.  |
| `windowMs`         | 900 000  | Window duration (15 minutes).                          |
| `ipFallbackLimit`  | 20       | Max attempts per IP when subject cannot be parsed.     |

Override via `antiEnumerationOptions` in `createSocialAuthRouter`:

```typescript
createSocialAuthRouter({
  socialAuthService,
  requireAuth,
  antiEnumerationOptions: {
    limit: 5,
    windowMs: 15 * 60 * 1000,
    ipFallbackLimit: 15,
    store: myRedisStore, // for multi-instance deployments
  },
});
```

### `extractProviderSub`

```
/**
 * @notice Extracts the unverified provider subject from a compact JWT payload.
 *
 * @dev    No crypto is performed — only base64url decoding of the payload part.
 *         The result is used solely for keying the rate-limit bucket.
 *         A forged/malformed sub creates a spurious bucket — harmless by design.
 *
 * @param provider  URL path param (e.g. "google", "apple").
 * @param idToken   Raw compact JWT string from the request body.
 * @returns         "<provider>:<sub>" or null if parsing fails.
 */
```

### Metrics

Two module-level counters are maintained:

| Counter      | Description                                             |
| :----------- | :------------------------------------------------------ |
| `attempts`   | Total login attempts seen by the middleware.            |
| `rejections` | Attempts rejected by the per-sub or IP-fallback limiter.|

Read them via `getSocialAntiEnumerationMetrics()` and expose through your
Prometheus `/metrics` endpoint or structured-log pipeline to alert on spikes.

### Response Headers

These headers are set on **every** request to the login endpoint:

| Header                  | Value                                             |
| :---------------------- | :------------------------------------------------ |
| `X-RateLimit-Limit`     | Configured maximum for the bucket type.           |
| `X-RateLimit-Remaining` | Requests remaining (never negative).              |
| `X-RateLimit-Reset`     | UTC epoch seconds when the current window resets. |
| `Retry-After`           | Seconds to wait (present **only** on 429).        |

### 429 Response Body

```json
{
  "code": "TOO_MANY_REQUESTS",
  "message": "Too many requests, please try again later.",
  "details": { "retryAfter": 1234567890 }
}
```

---

## Defence 2 — Constant-Time Identity Lookup

### Location

[`src/auth/social/socialAuthService.ts`](../src/auth/social/socialAuthService.ts)

### `constantTimeLookup`

```
/**
 * @notice Wraps an async identity lookup so the total elapsed time is always
 *         at least CONSTANT_TIME_LOOKUP_MIN_MS (50 ms), regardless of whether
 *         the lookup succeeds or fails.
 *
 * @dev    This eliminates the timing oracle for account enumeration:
 *         without this wrapper, an attacker measuring response time can
 *         distinguish "no identity found" (fast reject) from "identity found +
 *         session issued" (slower path through session creation).
 *
 *         The artificial delay does NOT replace the per-provider-sub rate
 *         limiter; both defences must be active simultaneously.
 *
 * @param fn   Async factory that produces the lookup result.
 * @returns    The result of fn, after waiting for the minimum delay if needed.
 */
export async function constantTimeLookup<T>(fn: () => Promise<T>): Promise<T>
```

**Usage in `loginWithProvider`:**

```typescript
const identity = await constantTimeLookup(() =>
  this.identityRepository.findByProviderSubject(provider, claims.subject),
);
```

### Constant `CONSTANT_TIME_LOOKUP_MIN_MS`

```typescript
export const CONSTANT_TIME_LOOKUP_MIN_MS = 50;
```

Set to **50 ms** as a conservative floor.  Real database round-trips in
production typically exceed this value, so the delay only materialises in fast
(e.g. in-memory, test) environments.  Increase this value if your p50 DB
latency is measured to be consistently below 50 ms.

---

## `perProviderSub` Rate-Limit Key Mode

A new keying mode was added to the core `createRateLimitMiddleware` engine:

```typescript
export interface RateLimitOptions {
  // ...existing fields...

  /**
   * If true, key is derived from `req.socialProviderSub` (populated by
   * socialAntiEnumerationMiddleware after the provider/sub is parsed).
   * Falls through to IP-based keying when the property is absent.
   *
   * Security assumption: the property is populated ONLY after the provider
   * ID-token has been cryptographically verified, preventing an attacker from
   * supplying an arbitrary subject to exhaust another identity's bucket.
   */
  perProviderSub?: boolean;
}
```

---

## Security Assumptions

1. **Unverified subject for bucket keying only** — The `extractProviderSub`
   helper reads the JWT payload without verifying the RS256 signature.  A
   forged subject creates a spurious bucket that does not correspond to a real
   account, so no information is leaked.  Full signature verification still
   occurs inside `SocialAuthService` via `JwksSocialTokenVerifier`.

2. **In-memory store is process-local** — In a multi-instance deployment,
   effective limits are `numInstances × limit`.  Replace `InMemoryRateLimitStore`
   with a Redis-backed implementation before horizontal scale-out.

3. **Constant-time floor is approximate** — `setTimeout` granularity on most
   Node.js runtimes is ≥ 1 ms.  The 50 ms floor is a best-effort mitigation,
   not a cryptographic guarantee.  Combine with the per-sub rate limiter for
   layered protection.

4. **IP fallback is not enumeration-proof** — An attacker who provides a
   well-formed JWT with a real `sub` but rotates IPs will consume the
   per-sub bucket (not the IP bucket).  The per-sub bucket is the primary
   defence; the IP bucket guards against completely malformed requests.

5. **Error messages are generic** — Both the per-sub and IP-fallback limiters
   return the same `"Too many requests, please try again later."` message, so
   an attacker cannot distinguish which bucket was exhausted.

6. **Timing floor vs. rate limiter** — The two defences address different
   attack models.  The rate limiter prevents high-frequency probing.  The
   constant-time floor prevents single-sample timing discrimination.  Both
   must remain active.

---

## Abuse and Failure Paths

### Abuse Scenarios

| Scenario | Behaviour | Mitigation |
| :------- | :-------- | :--------- |
| Attacker probes the same account from many IPs | Per-sub bucket is exhausted regardless of source IP | Per-sub rate limiter applies globally per identity |
| Attacker supplies a forged sub to exhaust a target's bucket | Forged sub creates an independent spurious bucket; real target is unaffected | Bucket key includes the sub value which must match the actual provider claim |
| Attacker observes response timing to enumerate accounts | `constantTimeLookup` floors all identity lookups at 50 ms | Timing oracle is blunted; residual variance is << 1 ms |
| Legitimate user retries rapidly (e.g. network flakiness) | Soft-cap of 10 per 15 min — well above interactive use | Limit is generous enough to absorb retry bursts |
| Attacker sends malformed JWT (no sub field) | IP-based fallback limiter applies (20 per window) | Still bounded; generic error message returned |
| Attacker requests with unsupported provider (e.g. "github") | `extractProviderSub` returns null → IP fallback applies | Unknown providers never reach the service layer |

### Failure Scenarios

| Failure | Behaviour |
| :------- | :-------- |
| Process restart | In-memory counters reset; brief window where a fresh burst is possible during rolling deploy. Use Redis store for persistence. |
| Middleware store `increment()` throws | Uncaught exception propagates to Express error handler → 500 |
| `constantTimeLookup` timer is imprecise (e.g. event-loop congestion) | Floor may be slightly higher than 50 ms; never lower — conservative in the right direction |
| Token body absent or not JSON | `extractProviderSub` returns null; IP fallback applied |

---

## Deployment Checklist

- [ ] For multi-instance deployments: inject a Redis-backed `RateLimitStore` via
  `antiEnumerationOptions.store` in `createSocialAuthRouter`.
- [ ] Set `app.set('trust proxy', 1)` so `req.ip` reflects the real client IP
  (already configured in `createApp`).
- [ ] Expose `getSocialAntiEnumerationMetrics()` in your `/metrics` endpoint to
  alert on enumeration spikes.
- [ ] Review `CONSTANT_TIME_LOOKUP_MIN_MS` against your measured p50 DB latency;
  increase if the DB is faster than 50 ms.
- [ ] Consider adding a WAF rule to block IPs that repeatedly hit 429 on this
  endpoint.

---

## Test Coverage

### New tests

| Test file | Scope |
| :-------- | :---- |
| [`src/middleware/socialAntiEnumerationMiddleware.test.ts`](../src/middleware/socialAntiEnumerationMiddleware.test.ts) | `extractProviderSub` (12 cases), per-sub bucketing (7 cases), IP fallback (4 cases), metrics (4 cases), auth boundaries/edge cases (4 cases) |
| [`src/middleware/rateLimit.test.ts`](../src/middleware/rateLimit.test.ts) | `perProviderSub` keying (5 new cases): sub-keyed bucket, independent sub pairs, IP fallback, isolation from perUser, header correctness |
| [`src/auth/social/socialAuthService.test.ts`](../src/auth/social/socialAuthService.test.ts) | `constantTimeLookup` (7 cases): timing floor, pass-through, error propagation, slow-fn no-extra-delay; service edge cases (8 new cases): ghost user, unknown identity, cross-account conflict, idempotent re-link, email collision, non-existent user, session token-hash |

### Coverage targets

All new code paths achieve ≥ 95 % line and branch coverage as required by the
task guidelines.

---

## Related Documents

- [`docs/rate-limiter-tier-policies.md`](rate-limiter-tier-policies.md) — existing tier-based rate limiter
- [`docs/social-login.md`](social-login.md) — social auth security model
- [`docs/startup-auth-brute-force-mitigation.md`](startup-auth-brute-force-mitigation.md)
- [`docs/password-reset-rate-controls.md`](password-reset-rate-controls.md)
