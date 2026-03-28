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
1. If the session has already been revoked.
2. If the session already has a "child" session (meaning this token was already rotated).

If either condition is true, it indicates a potential reuse attempt. In this case:
- The entire session family (descendants) is revoked immediately.
- The refresh request is denied.

### Database Schema

We added the following columns to the `sessions` table:
- `parent_id`: UUID, references `sessions(id)`.
- `revoked_at`: Timestamp, set when a session is revoked due to reuse detection or logout.

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

## Developer Notes

The implementation uses an adapter pattern to bridge the domain-specific `LoginService` and `RefreshService` with the database and JWT libraries. 

- `src/auth/refresh/refreshService.ts`: Core rotation logic.
- `src/db/repositories/sessionRepository.ts`: Database interactions with recursive CTE for revocation.
