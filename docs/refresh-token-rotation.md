# Refresh Token Rotation

This document describes the implementation of Refresh Token Rotation in the Revora Backend.

## Overview

Refresh Token Rotation is a security mechanism where every time a refresh token is used to issue a new access token, a new refresh token is also issued. The old refresh token is then invalidated. This helps mitigate the risk of refresh token theft.

## Architecture

### Token Lineage

We track the lineage of refresh tokens using a `parent_id` in the `sessions` table. 
- A new login creates a "root" session.
- A refresh operation creates a new session where `parent_id` points to the session of the refresh token being used.

### Reuse Detection

When a refresh token is used, we check:
1. If the stored session row is expired.
2. If the token hash matches the session's stored token hash.
3. If the session has already been consumed by a completed rotation.
4. If the session has already been revoked.
5. If the session already has a "child" session (meaning this token was already rotated).

If a token is consumed, revoked, mismatched, or already has a child, it indicates a potential reuse attempt. In this case:
- The entire session family (descendants) is revoked immediately.
- Revocation is performed by one recursive database update so no descendant remains valid mid-revocation.
- The refresh request is denied.

Expired parent sessions are denied without creating a child session. Same-process duplicate refresh calls that arrive while the first caller is still rotating the token are deduplicated: exactly one caller may receive the new tokens, and the duplicate receives a denial without revoking the winner's child session.

### Database Schema

We added the following columns to the `sessions` table:
- `parent_id`: UUID, references `sessions(id)`.
- `revoked_at`: Timestamp, set when a session is revoked due to reuse detection or logout.
- `token_consumed_at`: Timestamp, set when a refresh token has successfully rotated and must not be accepted again.

## API Endpoints

### `POST /api/v1/api/auth/login`
- Standard login that issues both `accessToken` and `refreshToken`.

### `POST /api/v1/api/auth/refresh`
- **Body**: `{ "refreshToken": "..." }`
- **Returns**: New `accessToken` and `refreshToken`.
- **Side effects**: Creates a new session record, links it to the old one, and performs reuse detection.

## Security Assumptions

1. **JWT Secret**: The `JWT_SECRET` must be strong and kept secure.
2. **HTTPS**: All token exchanges must happen over HTTPS.
3. **Storage**: Clients should store tokens securely (e.g., `HttpOnly` cookies for web, secure enclave for mobile).
4. **Logging**: Refresh-token values are secrets. Logs may include stable session identifiers and token hashes for diagnostics, but never the raw refresh token or a raw-token prefix.
5. **Atomic lineage revocation**: Replay detection relies on `SessionRepository.revokeSessionAndDescendants`, which uses a recursive CTE inside the caller's transaction to invalidate the target session and every descendant in a single database statement.

## Developer Notes

The implementation uses an adapter pattern to bridge the domain-specific `LoginService` and `RefreshService` with the database and JWT libraries. 

- `src/auth/refresh/refreshService.ts`: Core rotation logic.
- `src/db/repositories/sessionRepository.ts`: Database interactions with recursive CTE for revocation.
- `src/auth/refresh/refreshService.test.ts`: Deterministic unit coverage for valid rotation chains, replay of ancestors, concurrent duplicate refreshes, expired parents, long lineages, and raw-token logging safeguards.
