# Idempotency Key Principal Isolation & Postgres Store Security Assumptions

## Overview

The `createIdempotencyMiddleware` middleware protects state-changing HTTP endpoints (e.g., `POST /api/investments`) from duplicate execution caused by client retries, network blips, or intentional replays.

This document details the threat model, architecture, security assumptions, and verification for **Principal Isolation** and the **PostgresIdempotencyStore** integration.

---

## Threat Model & Vulnerability Analysis

### The Cross-Tenant Data Leak Vulnerability

Prior to this hardening, `createIdempotencyMiddleware` stored and indexed cached responses using only the raw, client-supplied `Idempotency-Key` HTTP header. 

#### Attack & Failure Vector
1. **Accidental Collision**: Naive client UUID generators, static retry constants, or misconfigured SDKs often generate overlapping idempotency keys across distinct tenant sessions.
2. **Malicious Harvesting**: An attacker who guesses or replays an idempotency key previously used by another investor receives the cached `201 Created` HTTP response body of the original investor.
3. **Double Impact**:
   - **Data Leak**: The second investor reads sensitive financial, allocation, and investor data belonging to the first investor.
   - **Transaction Denial**: The second investor's investment is never submitted or recorded on-chain, yet their client receives a fraudulent `201 Created` receipt.
4. **Unbounded Memory Bloat**: `createInvestmentsRouter` originally defaulted to `InMemoryIdempotencyStore` with no TTL, which retained keys indefinitely in single-process memory.
5. **Incomplete Fingerprinting**: `fingerprintInvestmentRequest` omitted `beneficial_owners`, allowing modified screening payloads to replay previously cached responses.

---

## Architectural Protections & Changes

### 1. Store Key Namespacing Scheme

All idempotency keys stored in memory or PostgreSQL are namespaced:

$$\text{StoreKey} = \text{principalId} : \text{method} : \text{routePath} : \text{headerKey}$$

- **`principalId`**: Extracted from authenticated credentials (`req.user.id ?? req.user.sub`).
- **`method`**: Uppercase HTTP method (e.g., `POST`, `PATCH`).
- **`routePath`**: Normalized endpoint path (e.g., `/api/investments`).
- **`headerKey`**: Sanitized, trimmed `Idempotency-Key` header supplied by the client.

If two different investors submit the exact same `Idempotency-Key` (e.g., `550e8400-e29b-41d4-a716-446655440000`), the resulting store keys are completely isolated:
- Investor 1: `investor-alpha:POST:/api/investments:550e8400-e29b-41d4-a716-446655440000`
- Investor 2: `investor-beta:POST:/api/investments:550e8400-e29b-41d4-a716-446655440000`

Neither investor can view, lock, or replay the other investor's records.

### 2. Authentication Boundary (`requirePrincipal: true`)

On sensitive authenticated routes like `/api/investments`:
- `requirePrincipal: true` ensures that `req.user` must be present and valid.
- If a client sends an `Idempotency-Key` without authenticating, the middleware immediately halts request execution and responds with:
  ```json
  { "error": "Unauthorized: Authentication required for idempotency" }
  ```
- Response status code: `401 Unauthorized`.

### 3. PostgreSQL Persistence & 24-Hour TTL

`createInvestmentsRouter` wires `PostgresIdempotencyStore` by default using the `idempotency_keys` table from `005_create_idempotency_keys.sql`:
- **Default TTL**: `DEFAULT_INVESTMENT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000` (24 hours).
- **Concurrency Locking**: `SELECT ... FOR UPDATE` acquires row-level locks during reservation.
- **Fail-Open Fault Tolerance**: Database connection errors catch and log safely, failing open (`state: 'new'`) to prevent database blips from causing complete API outages.
- **Safe Release**: Handled via `finally { client?.release(); }` to prevent database connection leaks on error rollbacks.

### 4. Comprehensive Payload Fingerprinting

`fingerprintInvestmentRequest` calculates a SHA-256 hash of the canonicalized request payload:
- `amount`
- `asset`
- `offering_id`
- `beneficial_owners` (trimmed, filtered, and canonicalized)

If a client attempts to reuse an idempotency key with different beneficial owners or amounts, the middleware returns `409 Conflict` with:
```json
{ "error": "Idempotency key reuse with a different request payload is not allowed." }
```

---

## Security Assumptions & Operational Considerations

| Assumption | Threat / Risk | Implemented Mitigation |
| :--- | :--- | :--- |
| **Authentication Runs Before Idempotency** | Middleware ordering could allow unauthenticated requests to reach idempotency | `requireInvestor` is positioned before `idempotencyMiddleware` on the router pipeline; `requirePrincipal: true` provides defense-in-depth |
| **Distributed Multi-Instance Deployments** | Separate Node.js processes cannot coordinate in-memory stores | `PostgresIdempotencyStore` uses PostgreSQL transactions and `FOR UPDATE` row locks |
| **High Concurrency Collision** | Rapid parallel requests with same key could race | First request sets `state = 'inflight'`; concurrent requests receive `409 Conflict` (`Idempotency-Status: inflight`) |
| **Database Outage / Timeout** | PostgreSQL connection failure might block all investment submissions | Caught in `try / catch` and fails open (`state: 'new'`) without crashing worker |
| **Database Bloat** | High submission volume fills `idempotency_keys` table | 24-hour TTL filtering on `expires_at > NOW()` and periodic `cleanupExpired()` execution |

---

## Deterministic Verification

The changes are deterministically verified in:
1. `src/middleware/idempotency.test.ts`:
   - Unit tests for key namespacing `${principalId}:${method}:${routePath}:${headerKey}`.
   - Authentication boundary tests (`requirePrincipal: true` returning 401).
   - In-flight row locking and release semantics in `PostgresIdempotencyStore`.
   - Cross-tenant isolation verification across separate simulated tenants.
2. `src/routes/investments.test.ts`:
   - Verification that `createInvestmentsRouter` defaults to `PostgresIdempotencyStore` with 24-hour TTL.
   - Multi-tenant test proving two investors submitting the identical idempotency key each create distinct investments.
   - Regression test demonstrating that while legacy un-isolated middleware suffered cross-tenant replay, isolated middleware prevents replay.
   - Payload differentiation test verifying beneficial owner changes return 409 Conflict.
