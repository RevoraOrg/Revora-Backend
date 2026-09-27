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

## Request Headers

| Header                   | Required for tier  | Description                                            |
| :----------------------- | :----------------- | :----------------------------------------------------- |
| `x-revora-rate-tier`     | `trusted`, `internal` | Requested tier (`standard`, `trusted`, or `internal`). |
| `x-revora-tier-secret`   | `trusted`, `internal` | Shared secret authenticating the elevated tier.        |

### Tier Resolution Logic (pseudocode)

```
resolveTier(req):
  tier ← lowercase(header("x-revora-rate-tier")) or ""
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
   client input** at all times.  Its value is never acted upon without a
   corresponding valid `x-revora-tier-secret`.  Any attempt to claim an elevated
   tier without the secret is silently rejected and the request is handled as
   `standard`. (Req 10.1)

2. **Identity Assertion**: Tier elevation is gated solely on the `x-revora-tier-secret`
   header.  This is a **shared secret** pattern — it is not a substitute for
   request-level authentication.  Protect the secret with the same care as a
   signing key.  Elevated tiers require a valid `x-revora-tier-secret` header
   matching `process.env.STARTUP_AUTH_TIER_SECRET`. (Req 10.2)

3. **Fail-Safe Downgrade**: A missing, empty, or mismatched secret always results
   in silent downgrade to `standard` tier resolution.  The server never returns
   an error that distinguishes "wrong secret" from "no secret", preventing oracle
   attacks. (Req 10.3)

4. **Proxy-Aware IP Tracking**: Rate limits are tracked per resolved client IP
   (`req.ip`).  The application **must** be deployed with `app.set('trust proxy', 1)`
   (already configured in `createApp`) so that `req.ip` reflects the real client
   IP behind a reverse proxy or load-balancer.  A misconfigured proxy could allow
   a single client to appear as many IPs, bypassing the limit. (Req 10.4)

5. **In-Memory Store (Process-Local)**: The current `InMemoryRateLimitStore` is
   **process-local**.  In a multi-instance deployment, counters are not shared
   between instances, so effective limits are `numInstances × limit`.  Replace
   the store with a shared implementation (see `RateLimitStore` interface below)
   before horizontal scale-out. (Req 10.5)

6. **Secret Rotation**: Rotating `STARTUP_AUTH_TIER_SECRET` requires a
   coordinated rolling deploy.  During the rotation window, requests with the
   old secret will be downgraded to `standard`; plan accordingly.

7. **No Per-User Isolation**: The limiter keys by IP, not by user identity.
   Authenticated user IDs should be layered on top if per-account isolation is
   required in future tiers.

---

## Abuse and Failure Paths

### Abuse scenarios

The following scenarios are explicitly accounted for in the design. (Req 10.6)

| Scenario | Behaviour | Mitigation |
| :------- | :-------- | :--------- |
| Attacker sends `x-revora-rate-tier: trusted` with a wrong secret | Downgraded to `standard`; request burns a standard-tier slot | No tier privilege gained; attacker exhausts only their own standard quota |
| Attacker spoofs `x-revora-rate-tier: internal` with invalid secret | Downgraded to `standard`; consumes from the standard counter, not the internal counter | Counter isolation ensures cross-tier exhaustion is not possible |
| Attacker rotates through multiple IPs to bypass per-IP limit | Each IP gets its own counter; limit applies per IP | Deploy a WAF / IP reputation list upstream for volumetric attacks |
| Attacker guesses the tier secret by brute-force | Every attempt consumes a standard-tier slot; 5 guesses per 15 min per IP | Keep the secret ≥ 32 random bytes; rotate periodically |
| Attacker floods with `x-revora-rate-tier: standard` | Exhausts their IP quota after 5 requests | Same as no tier header — intended behaviour |
| Unknown tier value (e.g. `vip`) | Treated as `standard`; silently downgraded | No error revealed; attacker learns nothing about valid tiers |

### Failure scenarios

The following failure modes are known and the application's behaviour is deterministic. (Req 10.7)

| Failure | Behaviour |
| :------- | :-------- |
| `STARTUP_AUTH_TIER_SECRET` env var not set | All elevated-tier requests fall back to `standard` (safe default) |
| Missing client IP (`req.ip` and `req.socket.remoteAddress` both absent) | Key falls back to `'unknown'`; all such requests share one counter |
| Process restart | In-memory counters reset; brief window where a fresh burst is possible during rolling deploy |
| Store `increment()` throws unexpectedly | Uncaught exception propagates to Express error handler → 500 |
| Upstream load balancer strips custom headers | `x-revora-rate-tier` absent → `standard` tier (safe) |

---

## RateLimitStore Interface

The `InMemoryRateLimitStore` is the default store. For distributed deployments
you must supply a custom implementation of the `RateLimitStore` interface.

### Interface contract

```typescript
/**
 * @notice Pluggable counter store for the fixed-window rate limiter.
 *
 * @dev  All implementations must be safe to call concurrently from
 *       multiple in-flight requests within the same process.  For
 *       cross-process safety (multi-instance deployments) the
 *       implementation must use an atomic operation on the backing store
 *       (e.g. Redis INCR + EXPIRE, DynamoDB conditional writes, etc.).
 */
