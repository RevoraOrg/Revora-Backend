# JWT Claim Validation

## Overview
This document details the explicit validation of standard JWT claims in the Revora Backend.
Beyond HMAC-HS256 signature verification (already enforced by `jsonwebtoken`), the system
now validates each security-relevant claim in the token payload independently to prevent
claim confusion, replay, and timing abuse.

## Implementation Details
- `src/lib/jwt.ts` — Extended `JwtPayload` with `nbf`, `iss`, and `aud` fields. Added
  `ClaimValidationOptions` interface and `validateClaims()` function. Updated `verifyToken()`
  to accept optional `ClaimValidationOptions` and call `validateClaims` after signature
  verification.
- `src/index.ts` — Added `jwtClaimValidationMiddleware()` which extracts the Bearer token,
  calls `verifyToken` with claim options, attaches the validated payload to `req.user`, and
  returns descriptive 401/500 JSON responses for each failure path. Added
  `GET ${API_VERSION_PREFIX}/me` as a protected endpoint scoped within the versioned API boundary.
- Error responses follow the `{ error: 'Unauthorized', message: '...' }` convention
  consistent with `src/middleware/auth.ts`.

## Security Assumptions & Abuse/Failure Paths
1. **Sub Claim Absence Attack:** A token signed without a `sub` claim passes HMAC signature
   verification and would propagate `req.user.sub = undefined` to route handlers. `validateClaims`
   now explicitly rejects such tokens with a 401 before any handler executes.
2. **Future-dated `iat` Manipulation:** `jsonwebtoken.verify` does not check `iat`. An
   attacker could sign a token with `iat` far in the future (extending perceived validity beyond
   `exp`). `validateClaims` rejects any token whose `iat` exceeds `now + clockToleranceSeconds`
   (default 30s), closing this replay vector.
3. **Pre-issuance `nbf` Delivery:** Tokens with `nbf` set in the future are rejected with
   "not yet valid" — both by `jsonwebtoken`'s `NotBeforeError` and independently by
   `validateClaims` when called standalone. The middleware catch-block maps `NotBeforeError`
   to the canonical error message.
4. **JWT_SECRET Misconfiguration Leak:** When `JWT_SECRET` is absent, `getJwtSecret()` throws
   synchronously inside the middleware's try-catch. The middleware pattern-matches this message
   and returns HTTP 500 (`Server configuration error`) rather than a generic 401, ensuring
   operators can distinguish configuration failure from a bad client token without leaking
   token material.
5. **Payload Swap / Signature Tampering:** Modifying the base64url payload while retaining the
   original signature is detected as `JsonWebTokenError` by `jsonwebtoken` and mapped to
   "Invalid token signature" with a 401. This branch is explicit and does not fall through
   to claim validation.

## Testing Strategy
- All claim validation tests reside in `describe('JWT Claim Validation tests', ...)` appended
  to `src/routes/health.test.ts`.
- Tests use `supertest` against the live `app` instance to exercise the full Express middleware
  chain end-to-end through `GET /api/v1/me`.
- Expired and missing-sub tokens are crafted via `jsonwebtoken.sign` directly, bypassing the
  `issueToken` wrapper which requires a `subject`.
- Clock-skew edge cases (future `iat`, future `nbf`) use numeric claim values 2 hours ahead
  of `now`, safely outside the 30-second tolerance window.
- The `JWT_SECRET` misconfiguration test deletes the environment variable and restores it in
  `afterEach` to prevent state leakage into subsequent test suites.

### Test Output and Security Notes (`npx jest src/routes/health.test.ts`)
```text
PASS src/routes/health.test.ts
  Health Router
    √ should return 200 when both DB and Stellar are up
    √ should return 503 when DB is down
    √ should return 503 when Stellar Horizon is down
    √ should return 503 when Stellar Horizon returns non-OK status
    √ should create returning router instance
  API Version Prefix Consistency tests
    √ should resolve /health without API prefix
    √ should resolve api routes with API_VERSION_PREFIX
    √ should return 404 for api routes without prefix
    √ should correctly scope protected endpoints under the prefix
    √ should 404 for protected endpoints if prefix is lacking
  JWT Claim Validation tests
    √ should return 200 and user claims for a valid token
    √ should return 401 when Authorization header is missing
    √ should return 401 for non-Bearer authorization scheme
    √ should return 401 with "Token has expired" for an expired token
    √ should return 401 when sub claim is missing
    √ should return 401 when iat claim is in the future
    √ should return 401 when nbf claim is in the future
    √ should return 401 for a tampered token (invalid signature)
    √ should return 401 for a token with invalid format
    √ should return 500 when JWT_SECRET is not configured

Test Suites: 1 passed, 1 total
Tests:       20 passed, 20 total
```
All 10 new JWT Claim Validation tests pass alongside the 10 pre-existing tests with zero regressions.
