# Authentication Middleware & Error Taxonomy

This document describes the hardened authentication middleware and the standardized error taxonomy used in the Revora Backend.

## Overview

Revora uses a session-hardened authentication model that combines JWT verification with server-side session state enforcement. All authentication failures are mapped to a structured error taxonomy for consistent API responses and secure logging.

## Core Middlewares

### `authWithSession`

Located in `src/middleware/authWithSession.ts`, this is the primary middleware for session-enforced routes.

**Flow:**
1. Validates the `Authorization: Bearer <token>` header.
2. Verifies the JWT using `lib/jwt`.
3. Extracts the session ID (`sid`) and user ID (`sub`) from the payload.
4. Checks the session in the database via `SessionRepository`.
5. Enforces that the session exists, is not revoked, and has not expired.
6. Populates `req.auth` with `userId`, `sessionId`, and `role`.

### Legacy `authMiddleware`

Located in `src/middleware/auth.ts`, this middleware performs standard JWT verification without checking the database session. It is being phased out in favor of `authWithSession` for high-security routes.

## Error Taxonomy

All authentication and authorization errors utilize the `AppError` class from `src/lib/errors.ts`.

### Standard Responses

Clients receive structured JSON responses:

```json
{
  "code": "UNAUTHORIZED",
  "message": "Session has been revoked",
  "requestId": "..."
}
```

**Common Status Codes:**
- `401 Unauthorized`: Missing token, invalid JWT, expired session, or revoked session.
- `403 Forbidden`: Valid authentication but insufficient permissions (e.g., role mismatch).
- `500 Internal Server Error`: Unexpected system failures (e.g., database connection lost).

## Structured Logging

The `globalLogger` (`src/lib/logger.ts`) is used across all auth boundaries to provide audit-ready traces without leaking PII.

- **Warning Level (`WARN`)**: Used for client-side failures (invalid tokens, expired sessions). Includes `requestId`, `path`, and sanitized error details.
- **Error Level (`ERROR`)**: Used for system failures (500+ status codes). Includes full stack traces (redacted in production).
- **Redaction**: Sensitive fields like `Authorization` headers and raw tokens are automatically redacted by the logger configuration.

## Security Assumptions

- **JWT Expiry**: JWTs should have a short lifetime (e.g., 1 hour) to limit the window of misuse if a token is leaked but the session is not yet revoked in the DB.
- **Session Revocation**: Revoking a session in the database takes effect immediately for the next request using `authWithSession`.
- **Error Leakage**: Raw database or upstream error messages are never returned to the client. They are caught by the `errorHandler` and mapped to stable `ErrorCode` values.

## Verification

The authentication system is verified with high-coverage test suites:
- `src/middleware/authWithSession.test.ts` (≥95% coverage)
- `src/middleware/auth.test.ts`
- `src/middleware/errorHandler.test.ts`
