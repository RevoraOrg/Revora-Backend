# Rate Limiter Tier Policies (BE-011)

## Overview

Revora-Backend enforces a **multi-tier sliding-window rate limit** on the
`POST /api/v1/startup/register` endpoint.  The policy provides three tiers of
access, each with distinct quotas, so internal infrastructure and verified
partners are not penalised by the conservative public default while still
providing a hard upper bound against abuse.

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │  POST /api/v1/startup/register                                             │
 │                                                                            │
 │  x-revora-rate-tier ──► resolveTier() ──► InMemoryRateLimitStore           │
 │  x-revora-tier-secret      │                    │                          │
 │                            ▼                    ▼                          │
 │           ┌──────────┬──────────┬──────────┐  fixed-window counter        │
 │           │ standard │ trusted  │ internal │  per (keyPrefix + IP)         │
 │           │  5/15min │ 10/15min │ 25/15min │                               │
 │           └──────────┴──────────┴──────────┘                               │
 │                            │                                               │
 │              quota OK? ────┴──► handler (201)                              │
 │              quota exceeded? ──► 429 + Retry-After                         │
 └────────────────────────────────────────────────────────────────────────────┘
```

---

## Tiers and Limits

| Tier         | Request Limit | Window     | Description                                        |
| :----------- | :------------ | :--------- | :------------------------------------------------- |
| **standard** | 5             | 15 minutes | Default for any public IP address.                 |
| **trusted**  | 10            | 15 minutes | Verified external partners with a valid secret.    |
| **internal** | 25            | 15 minutes | Revora internal infrastructure and tooling.        |

---

## Implementation

### Middleware: `createStartupAuthTierLimiter`

Located in [`src/middleware/startupAuthRateTierPolicy.ts`](../src/middleware/startupAuthRateTierPolicy.ts).

```
/**
 * @notice Builds the startup-auth tier resolution and enforcement middleware.
 *
 * @dev    Tier resolution is a two-step process:
 *         1. Read `x-revora-rate-tier` from the request header.
 *         2. Validate the shared secret in `x-revora-tier-secret` against
 *            the `STARTUP_AUTH_TIER_SECRET` environment variable.
 *         Any failure at step 2 silently falls back to "standard".
 *
 * @param  options.store            Optional custom RateLimitStore (default: InMemoryRateLimitStore).
 * @param  options.tierSecretEnvName  Name of the env var holding the shared secret
 *                                  (default: "STARTUP_AUTH_TIER_SECRET").
 * @return { middleware, resolveTier, reset }
 */
```

The returned `middleware` is mounted directly on the route:

```typescript
const startupTierLimiter = createStartupAuthTierLimiter();

apiRouter.post(
  "/startup/register",
  startupTierLimiter.middleware,
  createStartupRegisterHandler(),
);
```

### Core Rate Limit Engine: `createRateLimitMiddleware`

Located in [`src/middleware/rateLimit.ts`](../src/middleware/rateLimit.ts).

```
/**
 * @notice Fixed-window rate-limit middleware.
 *
 * @dev    Window is keyed by `keyPrefix + ":" + "ip:" + req.ip`.
 *         Counters are stored in InMemoryRateLimitStore (process-local).
 *         On every request the middleware sets:
 *           X-RateLimit-Limit     — configured maximum
 *           X-RateLimit-Remaining — remaining in the current window (≥ 0)
 *           X-RateLimit-Reset     — UTC epoch seconds when the window resets
 *         On breach:
 *           Retry-After — seconds until the window resets
 *           429 Too Many Requests — JSON body with error message
 */
