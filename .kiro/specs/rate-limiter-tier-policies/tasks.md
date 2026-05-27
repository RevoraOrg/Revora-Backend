# Implementation Plan: Rate Limiter Tier Policies

## Overview

The core middleware (`src/middleware/rateLimit.ts` and `src/middleware/startupAuthRateTierPolicy.ts`) is already implemented. This plan focuses on closing coverage gaps, adding the full property-based test suite defined in the design, hardening the security documentation, and verifying the middleware is correctly wired into the application. Tasks are ordered so each step builds on the previous and nothing is left orphaned.

## Tasks

- [x] 1. Audit and complete unit test coverage in `rateLimit.test.ts`
  - [x] 1.1 Add missing `InMemoryRateLimitStore` unit tests
    - Add test: `increment` on a key with an expired window creates a new window with `count = 1` (covers Requirement 6.3)
    - Add test: `increment` returns the same `resetAt` for all calls within the same window (covers Requirement 6.4)
    - Add test: `clear()` is a no-op on an already-empty store (covers Requirement 6.6 edge case)
    - Add test: `reset()` on a non-existent key does not throw (covers Requirement 6.5 edge case)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 1.2 Add missing `createRateLimitMiddleware` unit tests
    - Add test: `X-RateLimit-Remaining` is exactly `0` (not negative) when count equals limit (covers Requirement 4.5)
    - Add test: `X-RateLimit-Remaining` is `0` on the blocked (limit+1) request (covers Requirement 4.5)
    - Add test: `Retry-After` header is present and is a positive integer on a 429 response (covers Requirement 3.3)
    - Add test: `next()` is called with an `AppError` whose `code === 'TOO_MANY_REQUESTS'` on the blocked request (covers Requirement 8.5)
    - Add test: IP fallback to `req.socket.remoteAddress` when `req.ip` is undefined (covers Requirement 5.3)
    - Add test: IP fallback to `'unknown'` when both `req.ip` and `req.socket.remoteAddress` are undefined (covers Requirement 5.4)
    - Add test: `keyPrefix` is reflected in the scoped key — two middleware instances with different prefixes sharing a store do not interfere (already partially covered; add assertion on key format) (covers Requirement 5.6)
    - _Requirements: 3.3, 4.5, 5.3, 5.4, 5.6, 8.5_

- [x] 2. Audit and complete unit test coverage in `startupAuthRateTierPolicy.test.ts`
  - [x] 2.1 Add missing `resolveTier` unit tests
    - Add test: `resolveTier` returns `'standard'` when tier header is `'trusted'` but secret header is absent (covers Requirement 2.3)
    - Add test: `resolveTier` returns `'standard'` when tier header is `'internal'` but secret header is absent (covers Requirement 2.3)
    - Add test: `resolveTier` returns `'internal'` when tier header is `'internal'` and secret matches (covers Requirement 2.2)
    - Add test: `resolveTier` returns `'standard'` when `STARTUP_AUTH_TIER_SECRET` env var is not set (covers Requirement 2.6 / error path)
    - Add test: `resolveTier` trims whitespace from env var value before comparison (covers Requirement 12.4)
    - Add test: `resolveTier` trims whitespace from secret header value before comparison (covers Requirement 12.5)
    - Add test: `resolveTier` uses a custom `tierSecretEnvName` when provided (covers Requirement 12.3)
    - Add test: `resolveTier` defaults to `'STARTUP_AUTH_TIER_SECRET'` env var name when `tierSecretEnvName` is not provided (covers Requirement 12.2)
    - _Requirements: 2.2, 2.3, 2.6, 12.2, 12.3, 12.4, 12.5_

  - [x] 2.2 Add missing middleware integration tests
    - Add test: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers are all present on a 201 response (covers Requirement 4.1, 4.2, 4.3)
    - Add test: `X-RateLimit-Tier` header is `'standard'` when no tier header is sent (covers Requirement 4.4)
    - Add test: 429 response body contains the exact tier-specific `message` string for standard tier (covers Requirement 8.2)
    - Add test: 429 response body contains the exact tier-specific `message` string for trusted tier (covers Requirement 8.3)
    - Add test: 429 response body contains the exact tier-specific `message` string for internal tier (covers Requirement 8.4)
    - Add test: spoofed trusted-tier request (valid tier header, wrong secret) is downgraded and consumes from the standard counter, not the trusted counter (covers Requirement 2.4, 1.6)
    - Add test: `/health` endpoint is unaffected when `/startup/register` is rate-limited (mount both on a test app) (covers Requirement 7.5)
    - Add test: a custom `store` passed to `createStartupAuthTierLimiter` is used instead of the default (covers Requirement 11.1)
    - _Requirements: 1.6, 2.4, 4.1, 4.2, 4.3, 4.4, 7.5, 8.2, 8.3, 8.4, 11.1_

  - [x] 2.3 Assert exact policy constant values
    - Add test: `STARTUP_AUTH_RATE_TIER_POLICIES.standard` has `limit: 5`, `windowMs: 900_000`, and the exact message string (covers Requirement 1.2, 8.2)
    - Add test: `STARTUP_AUTH_RATE_TIER_POLICIES.trusted` has `limit: 10`, `windowMs: 900_000`, and the exact message string (covers Requirement 1.3, 8.3)
    - Add test: `STARTUP_AUTH_RATE_TIER_POLICIES.internal` has `limit: 25`, `windowMs: 900_000`, and the exact message string (covers Requirement 1.4, 8.4)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 8.2, 8.3, 8.4_

