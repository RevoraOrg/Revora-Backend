# User + Session Repositories — Index and Test Coverage

**Paths:**
- `src/db/repositories/userRepository.ts`
- `src/db/repositories/sessionRepository.ts`

**Branch:** `be30-user---session-repositories`  
**Ticket:** RC26Q2-B30

---

## Overview

This document covers the DB repository layer for users and sessions, including the full method index, security assumptions, error-mapping rules, and test coverage details.

---

## UserRepository — Method Index

| Method | Signature | Description |
|---|---|---|
| `findById` | `(id: string) → User \| null` | Fetch a full user row by primary key. Includes `password_hash` for internal use. |
| `findUserById` | `(id: string) → User \| null` | Alias of `findById`; used by `routes/users.ts`. |
| `findByEmail` | `(email: string) → User \| null` | Lookup user by email (used at login). |
| `findUserByEmail` | `(email: string) → User \| null` | Alias of `findByEmail`. |
| `createUser` | `(input: CreateUserInput) → User` | Insert a new user row. Defaults `role` to `"startup"` and `name` to `null`. |
| `updateUser` | `(input: UpdateUserInput) → User` | Partial update of `email`, `password_hash`, or `role`. No-op path if no fields provided. |
| `updatePasswordHash` | `(userId, newPasswordHash) → void` | Direct password hash update (used by change-password flow). |

### Error Mapping — `handlePgError`

```
pg error code 23505 (unique_violation)
  → UniqueConstraintError { field: "email" }

any other pg error
  → re-thrown unchanged (callers handle via HTTP 500)
```

> [!IMPORTANT]
> `handlePgError` is called from both `createUser` and `updateUser`. It translates the raw PostgreSQL wire error into a typed domain error — callers catch `UniqueConstraintError` and return HTTP 409.

---

## SessionRepository — Method Index

| Method | Signature | Description |
|---|---|---|
| `createSession` | `(input: CreateSessionInput) → Session` | Insert a session. Branch: explicit `id` uses 4-col INSERT; no `id` uses 5-col INSERT with `crypto.randomUUID()`. |
| `setSessionMetadata` | `(sessionId, tokenHash, expiresAt) → void` | Update token_hash and expiry on an existing session. |
| `createSessionForUser` | `(userId) → string` | Legacy helper: creates a shell session (empty hash, epoch expiry) and returns its id. |
| `createSessionWithId` | `(userId, sessionId, tokenHash, expiresAt) → string` | Create a fully-formed session with a known id and return that id. |
| `findById` | `(id) → Session \| null` | Find a session by its primary key. |
| `findByParentId` | `(parentId) → Session \| null` | Find the child session of a given parent (reuse detection probe). |
| `revokeSessionAndDescendants` | `(sessionId) → void` | Recursive CTE UPDATE: marks the target session and all its descendants as revoked. Idempotent (`WHERE revoked_at IS NULL` guard). |
| `deleteSessionById` | `(sessionId) → void` | Hard-delete a specific session (used by logout). |
| `deleteAllSessionsByUserId` | `(userId) → void` | Hard-delete all sessions for a user (used by password change). |

---

## Security Assumptions

### UserRepository
1. **`password_hash` is internal** — All read methods return the full `User` row including `password_hash`. Callers (service/route layers) are responsible for stripping it from API responses via `SafeUser` or destructuring.
2. **Email uniqueness** — The `UNIQUE` constraint on `users.email` is enforced at the DB layer. `handlePgError` maps violation to `UniqueConstraintError` for clean 409 responses.
3. **No raw pg errors in client responses** — `handlePgError` re-throws unrecognised errors; the global error handler converts them to opaque 500 responses.
4. **Role is server-controlled** — `createUser` defaults `role: "startup"`; callers cannot inject arbitrary roles via this method.

