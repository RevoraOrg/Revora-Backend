# Refresh Token Absolute Lifetime & Re-authorisation

This document describes the hardening introduced for issue **#1292**: refresh
rotation previously re-issued tokens using the role embedded in the refresh
token payload and reset the 7-day sliding window on every rotation, with no
upper bound. A demoted, suspended, or deleted user could therefore keep an
elevated session alive indefinitely.

The fix makes refresh rotation **re-authorise the caller against the database**
and enforces an **absolute family lifetime**.

## Threat model

| Scenario | Before | After |
| --- | --- | --- |
| Admin demoted to investor | Old refresh token keeps minting `role: admin` access tokens | Next refresh mints the DB role (`investor`) |
| User suspended via SCIM | Suspended user keeps rotating for up to 7 days per hop | Refresh fails closed, family revoked |
| User deleted | `findSessionByIdForUpdate` may still find the session | User lookup returns `null`, family revoked |
| Stolen token kept warm | Family extended 7 days on every use, forever | Rotation refused past the absolute family deadline |

## Design

### 1. Authoritative role & status reload

`RefreshService.refresh` no longer trusts `payload.role`. Inside the rotation
transaction it calls `RefreshUserLookup.findById(userId, client)` and:

1. Rejects a **missing** user (`null`) and revokes the family.
2. Rejects a **disabled** user (`active === false`) and revokes the family.
3. Rejects an **unrecognised role** and revokes the family.
4. Issues the new tokens with the **database role**.

The lookup is a narrow projection (`id`, `role`, `active`) — credentials such
as `password_hash` are never exposed. See
`RefreshUserLookupAdapter` in `src/auth/refresh/repositoryAdapter.ts`.

If no lookup is configured the service **fails closed** (treats the user as
absent). Production wiring in `src/app.ts` always supplies the lookup.

### 2. Absolute family lifetime

A refresh-token *family* is the chain of sessions created by rotation. The new
`sessions.family_expires_at` column holds the immutable deadline for the whole
family:

- Set **once at login** (`computeFamilyExpiresAt()` in `src/auth/session.ts`,
  default 30 days).
- **Inherited verbatim** by every rotated child session.
- Rotation is refused (and the family revoked) once the deadline passes.

The per-session `expires_at` remains a sliding 7-day window; only the family
deadline is fixed.

### 3. Session/user binding

Rotation also rejects a session whose `user_id` does not match the token
subject, revoking the family. This closes a token-forging/re-purposing gap.

## Database changes

Migration `src/db/migrations/061_add_family_expires_at_to_sessions.sql`:

- `sessions.family_expires_at TIMESTAMPTZ NULL` (+ index).
- `users.status VARCHAR(20) NOT NULL DEFAULT 'active'`
  (`active | suspended | disabled | deactivated`, + index).

Both are additive and idempotent. Existing sessions are backfilled with a
family deadline anchored to their family root's `created_at + 30 days`, so no
pre-existing family is granted an unbounded lifetime.

## Security assumptions

- The refresh token is authenticated (signature + claims) before any DB access.
- The role in the refresh token payload is **advisory only**; authorisation is
  always derived from the current DB row.
- The session row is locked `FOR UPDATE` for the duration of the rotation, so
  concurrent rotations of the same session serialise and reuse detection holds.
- Failure to load the user is treated as "not authorised" (fail closed).
- Disabling an account takes effect no later than the next refresh; access
  tokens already issued remain valid until their own short expiry (1 hour).

## Abuse / failure paths

| Condition | Result |
| --- | --- |
| User deleted / not found | `null` + revoke family |
| User disabled (`active === false`) | `null` + revoke family |
| DB role not a known `UserRole` | `null` + revoke family |
| Past `family_expires_at` | `null` + revoke family |
| Session `user_id` ≠ token subject | `null` + revoke family |
| No user lookup configured | `null` + revoke family (fail closed) |
| Legacy row with `family_expires_at = NULL` | Allowed, but role still reloaded |

## Interfaces

```ts
// src/auth/refresh/types.ts
interface RefreshUserRecord { id: string; role: UserRole; active: boolean; }

interface RefreshUserLookup {
  findById(userId: string, client?: PoolClient): Promise<RefreshUserRecord | null>;
}

interface RefreshTokenRepository {
  createSession(input: {
    /* … */ parent_id: string;
    family_expires_at?: Date | null;
  }, client?: PoolClient): Promise<any>;
}
```

## Testing

`src/auth/refresh/refreshService.test.ts` — `RefreshService — authoritative
re-authorisation (#1292)` covers:

- demoted role re-issued from the DB (regression for the stale-role bug),
- deleted user fails closed + revokes family,
- disabled (SCIM-suspended) user fails closed + revokes family,
- rotation past the absolute family deadline is refused,
- child inherits `family_expires_at` verbatim (no extension),
- sliding per-session expiry preserved,
- unrecognised DB role rejected,
- no-lookup configured ⇒ fail closed,
- session/user mismatch rejected,
- lookup runs inside the transaction with the transaction client,
- replay path never reaches re-authorisation.

`src/auth/refresh/repositoryAdapter.test.ts` — `RefreshUserLookupAdapter`
covers projection shape, status/active resolution, and demotion passthrough.

## Rollout notes

1. Apply migration `061` before deploying the new code (the `status` and
   `family_expires_at` columns must exist).
2. Existing refresh tokens issued before deploy remain valid; their families are
   backfilled with a bounded deadline and their role is reloaded on next use.
3. No API contract change: `POST /api/auth/refresh` still returns
   `{ accessToken, refreshToken }` or `401`.
