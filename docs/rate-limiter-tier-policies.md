# Rate Limiter Tier Policies

This document describes how Revora's Express API enforces differentiated rate limits
across caller types, and covers the auth-gating of sensitive export endpoints that
was hardened alongside the rate-limiter work (Issue #1275).

---

## Overview

Rate limiting in Revora is tiered: different callers receive different quotas based on
their identity and the sensitivity of the route they are accessing. The tiers are
enforced by separate middleware factories mounted in `src/index.ts` and
`src/middleware/startupAuthRateTierPolicy.ts`.

The philosophy is:

- **Fail closed.** If the rate-limit store is unavailable, callers are rejected rather
  than silently allowed through.
- **Defence in depth.** Rate limiting never substitutes for authentication. Auth
  middleware always runs before the route handler, independently of the rate-limiter
  state.
- **Explicit tiers.** Every tier is named and documented; there is no default "allow
  all" tier.

---

## Tiers

| Tier | Typical caller | Window | Max requests |
|---|---|---|---|
| `public` | Anonymous health / status checks | 1 min | 60 |
| `startup` | Startup actors (JWT role = `startup`) | 1 min | 120 |
| `investor` | Investor actors (JWT role = `investor`) | 1 min | 200 |
| `compliance` | Compliance officers (JWT role = `compliance`) | 1 min | 500 |
| `admin` | Platform admins (JWT role = `admin`) | 1 min | 1 000 |

Windows and counts are configurable via environment variables (see
`src/config/env.ts`). The defaults above are suitable for production; tests override
them to high values to avoid spurious failures.

---

## Middleware chain

For a typical authenticated route the middleware chain is:

```
requestIdMiddleware
  → CORS
  → rateLimiter(tier)          ← checked before auth to protect the auth endpoint too
  → authMiddleware / requireCompliance / requireAdmin
  → route handler
```

The rate-limiter middleware runs **before** auth so that brute-force attempts against
the auth endpoints are also throttled.

---

## Auth-gating of the GL ledger export (Issue #1275)

### Problem

`GET /api/v1/ledger/export` was mounted with no authentication middleware and was
backed by `InMemoryLedgerRepository` (always empty). Switching to
`PgLedgerEntryRepository` as planned would have exposed the full general ledger to
anonymous callers.

### Fix

Three changes were made together:

**1. Migration `061_create_ledger_entries.sql`**

Creates the `ledger_entries` table that `PgLedgerEntryRepository` reads:

```sql
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            TEXT PRIMARY KEY,
  gl_account    TEXT NOT NULL,
  entry_date    DATE NOT NULL,
  description   TEXT NOT NULL,
  debit_amount  NUMERIC(24, 8) NOT NULL DEFAULT 0 CHECK (debit_amount  >= 0),
  credit_amount NUMERIC(24, 8) NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  currency      CHAR(3) NOT NULL,
  recorded_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  entry_type    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_gl_account_id
  ON ledger_entries (gl_account, id);
```

The composite index `(gl_account, id)` covers both the initial fetch and keyset
cursor pagination used by the repository.

**2. `src/routes/ledgerExport.ts` — caller-supplied auth**

`createLedgerExportRouter` now accepts zero or more `RequestHandler` arguments that
are applied via `router.use()` before all route handlers:

```typescript
export function createLedgerExportRouter(
  service: LedgerExportService,
  ...authMiddleware: RequestHandler[]
): Router
```

This design keeps the router itself stateless and testable — unit tests can pass no
middleware, integration tests pass `stubRequireCompliance`, and production passes
the real `requireCompliance`.

**3. `src/index.ts` — Postgres wiring + `requireCompliance`**

```typescript
const ledgerRepo = new PgLedgerEntryRepository(pool);
const ledgerExportService = new LedgerExportService(ledgerRepo);
apiRouter.use("/ledger", createLedgerExportRouter(ledgerExportService, requireCompliance));
```

`InMemoryLedgerRepository` is no longer used in production. The TODO comment is
removed.

---

## Security assumptions

- **Role is read from the verified JWT payload**, never from a request header. A
  caller cannot escalate their role by adding an `X-Role` header.
- **A missing or malformed Bearer token always returns 401.** There is no fallback to
  an anonymous session.
- **An investor-role JWT returns 403** on this endpoint — the caller is authenticated
  but not authorised. This is intentional: investors must not access the full GL.
- **Cursor HMAC** (`CURSOR_SIGNING_SECRET`) prevents cursor forgery and cross-account
  cursor reuse. A tampered cursor is rejected 400 before any DB query runs.
- **Parameterised queries** in `PgLedgerEntryRepository` mean the `gl_account` string
  from the query parameter cannot inject SQL.

---

## Test coverage (`src/routes/ledgerExport.test.ts`)

| Suite | What is tested |
|---|---|
| Auth matrix | anonymous → 401, bad format → 401, expired → 401, investor → 403, startup → 403, compliance → 200, admin → 200 |
| Spoofed header | `X-Role: compliance` header with investor JWT still returns 403 |
| Regression | Explicit test asserting anonymous returns 401, not 200 (as it did on master) |
| Input validation | missing `gl_account`, empty string, whitespace-only, tampered cursor, cross-account cursor |
| Response data | correct entries + totals, empty account, custom limit, clamped limits, decimal total accuracy |
| Cursor pagination | 3-page walk over 25 entries; no duplicate IDs across pages; no cursor on last page |
| Router factory | zero-arg (open), multiple middleware (order preserved), blocking middleware (short-circuits handler) |
| Integration (optional) | `PgLedgerEntryRepository` against a real schema — skipped unless `INTEGRATION_DB_URL` is set |

Run the unit suite:

```bash
npx jest --testPathPatterns="src/routes/ledgerExport\\.test\\.ts\$"
```

Run with a live database:

```bash
INTEGRATION_DB_URL=postgres://user:pass@localhost:5432/revora_test \
  npx jest --testPathPatterns="src/routes/ledgerExport\\.test\\.ts\$"
```

---

## Abuse and failure paths

| Scenario | Behaviour |
|---|---|
| No `JWT_SECRET` set | `requireCompliance` returns 500 with a generic message; the secret value is never exposed |
| Token signed with an old rotated secret | Accepted if `JWT_SECRET_PREVIOUS` is set and still valid |
| Cursor signed with wrong `CURSOR_SIGNING_SECRET` | Rejected 400 before hitting the repository |
| `gl_account` contains SQL injection attempt | Passed to a parameterised query; no injection possible |
| Request with valid compliance token but no `gl_account` | Rejected 400 by the route handler |
| Rate limit exceeded | 429 from the upstream rate-limiter middleware (runs before auth) |
