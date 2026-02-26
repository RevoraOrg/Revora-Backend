# Idempotency Middleware Usage

Use `createIdempotencyMiddleware` on POST/PATCH routes where duplicate submissions must return the same result (payments, transfers, order placement).

## Quick start

```ts
import { Router } from 'express';
import { createIdempotencyMiddleware } from './middleware/idempotency';

const router = Router();
const idempotency = createIdempotencyMiddleware();

router.post('/payments', idempotency, async (req, res) => {
  // Business logic that should run once per key
  res.status(201).json({ paymentId: 'pmt_123', status: 'created' });
});
```

## Request contract

- Clients send a unique `Idempotency-Key` header per logical action.
- If the same key is reused for the same endpoint, middleware replays the first stored response.
- If a request with the same key is still running, middleware returns `409` with `Idempotency-Status: inflight`.

## Options

- `headerName` (default: `idempotency-key`)
- `methods` (default: `['POST', 'PATCH']`)
- `store` (default: in-memory store)
- `shouldStoreResponse` (default: cache status codes `< 500`)

## Notes for production

- The default store is process-local memory, so it does not deduplicate across instances.
- For multi-instance deployments, implement `IdempotencyStore` using shared storage (Postgres/Redis).
- `src/db/migrations/002_create_idempotency_keys.sql` is included as a table baseline if you want a DB-backed store.