export interface RateLimitStore {
  /**
   * @notice Atomically increment the counter for `key` and return the
   *         updated count and the epoch-ms timestamp at which the window resets.
   *
   * @dev    If no window exists for `key`, a new one is started with count = 1
   *         and resetAt = now + windowMs.  If the window has already expired,
   *         the counter is reset to 1 and a new resetAt is computed.
   *
   * @param  key       Scoped rate-limit key (includes keyPrefix and IP/user).
   * @param  windowMs  Length of the fixed window in milliseconds.
   * @return { count, resetAt }
   */
  increment(key: string, windowMs: number): { count: number; resetAt: number };

  /**
   * @notice Reset the counter for a single key.  Safe to call on a
   *         non-existent key (no-op).  Primarily used in tests.
   *
   * @param  key  The key to remove from the store.
   */
  reset(key: string): void;

  /**
   * @notice Remove all counters (optional).  Primarily used in tests or
   *         for a graceful-reset capability.
   */
  clear?(): void;
}
```

### Implementation guidance

- **Error handling**: If the backing store is unavailable, implementors SHOULD
  either throw an `AppError` (which routes to the global error handler → 500) or
  **fail-open** (return `{ count: 0, resetAt: Date.now() + windowMs }`) with a
  structured warning log.  Failing-open is safer for availability but removes
  rate-limit protection during outages — choose based on your threat model.

- **Atomicity**: Use a single round-trip atomic operation where possible.
  Redis `INCR` + conditional `EXPIRE` (set only if the key is new) is the
  standard pattern.

- **Clock skew**: `resetAt` values should be derived from the backing store's
  clock where possible to avoid drift in distributed environments.

- **Injection**: Pass the custom store to `createStartupAuthTierLimiter`:

  ```typescript
  import { createStartupAuthTierLimiter } from './middleware/startupAuthRateTierPolicy';
  import { myRedisStore } from './stores/redisRateLimitStore';

  const limiter = createStartupAuthTierLimiter({ store: myRedisStore });
  apiRouter.post('/startup/register', limiter.middleware, handler);
  ```

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

All behaviours documented above are covered at **100% statements, branches, functions,
and lines** across both implementation files. Tests are organised into four suites:

- **Unit tests** (middleware only, no HTTP):
  [`src/middleware/startupAuthRateTierPolicy.test.ts`](../src/middleware/startupAuthRateTierPolicy.test.ts)
  — covers tier resolution, quota enforcement per tier, header correctness,
  spoofed-secret downgrade, store isolation, and exact policy constant values.

- **Integration tests** (full HTTP stack via `createApp`):
  [`src/routes/health.test.ts`](../src/routes/health.test.ts) — covers all three
  tiers, header presence, downgrade on wrong/absent secret, quota boundary
  conditions, cross-tier counter isolation, health-endpoint isolation, and 429 body
  format against the real application instance.

- **Core rate-limit engine tests**:
  [`src/middleware/rateLimit.test.ts`](../src/middleware/rateLimit.test.ts)
  — covers `InMemoryRateLimitStore` lifecycle, per-IP and per-user keying,
  `Retry-After` header, `keyPrefix` isolation, and IP fallback paths.

- **Property-based tests** (fast-check):
  - [`src/middleware/__tests__/rateLimitStore.property.test.ts`](../src/middleware/__tests__/rateLimitStore.property.test.ts) — Properties 1 and 8 (fixed-window determinism, window-expiry reset)
  - [`src/middleware/__tests__/resolveTier.property.test.ts`](../src/middleware/__tests__/resolveTier.property.test.ts) — Properties 3, 4, 10, 11 (secret mismatch, unknown tier, configurable env var, whitespace trimming)
  - [`src/middleware/__tests__/rateLimitMiddleware.property.test.ts`](../src/middleware/__tests__/rateLimitMiddleware.property.test.ts) — Properties 2, 5, 6, 7, 9 (counter isolation, header correctness, 429 at limit+1, within-limit pass, IP key namespacing)

---

## Related Documents

- [`docs/startup-auth-brute-force-mitigation.md`](startup-auth-brute-force-mitigation.md)
- [`docs/startup-auth-service.md`](startup-auth-service.md)
- [`docs/password-reset-rate-controls.md`](password-reset-rate-controls.md)