### SessionRepository
1. **Tokens are never stored raw** — Only `token_hash` values (SHA-256 fingerprints) are persisted. Raw JWTs never reach the DB.
2. **Revocation is idempotent** — `revokeSessionAndDescendants` uses `WHERE revoked_at IS NULL` so multiple calls do not cause errors or double-updates.
3. **Parent-id chaining enables reuse detection** — `findByParentId` is the probe used by `RefreshService`; if a child session already exists, the parent token was already consumed.
4. **`deleteSessionById` vs `deleteAllSessionsByUserId`** — These use `WHERE id = $1` and `WHERE user_id = $1` respectively. Tests confirm the correct column is used to prevent accidental cross-user deletion.

---

## Abuse / Failure Paths

| Scenario | UserRepository behaviour | SessionRepository behaviour |
|---|---|---|
| DB returns 0 rows on INSERT | `throw new Error('Failed to create user')` | `throw new Error('Failed to create session')` |
| DB returns 0 rows on UPDATE | `throw new Error('Failed to update user')` | N/A (SET methods are fire-and-forget) |
| `23505` unique violation | `throw UniqueConstraintError('email')` | N/A (no unique constraints on sessions) |
| Other pg error | re-thrown unchanged | re-thrown unchanged |
| `updateUser` called with no changed fields | `findById` called; returns existing user or throws `'User not found'` | N/A |
| `deleteSessionById` for non-existent session | Resolves normally (`rowCount: 0` is not an error) | — |
| `revokeSessionAndDescendants` called twice | — | Idempotent; second call is a no-op due to `revoked_at IS NULL` guard |

---

## Test Coverage

### userRepository.test.ts

| Describe group | Test cases |
|---|---|
| `findById` | Found (maps all fields), not found, `name: null` → `undefined`, `name` as string |
| `findUserById` | Found, not found |
| `findByEmail` | Found, not found, query parameter assertion |
| `findUserByEmail` | Found, not found |
| `createUser` | Success, defaults role, passes null name, 23505 UniqueConstraintError, non-unique re-throw, empty rows error |
| `updateUser` | Email only, password_hash only, role only, all three, no-op (returns existing), no-op (user not found), 23505 UniqueConstraintError, non-unique re-throw, empty rows error |
| `updatePasswordHash` | Success, rowCount: 0 no-op |

### sessionRepository.test.ts

| Describe group | Test cases |
|---|---|
| `createSession (explicit id)` | Success, empty rows error |
| `createSession (generated id)` | Success (5-col query), null parent_id, non-null parent_id, empty rows error |
| `createSession — mapSession` | parent_id mapped, revoked_at mapped |
| `setSessionMetadata` | Correct params, void return |
| `createSessionForUser` | Returns session id, empty token_hash / epoch expires_at |
| `createSessionWithId` | Creates and returns session id |
| `findById` | Found, not found |
| `findByParentId` | Found, not found |
| `revokeSessionAndDescendants` | CTE query and params, idempotent (two calls) |
| `deleteSessionById` | Correct column (`id`), rowCount: 0 no-op |
| `deleteAllSessionsByUserId` | Correct column (`user_id`), not `id`, rowCount: 0 no-op |
| Legacy compatibility | All 5 original test cases preserved |

---

## Related Modules

- [`lib/errors.ts`](../src/lib/errors.ts) — `UniqueConstraintError` definition
- [`auth/session.ts`](../src/auth/session.ts) — `hashSessionToken`, `isSessionExpired`
- [`auth/refresh/refreshService.ts`](../src/auth/refresh/refreshService.ts) — uses `findSessionById` / `findSessionByParentId` via `RefreshTokenRepository`
- [`middleware/auth.ts`](../src/middleware/auth.ts) — `createRequireAuth` uses `SessionRepository.findById`
- [`docs/auth-session-hardening.md`](./auth-session-hardening.md) — session lifecycle and security design
- [`docs/startup-auth-service.md`](./startup-auth-service.md) — registration flow that calls `UserRepository.createUser`
