# API Notifications Security
 
This document outlines the security controls, validation rules, and error handling patterns implemented for the Notifications API in `Revora-Backend`.
 
## Security Controls
 
### 1. Rate Limiting
- **Policy**: Per-user rate limiting is enforced on all notification endpoints.
- **Threshold**: 100 requests per rolling 60-second window.
- **Key Strategy**: Keyed by `req.user.id` (JWT sub).
- **Failure Behavior**: Returns `429 Too Many Requests` with a `Retry-After` header and a standardized `TOO_MANY_REQUESTS` error code.
 
### 2. Payload Validation
- **Engine**: Zod schema validation.
- **Rules**:
  - `GET /notifications`: No body/params required.
  - `PATCH /notifications/:id/read`:
    - `:id` must be a valid UUID or the literal string `bulk`.
    - If `bulk` is used, the request body MUST contain an `ids` array of valid UUIDs.
- **Failure Behavior**: Returns `400 Bad Request` with a `VALIDATION_ERROR` code and field-level error details.
 
### 3. Structured Logging
- **Service**: `globalLogger`.
- **Context**: Every action logs the `userId` and relevant metadata (e.g., `notificationId`, bulk count).
- **Privacy**: No sensitive notification content (message body) is logged.
 
### 4. Standardized Error Responses
- All errors are mapped to `AppError` instances from `src/lib/errors.ts`.
- No raw database or upstream error strings are leaked to the client.
 
## Error Code Reference
 
| Code | HTTP Status | Description |
|------|-------------|-------------|
| `VALIDATION_ERROR` | 400 | The request payload or parameters failed schema validation. |
| `UNAUTHORIZED` | 401 | Missing or invalid authentication token. |
| `NOT_FOUND` | 404 | The specified notification ID does not exist or does not belong to the user. |
| `TOO_MANY_REQUESTS` | 429 | Rate limit exceeded. |
| `INTERNAL_ERROR` | 500 | Unexpected server error (sanitized for client). |
 
## Failure Classification (Stellar RPC)
 
If notifications were to be triggered by or interact with Stellar RPC directly, failures would be classified using `classifyStellarRPCFailure` to ensure that upstream network/node errors are bucketed into safe categories (`TIMEOUT`, `RATE_LIMIT`, `UPSTREAM_ERROR`, etc.) before being returned to the client as `INTERNAL_ERROR` or `SERVICE_UNAVAILABLE`.