- [x] 3. Checkpoint — run existing tests to establish a baseline
  - Run `npm run test:coverage:backend-011` (or `npx jest --testPathPattern="middleware/rateLimit|middleware/startupAuthRateTierPolicy" --coverage --coverageReporters=text`).
  - Confirm all existing tests pass before adding property tests.
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement property-based tests for `InMemoryRateLimitStore` (Properties 1, 8)
  - Create `src/middleware/__tests__/rateLimitStore.property.test.ts`
  - Import `fc` from `fast-check` and `InMemoryRateLimitStore` from `../rateLimit`

  - [x]* 4.1 Write property test for Property 1 — Fixed-window counter is deterministic
    - **Property 1: Fixed-window counter is deterministic**
    - **Validates: Requirements 1.5, 6.4**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 1: Fixed-window counter is deterministic`
    - Generate `n` in `[1, 25]`; call `store.increment('key', 60_000)` n times; assert each returned `count === i+1` and all `resetAt` values are identical

  - [x]* 4.2 Write property test for Property 8 — Window expiry resets the counter to 1
    - **Property 8: Window expiry resets the counter to 1**
    - **Validates: Requirements 3.5, 6.3**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 8: Window expiry resets the counter to 1`
    - Use a 1 ms window; increment once; wait >1 ms; increment again; assert `count === 1` and new `resetAt > old resetAt`

