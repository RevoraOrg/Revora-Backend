# Request ID Propagation

## Overview

This document describes the request ID propagation system implemented
in `Revora-Backend`. Every incoming request is assigned a unique ID
that travels through the entire system and is returned in the response
headers. This makes debugging and tracing much easier.

---

## How It Works

1. A request comes in to the API
2. The middleware checks if the request has an `X-Request-Id` header
3. If yes — that ID is used and echoed back
4. If no — a new UUID is generated automatically
5. The ID is attached to `req.requestId` and returned in the response
   as `X-Request-Id`

---

## Implementation

**File:** `src/middleware/requestId.ts`

### `requestIdMiddleware(): RequestHandler`
Returns an Express middleware function that:
- Reads `X-Request-Id` from incoming request headers
- Falls back to any existing `req.requestId` value
- Generates a new UUID if neither exists
- Sets `req.requestId` on the request object
- Sets `X-Request-Id` header on the response

### `pickHeaderId(val): string | undefined`
Internal helper that safely extracts a non-empty string from a header
value that could be a string or an array of strings.

---

## Security Assumptions

- Client-supplied `X-Request-Id` values are accepted as-is but are
  never used for any authentication or authorization purpose — they
  are purely for tracing and debugging.
- Empty or whitespace-only header values are ignored and a new UUID
  is generated instead.
- The middleware never overwrites an already-set `req.requestId` —
  this prevents downstream middleware from having their IDs replaced.
- UUIDs are generated using Node's built-in `crypto.randomUUID()`
  which is cryptographically secure.

---

## Abuse and Failure Paths

| Scenario                          | Behaviour                                      |
|-----------------------------------|------------------------------------------------|
| No `X-Request-Id` header          | New UUID generated automatically               |
| Empty `X-Request-Id` header       | Treated as missing — new UUID generated        |
| Array of header values            | First non-empty value is used                  |
| `req.requestId` already set       | Existing value kept — not overwritten          |
| Client sends malicious ID value   | Accepted for tracing only — never trusted      |

---

## Test Coverage

**File:** `src/routes/health.test.ts`

| Test                                        | What it verifies                          |
|---------------------------------------------|-------------------------------------------|
| returns X-Request-Id header in response     | Header is always present in response      |
| echoes back the X-Request-Id when provided  | Client ID is respected and returned       |
| generates a UUID when none provided         | Auto-generated ID matches UUID format     |
| propagates X-Request-Id on API routes       | Works across all routes not just /health  |
| generates different IDs for different requests | Each request gets a unique ID          |

---

## Example Usage
```typescript
import { requestIdMiddleware } from './middleware/requestId';

// In your Express app setup:
app.use(requestIdMiddleware());

// The ID is now available on every request:
app.get('/example', (req, res) => {
  console.log(req.requestId); // e.g. "550e8400-e29b-41d4-a716-446655440000"
  res.json({ requestId: req.requestId });
});
```

---

## Related Files

- `src/middleware/requestId.ts` — core middleware logic
- `src/middleware/requestId.test.ts` — unit tests for the middleware
- `src/index.ts` — where the middleware is wired into the app
- `src/routes/health.test.ts` — integration tests