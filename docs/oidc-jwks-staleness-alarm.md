# OIDC JWKS Cache Staleness Alarm and Force Refresh

## Purpose

An OIDC provider's JWKS bundle can silently go stale: the refresh cadence is
fixed (1h TTL) and a stuck cache keeps rejecting freshly rotated IdP keys.
This feature provides:

1. **A staleness alarm** — `oidc.jwks.age_seconds` gauge, labeled per issuer,
   re-emitted on an interval so alerting can see the *current* age of each
   cached bundle.
2. **An admin-only force-refresh endpoint** — `POST /auth/oidc/jwks/refresh`
   (and the `POST /api/auth/oidc/jwks/refresh` alias) to reload JWKS bundles
   during incidents, gated by dual-control approval and rate-limited.

## Design

### Staleness tracking and the age gauge (`src/auth/oidc/jwksCache.ts`)

- Every successful refresh records `issuerLastRefresh[issuer] = fetchedAt`
  (epoch ms). `getCacheAgeSeconds(issuer)` returns the elapsed age.
- `JwksCacheService.startAgeGaugeTicker(intervalMs)` re-emits
  `oidc.jwks.age_seconds{issuer=…}` for every tracked issuer on an interval
  (default 1 minute), so the gauge reflects real elapsed time rather than the
  value captured at the last refresh. The timer is `unref()`'d (never keeps
  the process alive), idempotent to start, and `stopAgeGaugeTicker()` shuts it
  down.
- The gauge is also re-emitted immediately after every successful refresh
  (value ≈ 0), so the drop to ~0 is the signal a force-refresh worked.
- `getTrackedIssuers()` exposes the issuers with at least one successful
  refresh; this drives "refresh all tracked issuers".

### Request coalescing (single upstream fetch)

All refreshes to the **same `jwks_uri`** — whether triggered by the TTL path
(`getKey`), a signature-failure rotation, or the admin force-refresh endpoint
— are coalesced into a single in-flight `fetch()`:

- Callers arriving while a fetch is pending share the same promise.
- Each waiter registers the issuer it cares about (`pendingIssuers[uri]`), so
  **every** issuer that waited gets its `issuerLastRefresh`/gauge updated when
  the shared fetch succeeds (covers multi-issuer IdPs that share a JWKS URI).
- On **failure** the in-flight slot is released and no issuer bookkeeping is
  updated — a retry performs a fresh upstream fetch. Failures are never cached.

### Dual-control approval gate (`src/auth/oidc/jwksRefreshApprovalGate.ts`)

The endpoint follows the two-step, distinct-approver pattern used elsewhere in
this codebase (OFAC review queue, tenant settings proposal/approval, ledger
period-close):

1. **Step 1 — propose.** Admin A calls `POST /auth/oidc/jwks/refresh` with
   `{ "issuer": "https://idp.example.com" }` (omit `issuer` to target **all
   tracked issuers**). The gate records A as the proposer (first approval) and
   returns `202` with an `approvalId` and expiry. Nothing is refreshed.
2. **Step 2 — approve + execute.** A *different* admin B calls
   `POST /auth/oidc/jwks/refresh` with `{ "approvalId": "…" }` within the time
   window (default 5 minutes). The gate verifies B ≠ A, then the handler
   executes the reload (specific issuer, or all tracked issuers) and returns
   `200` with the refreshed issuers.

Guarantees:

- **Collusion guard** — self-approval is rejected (`403`); the proposer can
  never be the approver.
- **Expiry** — approvals expire after `ttlMs`; expired approvals are rejected
  (`409`) and lazily swept, mirroring the OFAC review expiry/reset semantics.
- **Scope dedupe** — one active approval per scope (issuer, or `*` for all);
  a second proposal for the same scope returns `409` with the existing
  `approvalId` so the second admin can proceed.
- **Single execution** — an already-executed approval cannot be approved again
  (`409`), so racing step-2 calls cannot double-refresh.
- **Partial failure** — refresh-all runs each issuer independently; failures
  are reported in the response (`502` when all fail) and audited.

> **Review flag (new pattern).** The repo's other dual-control flows are
> DB-backed; this gate is deliberately **in-memory and process-local** because
> it guards an idempotent, low-risk cache reload. A restart discards pending
> approvals — the worst case is a re-proposal, which is safe. If multi-instance
> coordination or persistent audit trails are required later, the gate should
> move to a shared backing store.

### Rate limiting

The endpoint reuses the shared `createRateLimitMiddleware`
(`src/middleware/rateLimit.ts`) with `perUser: true`, keyed on the verified
admin identity (`req.user.id` mirrored to `sub` after `requireAdmin` — the
limiter's documented per-user key), default `10 requests / minute / admin`,
isolated with `keyPrefix: 'oidc-jwks-refresh'`. Both dual-control steps share
one bucket. Each router instance should pass a dedicated `store` when multiple
router instances exist in one process (the tests do this) so buckets do not
bleed across instances.

### Audit events

Every outcome emits an audit event through the existing `auditRefresh` hook:

| Event | Fields |
| --- | --- |
| Proposal (`pending_second_approval`) | `timestamp`, `actorId`, `proposerId`, `approvalId`, `issuer`/`scope` |
| Approval + execution (`success`/`failed`) | `timestamp`, `approverId`, `proposerId`, `approvalId`, `issuers` (refreshed), `failed` |
| Blocked | `timestamp`, `actorId`, `approvalId`, `status: 'blocked'`, `reason` (`unknown_approval`, `expired_approval`, `self_approval`, `already_approved`, `duplicate_proposal`) |

Rate-limit rejections are handled by the middleware and do not emit audit
events (same convention as the other middleware-limited routes).

### Security assumptions

- `requireAdmin` runs before anything else; non-admin callers are rejected
  before the gate or limiter are touched.
- Approver/proposer identities come from the verified JWT (`req.user.id`),
  never from client-supplied body fields.
- No PII in metrics labels — only issuer URLs and admin identifiers.
- Unclassified gate/handler errors fall through to the error handler (500)
  without leaking internal details.

## Files changed

- `src/auth/oidc/jwksCache.ts` — age gauge + ticker, tracked issuers,
  multi-issuer coalescing hardening.
- `src/auth/oidc/jwksRefreshApprovalGate.ts` — new in-memory dual-control gate.
- `src/auth/oidc/oidcAdapterService.ts` — `refreshAllJwks()` (partial-failure
  reporting), `getTrackedJwksIssuers()`; also fixed a pre-existing bug where
  `consumedJtis` (backchannel-logout replay protection) was never declared.
- `src/auth/oidc/oidcRoute.ts` — dual-control force-refresh endpoint, shared
  rate-limit middleware, enriched audit events.
- `src/index.ts` — removed a duplicate `const amlAuditRepo` declaration
  (merge artifact) that broke `npm test`.

## Testing

```sh
npx jest --runInBand src/auth/oidc/
```

The full OIDC module (7 suites, 177 tests) passes: **99.8% statements, 100%
branches, 98.5% functions, 100% lines** on `src/auth/oidc/*.ts`. The rate-limit
middleware suite (31 tests) passes unchanged. See the PR description for the
full `npm test` output and coverage report.
