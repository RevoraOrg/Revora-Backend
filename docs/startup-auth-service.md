# Startup Auth Service

**Path:** `src/services/startupAuthService.ts`
**Branch:** `be14-startup-auth`
**Ticket:** RC26Q2-B14

---

## Overview

`StartupAuthService` is the registration service for startup actors in the Revora platform. It accepts `{ email, password, name? }` and returns a `RegistrationResult` — a discriminated-union result type that is always safe to forward directly to the HTTP response layer.

The service never throws; all error conditions are returned as structured results with appropriate `statusCode` values.

---

## Validation Pipeline

Every `register()` call passes through these stages in order. If any stage fails, later stages are skipped (no unnecessary DB calls).

| Stage | Rule | Client response |
|---|---|---|
| 1. Email format | RFC 5321-compatible regex, 1–254 chars, must have `@` and TLD | 400 `Invalid email address` |
| 2. Password type | Must be a string | 400 `Password must be a string` |
| 3. Password strength | Delegated to `lib/passwordStrength.validatePasswordStrength` (min 12 chars, upper/lower/digit/special required) | 400 `Password does not meet strength requirements` + `details[]` |
| 4. Duplicate check (app layer) | `findByEmail` before insert | 409 `An account with this email already exists` |
| 5. Persist | `createUser` with `role: 'startup'` fixed | 201 + safe user object |
| 6. Duplicate check (DB layer) | `UniqueConstraintError` mapped from pg `23505` | 409 `An account with this email already exists` |

---

## Error Response Contract

All error branches produce **opaque, client-safe** messages. Raw database errors, stack traces, and internal state are **never** forwarded to callers.

```typescript
interface RegistrationResult {
  success:    boolean;
  statusCode: number;       // 201 | 400 | 409 | 500
  user?:      SafeUser;     // only on success; password_hash excluded
  error?:     string;       // human-readable, client-safe
  details?:   string[];     // policy violations on 400 (password strength)
}
```

> [!IMPORTANT]
> `password_hash` is destructured away before the user object is returned. It must never appear in `result.user`.

---

## Structured Logging

All significant events emit structured log entries via `lib/logger.globalLogger`. Sensitive fields (`password`, `token`, `session`, etc.) are automatically redacted by the logger's `SENSITIVE_FIELDS` list.

| Event | Level | Fields logged |
|---|---|---|
| Invalid email format | `WARN` | `emailProvided: boolean` |
| Password policy violation | `WARN` | `violations: number` (count, not details) |
| Duplicate email (app check) | `INFO` | `email` |
| Successful registration | `INFO` | `userId`, `role` |
| `UniqueConstraintError` (DB race) | `WARN` | `field` |
| Unexpected error | `ERROR` | error object (redacted by logger) |

---

## Security Assumptions

1. **Email is normalised** — trimmed and lowercased before the DB check and insert, ensuring the `UNIQUE` constraint and the app-layer check operate on the same canonical form.

2. **Password is hashed before storage** — `lib/hash.hashPassword` (scrypt, 16-byte random salt) is called; the plain-text password is never stored or logged.

3. **Two-layer duplicate detection** — An application-layer `findByEmail` check catches the common case. The `UniqueConstraintError` handler catches the race condition where two concurrent registrations both pass the first check before either inserts.

4. **Role is server-controlled** — `role: 'startup'` is always set server-side; no user-supplied role claim is accepted.

5. **No raw DB errors in client responses** — The `catch` block explicitly distinguishes `UniqueConstraintError` (→ 409) from all other errors (→ opaque 500).

---

## Abuse / Failure Paths

| Scenario | Behaviour |
|---|---|
| Malformed/empty email | 400, no DB call |
| Non-string password | 400, no DB call |
| Password too short or missing character classes | 400 with `details[]`, no DB call |
| Existing account (sequential) | 409, no hash computed, no `createUser` call |
| Concurrent registration race (same email, two requests) | 409 (UniqueConstraintError mapped from DB) |
| `findByEmail` DB crash | 500, raw error logged server-side only |
| `createUser` DB crash (non-unique) | 500, raw error logged server-side only |

---

## Rate Limiting

Startup registration is protected at the router layer by `createStartupRegisterLimiter` (in `src/index.ts`) and by the tier-policy middleware in `src/middleware/startupAuthRateTierPolicy.ts`. The service itself is agnostic to rate limiting.

| Tier | Limit | Window |
|---|---|---|
| `standard` | 5 requests | 15 minutes |
| `trusted` | 10 requests | 15 minutes |
| `internal` | 25 requests | 15 minutes |

---

## Test Coverage

**File:** `src/services/startupAuthService.test.ts`

| Group | Cases |
|---|---|
| Success paths | Registration strips `password_hash`, email normalised to lowercase, name optional, role always `startup` |
| Email validation | 11 invalid email values via `it.each`, no DB calls made |
| Password validation | Non-string, too short, missing uppercase, missing special chars, no stack traces in `details` |
| Duplicate detection | App-layer 409, DB-race `UniqueConstraintError` → 409 (not 500) |
| Opaque DB failures | `findByEmail` crash, `createUser` crash, non-Error thrown — all return 500 without raw error string |

---

## Related Modules

- [`lib/passwordStrength.ts`](../src/lib/passwordStrength.ts) — Password policy engine
- [`lib/hash.ts`](../src/lib/hash.ts) — scrypt-based password hashing
- [`lib/errors.ts`](../src/lib/errors.ts) — `UniqueConstraintError`, `Errors.*`
- [`lib/logger.ts`](../src/lib/logger.ts) — Structured logging with PII redaction
- [`db/repositories/userRepository.ts`](../src/db/repositories/userRepository.ts) — DB layer; maps pg `23505` → `UniqueConstraintError`
- [`middleware/startupAuthRateTierPolicy.ts`](../src/middleware/startupAuthRateTierPolicy.ts) — Rate limiting tiers
- [`docs/auth-session-hardening.md`](./auth-session-hardening.md) — Session hardening reference
