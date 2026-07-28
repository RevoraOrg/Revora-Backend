# OIDC JWKS Cache Staleness Alarm and Force Refresh

## Purpose

This document describes the implementation of a per-issuer OIDC JWKS cache age gauge and an admin-only endpoint to force refresh cached JWKS bundles.

## Changes

- `src/auth/oidc/jwksCache.ts`
  - Added `JwksCacheService.refresh()` with in-flight request coalescing.
  - Added per-issuer `issuerLastRefresh` tracking.
  - Emit `oidc.jwks.age_seconds` gauge with label `issuer`.
  - Added `getCacheAgeSeconds(issuer)` helper.

- `src/auth/oidc/oidcAdapterService.ts`
  - Forward issuer URL to JWKS cache lookups so cache age is tracked per issuer.
  - Added `refreshJwks(issuerUrl)` for service-driven refreshes.

- `src/auth/oidc/oidcRoute.ts`
  - Added admin-only POST `/api/auth/oidc/jwks/refresh` endpoint.
  - Requires dual confirmation: both header `x-revora-oidc-jwks-confirmation: true` and body `confirmation: true`.
  - Enforces per-actor rate limiting (1 request per 60 seconds).
  - Emits audit events via optional `auditRefresh` hook.

## Security and correctness notes

- The refresh endpoint is protected by `requireAdmin`.
- Dual confirmation mitigates accidental refreshes and provides an explicit incident escalation step.
- Rate limiting prevents repeated attacker/exhaustion attempts from a valid admin session.
- Concurrent refresh requests for the same JWKS URI coalesce into a single upstream fetch.
- Cache age metrics call out stale issuer state for monitoring and alerting.

## Testing

- `npx jest --runInBand src/auth/oidc/oidc.test.ts`
- Verified 34 passing tests for both `JwksCacheService` and `createOidcRouter` refresh behavior.
