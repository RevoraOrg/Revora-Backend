# Revenue Route Schema Validation

## Overview

This document describes the input validation layer added to the Revora Backend's revenue report
submission endpoints. Validation is handled by the existing `src/middleware/validate.ts`
middleware without any third-party schema libraries, using three named regex constants and two
typed schema objects declared in `src/routes/revenueRoutes.ts`.

---

## Route Definitions and Schemas

### POST `{API_VERSION_PREFIX}/offerings/:id/revenue`

Submits a revenue report for an offering identified by its UUID path parameter.

**Param schema (`params`):**

| Field | Type   | Required | Constraint     |
|-------|--------|----------|----------------|
| `id`  | string | Yes      | UUID v4 format |

**Body schema (`body`):**

| Field         | Type   | Required | Constraint                      |
|---------------|--------|----------|---------------------------------|
| `amount`      | string | Yes      | Positive decimal, ≤ 18 decimals |
| `periodStart` | string | Yes      | ISO 8601 date or datetime       |
| `periodEnd`   | string | Yes      | ISO 8601 date or datetime       |

---

### POST `{API_VERSION_PREFIX}/revenue-reports`

Submits a revenue report with the offering identified within the request body.

**Body schema (`body`):**

| Field         | Type   | Required | Constraint                      |
|---------------|--------|----------|---------------------------------|
| `offeringId`  | string | Yes      | UUID v4 format                  |
| `amount`      | string | Yes      | Positive decimal, ≤ 18 decimals |
| `periodStart` | string | Yes      | ISO 8601 date or datetime       |
| `periodEnd`   | string | Yes      | ISO 8601 date or datetime       |

---

## Validation Rules

### UUID v4 Regex

```
/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
```

Enforces RFC 4122 version 4 UUID format. Case-insensitive. Applied to the `:id` path
parameter and the `offeringId` body field.

### ISO 8601 Date Regex

```
/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?)?$/
```

Accepts `YYYY-MM-DD` plain dates and full ISO 8601 datetime strings with optional time,
fractional seconds (bounded to 9 digits), and timezone offset. Applied to `periodStart`
and `periodEnd`.

### Positive Decimal Regex

```
/^\d+(\.\d{1,18})?$/
```

Accepts positive integer or decimal strings with up to 18 fractional digits. Requires at
least one leading digit before the decimal point (rejects `.5`). Applied to `amount`.

---

## Middleware Ordering

```
validateParams  →  validateBody  →  authMiddleware()  →  handler
```

Schema validation runs **before** JWT authentication. This design ensures:

1. Structurally malformed requests are rejected at the lowest possible cost — no
   cryptographic operations are performed for invalid-format input.
2. Error response shape is consistent (`{ error: 'ValidationError', details: [...] }`) for
   all schema-invalid requests, regardless of auth state.
3. No timing-oracle differential: a bad-format request with a valid token behaves identically
   to a bad-format request with an invalid token — both return 400 before auth executes.

Business logic validations (e.g., `periodEnd > periodStart`, offering ownership, idempotency)
remain in `RevenueService` as they require database access and are not schema concerns.

---

## Security Assumptions and Abuse/Failure Paths

1. **UUID injection prevention.**
   Accepting arbitrary strings in `:id` or `offeringId` without format validation exposes
   the database query layer to crafted inputs. The UUID regex ensures only syntactically
   valid v4 UUIDs reach the repository layer, eliminating a class of SQL-injection and
   path-traversal vectors before any DB connection is made.

2. **ReDoS prevention.**
   All regex patterns use bounded quantifiers (`{1,9}`, `{1,18}`) rather than unbounded
   (`+`, `*`) to prevent catastrophic backtracking on adversarial input strings. An attacker
   sending a carefully crafted long string cannot cause the validation loop to stall.

3. **Amount precision overflow.**
   The 18-decimal limit on `POSITIVE_DECIMAL_REGEX` prevents inputs that could overflow
   PostgreSQL `NUMERIC` precision or introduce floating-point rounding artefacts in
   downstream financial processing.

4. **Auth cost avoidance under abuse.**
   An unauthenticated attacker sending malformed payloads at high rate receives 400
   responses without triggering JWT verification or database connections, minimising the
   computational cost of sustained abuse.

5. **Missing `offeringId` on `/revenue-reports`.**
   Without body validation, a request with no `offeringId` would reach the handler which
   reads `req.params.id` (undefined) and `req.body.offeringId` (undefined), potentially
   causing a null-dereference in the service. The schema guard catches this before the
   handler executes.

6. **Non-positive amounts.**
   The `POSITIVE_DECIMAL_REGEX` rejects strings without a leading integer digit (e.g.,
   `.5`, `-100`, `abc`). Strict zero-rejection (`amount > 0`) is enforced downstream by
   `RevenueService` which calls `parseFloat` and checks `<= 0`, providing a layered defence.

---

## Error Response Format

All validation failures return HTTP `400` with the following JSON shape:

```json
{
  "error": "ValidationError",
  "details": [
    "params.id: invalid format",
    "body.amount: required"
  ]
}
```

The `details` array contains one entry per failing field, with path prefix (`params.`,
`body.`) and a human-readable reason (`required`, `invalid format`, `expected string`, etc.).

---

## Implementation Reference

| File | Role |
|------|------|
| `src/routes/revenueRoutes.ts` | Regex constants, schema objects, middleware wiring |
| `src/middleware/validate.ts` | `validateParams`, `validateBody` — core validation engine |
| `src/index.ts` | Route registration: `apiRouter.use(createRevenueRoutes(pool))` |
| `src/db/pool.ts` | Singleton `pool` passed to `createRevenueRoutes` |

---

## Test Coverage Summary

Tests are located in `src/routes/health.test.ts` under the describe block
`'Revenue Route Schema Validation tests'`.

| Test scenario | Expected status | Field/rule covered |
|---|---|---|
| Valid params + body, no auth | 401 | Happy path — all validations pass, auth fires |
| Missing `amount` | 400 | `body.amount` required |
| Missing `periodStart` | 400 | `body.periodStart` required |
| Missing `periodEnd` | 400 | `body.periodEnd` required |
| Non-UUID `:id` param | 400 | `params.id` UUID pattern |
| Non-numeric `amount` | 400 | `body.amount` decimal pattern |
| Non-ISO `periodStart` | 400 | `body.periodStart` ISO date pattern |
| Non-ISO `periodEnd` | 400 | `body.periodEnd` ISO date pattern |
| Inverted period dates | 401 | Schema passes (format valid); ordering is a service concern |
| `/revenue-reports` missing `offeringId` | 400 | `body.offeringId` required |
| `/revenue-reports` invalid UUID | 400 | `body.offeringId` UUID pattern |
| `/revenue-reports` valid body, no auth | 401 | Happy path revenueReportBodySchema |
| `/revenue-reports` leading-dot `amount` | 400 | `body.amount` decimal pattern (no leading digit) |

Minimum target: **95% coverage** of `src/routes/revenueRoutes.ts`.
