# Refresh Rotation Re-authorisation Security Assumptions

Security assumptions, threat model, and abuse/failure paths for the fix to
issue **#1292** (refresh rotation re-issuing the role from the stale token
payload).

## Overview

`RefreshService.refresh` previously destructured `{ sessionId, userId, role }`
from the verified refresh token and re-issued access tokens with that role.
The user's current role and account status were never reloaded, and each
rotation reset the 7-day sliding window with no absolute cap. A demoted admin
or SCIM-suspended user could therefore keep an elevated session alive forever.

The hardened flow reloads authoritative user state on every rotation and
enforces an absolute family lifetime.

## Threat Model

### Attack Vectors Prevented

1. **Privilege retention after demotion**
   - A stale `admin` (or `startup`) refresh token no longer mints access tokens
     with the old role; the role is read from the `users` row.

2. **Privilege retention after de-provisioning**
   - Deleted users (`findById` → `null`) and disabled users
     (`active === false` / `status != 'active'`) are rejected and their session
     family revoked.

3. **Indefinite session lifetime**
   - `family_expires_at` is fixed at login and inherited by every rotated child.
     Rotation past the deadline is refused.

4. **Token/session re-binding**
   - A session whose `user_id` differs from the token subject is rejected and
     the family revoked.

5. **Fail-open on missing authorisation source**
   - If no `RefreshUserLookup` is configured, rotation fails closed (user
     treated as absent) rather than trusting the token payload.

## Security Assumptions

### Token authenticity

- **Assumption**: The refresh token has passed signature and claim validation
  before any database access.
- **Risk**: A forged token could reference an arbitrary session.
- **Mitigation**: `verifyRefreshToken` runs outside the transaction and any
  failure returns `null` without touching the DB.

### Authoritative identity source

- **Assumption**: The `users` table is the single source of truth for role and
  status.
- **Risk**: A stale/cached role re-issues elevated tokens.
- **Mitigation**: Every rotation reloads the user via `RefreshUserLookup`;

  
  the token role is treated as advisory only.

### Absolute lifetime source of truth

- **Assumption**: `family_expires_at` is set at login and never rewritten.
- **Risk**: A rotation could extend the family indefinitely.
- **Mitigation**: Children copy the parent deadline verbatim; the value is only
  ever compared, never advanced.

### Transactional isolation

- **Assumption**: `findSessionByIdForUpdate` locks the session row `FOR UPDATE`.
- **Risk**: Concurrent rotations could bypass reuse detection or read a
  half-updated status.
- **Mitigation**: The lock serialises rotations of the same session; the user
  lookup and family check run inside the same transaction.

### Access-token residual validity

- **Assumption**: Access tokens are short-lived (1 hour) and not revocable
  server-side.
- **Risk**: A demoted user keeps the old access token valid until it expires.
- **Mitigation / Limitation**: The window is bounded to the access-token TTL.
  Demotion therefore takes effect within one access-token lifetime (the next
  refresh returns the new role).

## Abuse / Failure Paths

| Condition | Action | Family revoked | Logged |
| --- | --- | --- | --- |
| User not found | return `null` | yes | warn |
| User disabled | return `null` | yes | warn |
| DB role not a known `UserRole` | return `null` | yes | warn |
| Past `family_expires_at` | return `null` | yes | warn |
| Session `user_id` ≠ token subject | return `null` | yes | warn |
| No user lookup configured | return `null` | yes | warn |
| Legacy row, `family_expires_at = NULL` | allow, reload role | no | — |

All warning logs contain only stable identifiers (`userId`, `sessionId`) and
timestamps — never the raw refresh token or its prefix.

## Logging

- Raw refresh tokens and token prefixes must never be logged.
- Role changes are not logged with old/new values at `info` level to avoid
  leaking authorisation intent; only the resolved role is recorded on a
  successful rotation.

## Testing

- `src/auth/refresh/refreshService.test.ts` — `RefreshService — authoritative
  re-authorisation (#1292)`.
- `src/auth/refresh/repositoryAdapter.test.ts` — `RefreshUserLookupAdapter`.
- `src/db/repositories/userRepository.test.ts` — status mapping/update.
- `src/db/repositories/sessionRepository.test.ts` — `family_expires_at`
  propagation.

## References

- [docs/refresh-token-absolute-lifetime-and-reauth.md](../refresh-token-absolute-lifetime-and-reauth.md)
- [docs/refresh-token-rotation.md](../refresh-token-rotation.md)
- [docs/refresh-token-replay-detection.md](../refresh-token-replay-detection.md)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
