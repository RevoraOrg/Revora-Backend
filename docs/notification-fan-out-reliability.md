# Notification Fan-Out Reliability

## Purpose

This feature adds a production-minded, defendable notification fan-out endpoint to the backend. It focuses on reliability, consistency, and security while remaining backend-only and testable.

## API Endpoint

POST `/api/v1/notifications/fanout`

### Headers

- `x-user-id`: string (authenticated caller)
- `x-user-role`: must be `admin`
- `x-idempotency-key`: required idempotency token (client-provided)

### Request body

- `type`: string, non-empty
- `title`: string, non-empty, max 240
- `body`: string, non-empty, max 1000
- `recipient_ids`: array of 1..100 non-empty string user IDs

### Success Response

- 200
- JSON:
  - `requested`: total unique recipients
  - `delivered`: success count
  - `skipped`: deduplicated/not-attempted count
  - `failed`: array of failed user IDs
  - `idempotent`: false on first run
  - `cached`: true when same idempotency key + payload is replayed

## Reliability behavior

- Idempotent key is required. repeated requests with the same key and same payload return cached result (non-duplicating sub-operations).
- idempotency key collision with different payload returns 409.
- Partial failures are recorded and do not abort full traversal.
- Maximum recipient set size prevents abusive bulk fan-out.
- Duplicate recipient IDs are deduplicated in-flight.

## Security assumptions

1. Caller authenticates with `x-user-id` and `x-user-role`.
2. Only role `admin` can perform fan-out.
3. `x-idempotency-key` exists and provides at least 128-bit uniqueness. The in-memory implementation is best-effort and service-local.
4. Request size limits are enforced to mitigate amplification and enumeration.

## Failure and abuse paths

- 401/403 unauthorized and forbidden for missing or invalid auth.
- 400 for invalid payloads, too many recipients, missing idempotency key.
- 409 for key reuse with mismatched payload.
- 503 can occur if underlying subsystem unavailable (not in prototype but should be considered in production).

## Test coverage

Added tests in `src/routes/health.test.ts` for the new endpoint:

- role-based enforcement
- idempotency key required
- provider behavior for repeated requests
- actual route and notification lookup by recipient

Combined existing health API consistency tests ensure endpoint is in API version prefix and behaves with startup boundaries.