```

---

## Pluggable Store (`RateLimitStore`)

The limiter accepts an optional `store` implementing the `RateLimitStore`
interface, so the in-memory default can be swapped for a shared store (e.g.
Redis) in multi-instance deployments.

### Interface contract

```typescript
interface RateLimitStore {
  /** Increment the counter for `key` and return the updated state. */
  increment(key: string, windowMs: number): { count: number; resetAt: number };
  /** Reset the counter for `key` (useful in tests). */
  reset(key: string): void;
  /** Clear all counters (test helper). */
  clear?(): void;
}
```

Semantics the middleware relies on:

- `increment(key, windowMs)` MUST return `{ count: 1, resetAt: now + windowMs }`
  when no active window exists for `key`, and MUST return the **existing**
  `resetAt` (not a new one) while the window is still active.  This is what
  makes the fixed-window counter deterministic.
- `resetAt` is an epoch-milliseconds timestamp; the middleware derives the
  `X-RateLimit-Reset` header (epoch seconds) and `Retry-After` from it.
- The middleware never inspects store internals beyond this contract, so a
  Redis, Memcached, or Postgres-backed implementation can be dropped in
  without changes to tier logic.

### Implementor guidance

- **Shared state**: Use atomic increment + expiry, e.g. Redis `INCR` +
  `EXPIRE` (or `SET key 1 EX windowMs NX`) keyed by the full scoped key the
  middleware passes (already namespaced with the tier prefix).
- **Failure mode**: Catch internal store errors and either re-throw as an
  `AppError` or **fail open** (skip enforcement and log).  A dead store must
  never crash the request path with an opaque 500; if you prefer strict
  fail-closed behavior, document it in the deployment runbook.
- **Clock safety**: `resetAt` should be computed from the store's own clock
  (or a monotonic source) to avoid skew between app instances.

---

## Request Headers

| Header                   | Required for tier  | Description                                            |
| :----------------------- | :----------------- | :----------------------------------------------------- |
| `x-revora-rate-tier`     | `trusted`, `internal` | Requested tier (`standard`, `trusted`, or `internal`). |
| `x-revora-tier-secret`   | `trusted`, `internal` | Shared secret authenticating the elevated tier.        |

### Tier Resolution Logic (pseudocode)

```
resolveTier(req):
  tier ← trim(lowercase(header("x-revora-rate-tier"))) or ""
  if tier not in ["trusted", "internal"]:
    return "standard"
  secret ← env("STARTUP_AUTH_TIER_SECRET").trim()
  provided ← header("x-revora-tier-secret").trim()
  if secret is empty or provided ≠ secret:
    return "standard"      ← fail-safe downgrade, no error revealed
  return tier