- [x] 5. Implement property-based tests for `resolveTier` (Properties 3, 4, 10, 11)
  - Create `src/middleware/__tests__/resolveTier.property.test.ts`
  - Import `fc`, `createStartupAuthTierLimiter`, `STARTUP_AUTH_RATE_TIER_HEADER`, `STARTUP_AUTH_TIER_SECRET_HEADER`
  - Define a `makeRequest(headers)` helper consistent with the one in `startupAuthRateTierPolicy.test.ts`

  - [x]* 5.1 Write property test for Property 3 — Elevated tier requires exact secret match
    - **Property 3: Elevated tier requires exact secret match**
    - **Validates: Requirements 2.4, 2.7**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 3: Elevated tier requires exact secret match`
    - Generate `tier` from `['trusted', 'internal']`, `configuredSecret` and `providedSecret` as non-empty strings with `fc.pre(configuredSecret !== providedSecret)`; assert `resolveTier` returns `'standard'`

  - [x]* 5.2 Write property test for Property 4 — Unknown tier header always resolves to standard
    - **Property 4: Unknown tier header always resolves to standard**
    - **Validates: Requirements 2.1, 2.5**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 4: Unknown tier header always resolves to standard`
    - Generate arbitrary string `tierValue` with `fc.pre(tierValue !== 'trusted' && tierValue !== 'internal')`; assert `resolveTier` returns `'standard'` regardless of secret

  - [x]* 5.3 Write property test for Property 10 — Configurable tier secret env var name
    - **Property 10: Configurable tier secret env var name**
    - **Validates: Requirements 12.1, 12.3**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 10: Configurable tier secret env var name`
    - Generate valid env var name (regex `^[A-Z_][A-Z0-9_]*$`), non-empty secret, and elevated tier; set `process.env[envName] = secret`; create limiter with `tierSecretEnvName`; assert `resolveTier` returns the requested tier; clean up env var in `afterEach`

  - [x]* 5.4 Write property test for Property 11 — Whitespace trimming on both secret sides
    - **Property 11: Whitespace trimming on both secret sides**
    - **Validates: Requirements 12.4, 12.5**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 11: Whitespace trimming on both secret sides`
    - Generate a secret `s` where `s.trim() === s && s.length > 0`; test env var padded / header clean, then env var clean / header padded; assert both resolve to the elevated tier

- [x] 6. Implement property-based tests for enforcement middleware (Properties 2, 5, 6, 7, 9)
  - Create `src/middleware/__tests__/rateLimitMiddleware.property.test.ts`
  - Import `fc`, `express`, `supertest`, `createStartupAuthTierLimiter`, `STARTUP_AUTH_RATE_TIER_POLICIES`, header constants
  - Define a `makeApp(secret?)` helper that mounts the tier limiter on `/startup/register`

  - [x]* 6.1 Write property test for Property 2 — Counter isolation across tiers
    - **Property 2: Counter isolation across tiers**
    - **Validates: Requirements 1.6, 9.8**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 2: Counter isolation across tiers`
    - Generate two distinct tiers `T1 !== T2` and an IPv4 address; exhaust T1's limit; assert T2 still returns 2xx on its first request

  - [x]* 6.2 Write property test for Property 5 — Rate limit headers present and correct on every response
    - **Property 5: Rate limit headers are present and correct on every response**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 5: Rate limit headers are present and correct on every response`
    - Generate tier and request count `N` in `[1, 30]`; for each of N requests assert `X-RateLimit-Limit === policy.limit`, `X-RateLimit-Remaining === max(0, limit - n)`, `X-RateLimit-Reset` is a positive integer, `X-RateLimit-Tier === tier`

  - [x]* 6.3 Write property test for Property 6 — The (limit+1)th request is always blocked with a structured 429
    - **Property 6: The (limit+1)th request is always blocked with a structured 429**
    - **Validates: Requirements 3.1, 3.2, 3.3, 8.1, 8.5**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 6: The (limit+1)th request is always blocked with a structured 429`
    - Generate tier; send `limit` requests (all 2xx); send one more; assert 429, non-empty `message` matching `STARTUP_AUTH_RATE_TIER_POLICIES[tier].message`, and `Retry-After` is a positive integer

  - [x]* 6.4 Write property test for Property 7 — Requests within the limit always call next() without error
    - **Property 7: Requests within the limit always call next() without error**
    - **Validates: Requirements 3.4, 7.3**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 7: Requests within the limit always call next() without error`
    - Generate tier and count `N` in `[1, min_limit]` (use standard limit = 5 as the safe upper bound); assert all N responses are 2xx

  - [x]* 6.5 Write property test for Property 9 — IP key derivation is consistent and namespaced
    - **Property 9: IP key derivation is consistent and namespaced**
    - **Validates: Requirements 5.1, 5.5, 5.6**
    - Tag comment: `// Feature: rate-limiter-tier-policies, Property 9: IP key derivation is consistent and namespaced`
    - Generate IPv4 addresses; use a spy/mock on `store.increment` to capture the scoped key; assert key starts with the tier prefix, contains `'ip:'`, and contains the IP string

