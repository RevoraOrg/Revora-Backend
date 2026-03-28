# Structured Error Mapping

## Goal

Revora backend now uses a single structured error contract for route failures and unexpected exceptions.

Client-facing error responses follow this JSON shape:

```json
{
  "code": "SERVICE_UNAVAILABLE",
  "message": "Dependency unavailable",
  "details": {
    "dependency": "database"
  },
  "requestId": "7c3c15ce-55cc-4628-8f62-87bf29ef92f4"
}
```

## Design

### Error primitives

- `src/lib/errors.ts`
- `AppError` is the only error type trusted to set client-visible status/message/details.
- `ErrorCode` provides machine-readable categories for clients and tests.
- `Errors.*` factory helpers standardize common error creation.

### Global error handler

- `src/middleware/errorHandler.ts`
- Unknown thrown values are always mapped to `INTERNAL_ERROR`.
- Raw internal exception messages are never returned to clients.
- Structured JSON is logged to `console.error` for review and incident analysis.
- Request ids are attached when available.

### Health route mapping

- `src/routes/health.ts`
- Database failures map to:
  - `503 SERVICE_UNAVAILABLE`
  - `details.dependency = "database"`
- Stellar Horizon failures map to:
  - `503 SERVICE_UNAVAILABLE`
  - `details.dependency = "stellar-horizon"`
  - `details.upstreamStatus` when Horizon returned a non-OK HTTP status

## Security assumptions

1. Only `AppError` messages are safe to expose to clients.
2. Unknown exceptions may contain secrets, credentials, SQL details, or stack traces and are therefore sanitized.
3. Dependency health failures expose stable dependency labels only; they do not expose raw upstream exception text.
4. `requestId` is for correlation only and should not be treated as authorization context.

## Failure and abuse paths considered

- Unexpected exceptions thrown by route handlers
- Non-Error thrown values (`throw 'oops'`)
- Database connectivity failures
- Stellar Horizon network failures
- Stellar Horizon upstream 5xx/4xx non-OK responses
- Requests to unknown routes

## Developer usage

Throw or forward `AppError` instances for expected failures:

```ts
import { Errors } from '../lib/errors';

if (!req.user) {
  throw Errors.unauthorized();
}

if (!offering) {
  throw Errors.notFound('Offering not found');
}
```

Let unexpected exceptions bubble into the global error handler so they are logged and sanitized.

## Validation

Recommended commands:

```bash
npm run build
npm run test -- src/routes/health.test.ts src/middleware/errorHandler.test.ts
npm run test:coverage -- src/routes/health.test.ts src/middleware/errorHandler.test.ts
```

Targeted coverage for the structured error mapping path should stay above 95 percent.
