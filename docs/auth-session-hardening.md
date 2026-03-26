# Auth Session Hardening

This document describes the security hardening applied to authentication sessions in Revora Backend.

## Goals

- Prevent use of invalidated or stale tokens after logout / password change.
- Do not rely solely on JWT validity; bind tokens to a server-side session store.
- Keep session tokens short-lived and rotating across login events.

## Core behavior

1. At login:
   - User credentials are verified using timing-safe hash compare (`sha256` currently, to be replaced by argon2/bcrypt in production).
   - A server-side session row is created with an ID, late-bound token fingerprint, and expiry time.
   - JWT includes:
     - `sub`: user ID
     - `sid`: session ID
     - `role`: user role
   - JWT is signed with HS256 using `JWT_SECRET`.
   - Session is updated with hashed token fingerprint and explicit expiry from `SESSION_TTL_MS`.

2. On protected requests (`createRequireAuth`):
   - Validate `Authorization: Bearer <token>` format.
   - Verify JWT signature and expiry (via `lib/jwt`).
   - Reject if `sub` or `sid` missing.
   - Load session row by `sid` from `SessionRepository`.
   - Reject if session is not found, user mismatch, expired, or token hash mismatch.
   - Populate `req.auth` and `req.user` for downstream handlers.

3. Logout
   - Deletes session row by session ID as supplied from `req.auth`.
   - Further bearer tokens referencing the deleted session are rejected by session lookup.

## Security assumptions

- JWT secret is strong and managed outside source code (env var, >=32 chars).
- DB sessions are authoritative; JWTs have asserted expiry but are also revoked on session deletion.
- Tokens are cryptographically bound to session records by hash.

## Abuse / failure paths

- Missing/invalid token => 401
- Session not found or user mismatch => 401
- Token mismatch => 401
- Expired session => 401
- Misconfigured JWT_SECRET => errors at startup / request (500 for runtime checks)

## Testing coverage

- `src/middleware/auth.test.ts` validates both success and all major failure cases.
- `src/routes/health.test.ts` includes scenario for requireAuth session validation and token mismatch.
- Additional coverage via existing login/logout tests.