- [ ] 7. Checkpoint — run full property-based test suite
  - Run `npx jest --testPathPattern="middleware/__tests__" --coverage --coverageReporters=text`
  - Confirm all property tests pass and no flakiness is observed.
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Harden security documentation in `docs/rate-limiter-tier-policies.md`
  - [ ] 8.1 Expand Security Assumptions section to cover all seven design assumptions
    - Add: "`x-revora-rate-tier` is treated as untrusted client input; it is never trusted without a matching secret" (covers Requirement 10.1)
    - Add: "Elevated tiers require a valid `x-revora-tier-secret` header matching `process.env.STARTUP_AUTH_TIER_SECRET`" (covers Requirement 10.2)
    - Add: "Missing or invalid secret results in silent downgrade to standard tier; no error is returned to the client" (covers Requirement 10.3)
    - Add: "The application must be deployed with `app.set('trust proxy', 1)` for stable IP-based keying behind a reverse proxy" (covers Requirement 10.4)
    - Add: "The in-memory store is process-local; multi-instance deployments require a shared store implementing `RateLimitStore`" (covers Requirement 10.5)
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [ ] 8.2 Add Abuse Scenarios and Failure Paths sections
    - Add Abuse Scenarios subsection: header spoofing (mitigated by secret validation), invalid tier names (silently downgraded), cross-tier counter exhaustion (prevented by key isolation) (covers Requirement 10.6)
    - Add Failure Paths subsection: store errors propagate as unhandled exceptions; missing IP falls back to `'unknown'`; missing env var defaults all requests to standard tier (covers Requirement 10.7)
    - _Requirements: 10.6, 10.7_

  - [ ] 8.3 Add `RateLimitStore` interface documentation for distributed deployments
    - Document the `RateLimitStore` interface contract (`increment`, `reset`, `clear?`)
    - Note that implementors should catch internal errors and either re-throw as `AppError` or fail-open
    - _Requirements: 11.2, 11.3, 11.4, 11.6_

- [ ] 9. Verify middleware is wired into the application
  - [ ] 9.1 Confirm `createStartupAuthTierLimiter` is applied to the startup registration route
    - Search `src/` for the route that handles `POST /startup/register` (or equivalent)
    - If the limiter is not yet applied, import `createStartupAuthTierLimiter` from `./middleware/startupAuthRateTierPolicy` and mount it before the route handler
    - Ensure `app.set('trust proxy', 1)` is present in the Express bootstrap (covers Requirement 10.4)
    - _Requirements: 7.1, 7.2, 7.5_

  - [ ] 9.2 Confirm `/health` route is not behind the tier limiter
    - Verify the health endpoint is registered before or outside the rate-limited router
    - Add or confirm an integration test that hits `/health` after exhausting the startup register limit and asserts a 200 response
    - _Requirements: 7.5, 9.7_

- [ ] 10. Final coverage check and cleanup
  - Run `npm run test:coverage:backend-011` (or the equivalent Jest coverage command for the middleware files)
  - Confirm ≥ 95% statements, branches, functions, and lines for `src/middleware/rateLimit.ts` and `src/middleware/startupAuthRateTierPolicy.ts`
  - Remove any temporary debug logs or `console.log` statements introduced during development
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP, but are required to reach the 95% coverage target
- Property tests use `fast-check` which is already in `devDependencies`
- Each property test file must include the tag comment `// Feature: rate-limiter-tier-policies, Property N: <text>` above the `fc.assert` call for traceability
- The `src/security/rateLimit.ts` file is a separate, unrelated security module — do not modify it as part of this feature
- All property tests should call `limiter.reset()` or use a fresh store in `beforeEach` to prevent counter state leaking between test iterations
- The `tierSecretEnvName` env var must be cleaned up in `afterEach` to prevent test pollution