```

---

## Response Headers

These headers are set on **every** request, including those that are blocked:

| Header                | Value                                                         |
| :-------------------- | :------------------------------------------------------------ |
| `X-RateLimit-Limit`   | Maximum requests allowed in the window for the resolved tier. |
| `X-RateLimit-Remaining` | Requests remaining (never negative).                        |
| `X-RateLimit-Reset`   | UTC epoch seconds when the window resets.                     |
| `X-RateLimit-Tier`    | The resolved tier name (`standard`, `trusted`, `internal`).   |
| `Retry-After`         | Seconds to wait (**only on 429 responses**).                  |

### 429 Response Body

```json
{
  "code": "TOO_MANY_REQUESTS",
  "message": "Too many registration attempts, please try again after 15 minutes.",
  "details": { "retryAfter": 1234567890 }
}
```

---

## Security Assumptions

1. **Untrusted Tier Header**: `x-revora-rate-tier` is treated as **untrusted
   client input**.  It is never trusted on its own; elevation to `trusted` or
   `internal` always requires a matching secret.  Spoofing the header alone
   yields no tier privilege.

2. **Identity Assertion**: Tier elevation is gated solely on the `x-revora-tier-secret`
   header.  This is a **shared secret** pattern — it is not a substitute for
   request-level authentication.  Protect the secret with the same care as a
   signing key.

2. **Fail-Safe Downgrade**: An absent, empty, or mismatched secret always results
   in `standard` tier resolution.  The server never returns an error that
   distinguishes "wrong secret" from "no secret", preventing oracle attacks.

4. **IP-Based Tracking**: Rate limits are tracked per resolved client IP
   (`req.ip`, with `trust proxy = 1`).  Ensure the Express app is configured
   correctly behind a load-balancer so `req.ip` reflects the real client IP.
   A misconfigured proxy could allow a single client to appear as many IPs,
   bypassing the limit.

5. **In-Memory Store**: The current `InMemoryRateLimitStore` is **process-local**.
   In a multi-instance deployment, counters are not shared between instances,
   so effective limits are `numInstances × limit`.  Replace the store with a
   Redis-backed implementation (see [Pluggable Store](#pluggable-store-ratelimitstore))
   before horizontal scale-out.

6. **Secret Rotation**: Rotating `STARTUP_AUTH_TIER_SECRET` requires a
   coordinated rolling deploy.  During the rotation window, requests with the
   old secret will be downgraded to `standard`; plan accordingly.

7. **No Per-User Isolation**: The limiter keys by IP, not by user identity.
   Authenticated user IDs should be layered on top if per-account isolation is
   required in future tiers.

---

## Abuse and Failure Paths

### Abuse scenarios

| Scenario | Behaviour | Mitigation |
| :------- | :-------- | :--------- |
| Attacker sends `x-revora-rate-tier: trusted` with a wrong secret | Downgraded to `standard` and exhausts the standard counter | No tier privilege gained; attacker burns their own quota |
| Attacker rotates through multiple IPs to bypass per-IP limit | Each IP gets its own counter; limit applies per IP | Deploy a WAF / IP reputation list upstream for volumetric attacks |
| Attacker guesses the tier secret by brute-force | Every attempt consumes a standard-tier slot; 5 guesses per 15 min per IP | Keep the secret ≥ 32 random bytes; rotate periodically |
| Attacker floods with `x-revora-rate-tier: standard` | Exhausts their IP quota after 5 requests | Same as no tier header — intended behaviour |
| Unknown tier value (e.g. `vip`) | Treated as `standard` | Silently downgraded; no error revealed |

### Failure scenarios

| Failure | Behaviour |
| :------- | :-------- |
| `STARTUP_AUTH_TIER_SECRET` env var not set | All elevated tier requests fall back to `standard` (safe default) |
| Process restart | In-memory counters reset; brief window where a fresh burst is possible during rolling deploy |
| Store `increment()` throws unexpectedly | Uncaught exception propagates to Express error handler → 500 |
| Upstream load balancer strips custom headers | `x-revora-rate-tier` absent → `standard` tier (safe) |

---

## Environment Variables

| Variable                  | Required | Description                                                    |
| :------------------------ | :------- | :------------------------------------------------------------- |
| `STARTUP_AUTH_TIER_SECRET` | No      | Shared secret for `trusted`/`internal` tier elevation. Absent = all requests treated as `standard`. |

---

## Deployment Checklist

- [ ] Set `STARTUP_AUTH_TIER_SECRET` in the deployment secrets store (not in `.env` committed to VCS).
- [ ] Configure `app.set('trust proxy', 1)` (already done in `createApp`).
- [ ] For multi-instance deployments: swap `InMemoryRateLimitStore` for a Redis-backed store.
- [ ] Rotate `STARTUP_AUTH_TIER_SECRET` at least once per quarter.
- [ ] Add WAF-level IP rate limiting upstream for large-scale volumetric attack mitigation.

---

## Test Coverage

All behaviours documented above are covered in:

- **Unit tests** (middleware only, no HTTP):
  [`src/middleware/startupAuthRateTierPolicy.test.ts`](../src/middleware/startupAuthRateTierPolicy.test.ts)
  — 454 lines, covers tier resolution, quota enforcement per tier, header
  correctness, spoofed-secret downgrade, and store isolation.

- **Integration tests** (full HTTP stack via `createApp`):
  [`src/routes/health.test.ts`](../src/routes/health.test.ts) — `Rate Limiter Tier
  Policies (BE-011)` describe block covers all three tiers, header presence,
  downgrade on wrong/absent secret, quota boundary conditions, cross-tier
  counter isolation, health-endpoint isolation, and 429 body format.

- **Core rate-limit engine tests**:
  [`src/middleware/rateLimit.test.ts`](../src/middleware/rateLimit.test.ts)
  — 380 lines, covers `InMemoryRateLimitStore` lifecycle, per-IP and per-user
  keying, `Retry-After` header, `keyPrefix` isolation, and IP fallback paths.

---

## Related Documents

- [`docs/startup-auth-brute-force-mitigation.md`](startup-auth-brute-force-mitigation.md)
- [`docs/startup-auth-service.md`](startup-auth-service.md)
- [`docs/password-reset-rate-controls.md`](password-reset-rate-controls.md)
