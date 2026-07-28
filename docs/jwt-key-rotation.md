# JWT Key Rotation & Claim Validation

## Overview

The Revora-Backend JWT subsystem supports **key rotation**, **clock skew tolerance**, and **issuer/audience claim invariants**. These features ensure seamless secret transitions, resilience against clock drift, and defense against token misuse across services.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes (prod) | Current signing secret. Minimum 32 characters. |
| `JWT_SECRET_PREVIOUS` | No | Previous secret for key rotation. Must be ≥32 chars to be accepted. |
| `JWT_ISSUER` | No | Expected `iss` claim value. When set, tokens without a matching issuer are rejected. |
| `JWT_AUDIENCE` | No | Expected `aud` claim value. When set, tokens without a matching audience are rejected. |
| `JWT_CLOCK_TOLERANCE_SECONDS` | No | Clock skew window for `exp`, `iat`, `nbf` claims. Defaults to 30 seconds. Must be ≥0. |

## Key Rotation

### How It Works

1. `getJwtSecretsForVerification()` returns `[JWT_SECRET, JWT_SECRET_PREVIOUS?]` — current secret first.
2. `verifyToken()` iterates through all secrets; the first one that produces a valid signature wins.
3. When a token is verified with the previous secret, a structured log entry is emitted at `info` level for operational visibility.
4. When all secrets fail, a `warn`-level log is emitted before throwing.

### Rotation Procedure

1. Generate a new secret (≥32 characters).
2. Set `JWT_SECRET_PREVIOUS` to the current `JWT_SECRET` value.
3. Set `JWT_SECRET` to the new secret.
4. Deploy. Tokens signed with the old secret remain valid until they expire naturally.
5. After all old-secret tokens have expired, remove `JWT_SECRET_PREVIOUS`.

### Security Assumptions

- Both secrets must be ≥32 characters. Shorter previous secrets are silently ignored.
- The current secret is always tried first, ensuring minimal latency for the common case.
- Key rotation does **not** extend token lifetime — old tokens still expire at their original `exp`.
- There is no limit on the number of rotation secrets. Only one previous secret is supported to keep the attack surface small.

## Clock Skew Tolerance

### Why

Distributed systems may have minor clock drift between servers. Without tolerance, a token issued by server A might appear expired to server B even though it's still within its intended lifetime.

### Implementation

- `jsonwebtoken`'s built-in `exp`/`nbf` checks are **disabled** (`ignoreExpiration: true`, `ignoreNotBefore: true`).
- `validateClaims()` performs explicit time-based checks with a configurable tolerance window:
  - **`exp`**: token is expired if `exp < now - tolerance`
  - **`iat`**: token is rejected if `iat > now + tolerance`
  - **`nbf`**: token is rejected if `nbf > now + tolerance`
- Default tolerance: **30 seconds**. Configurable via `JWT_CLOCK_TOLERANCE_SECONDS`.

### Abuse Considerations

- Setting tolerance too high effectively extends token lifetime. The default of 30s is a reasonable trade-off.
- Zero tolerance is supported for environments requiring strict time enforcement.
- Negative or non-numeric values are silently ignored, falling back to the 30s default.

## Issuer & Audience Invariants

### Issuer (`iss`)

- When `JWT_ISSUER` is set, every verified token **must** contain an `iss` claim matching the configured value.
- Tokens without an `iss` claim are rejected when validation is enabled.
- `issueToken()` includes `iss` when the `issuer` option is provided.

### Audience (`aud`)

- When `JWT_AUDIENCE` is set, every verified token **must** contain an `aud` claim matching the configured value.
- Both string and array `aud` values are supported (per JWT spec).
- Tokens without an `aud` claim are rejected when validation is enabled.
- `issueToken()` includes `aud` when the `audience` option is provided.

## Error Handling

All JWT verification errors in middleware are propagated as `AppError` instances via `next()`:

| Condition | Error Code | HTTP Status |
|---|---|---|
| Missing Authorization header | `UNAUTHORIZED` | 401 |
| Invalid token format | `UNAUTHORIZED` | 401 |
| Expired token (beyond tolerance) | `UNAUTHORIZED` | 401 |
| Issuer/audience mismatch | `UNAUTHORIZED` | 401 |
| Non-investor role | `FORBIDDEN` | 403 |
| JWT_SECRET not configured | `INTERNAL_ERROR` | 500 |

The global `errorHandler` middleware (mounted in `app.ts`) converts these into structured JSON responses. Non-`AppError` thrown values are always downgraded to a generic 500 to prevent information leakage.

## Structured Logging

| Event | Level | Context |
|---|---|---|
| Token verified with previous secret | `info` | `{ secretIndex }` |
| All secrets failed verification | `warn` | `{ error, secretCount }` |
| JWT verification failed in middleware | `warn` | `{ error }` |

## Test Coverage

Tests cover the following scenarios in `src/lib/jwt.test.ts` and `src/middleware/auth.test.ts`:

- **Key rotation**: current secret, previous secret, missing previous, unknown secret, short previous secret
- **Clock skew**: within tolerance, beyond tolerance, zero tolerance, large tolerance, default 30s boundary
- **Issuer/audience**: match, mismatch, missing claim, string aud, array aud, both together
- **validateClaims**: missing sub, whitespace sub, non-string sub, expired, future iat, future nbf
- **getDefaultClaimValidationOptions**: empty env, each env var individually, all together, non-numeric tolerance, negative tolerance, Infinity, zero
- **Middleware**: AppError propagation via `next()`, correct status codes, session validation edge cases
