# Double-Entry Ledger Export for Accounting Integration

**Issue:** #873
**Status:** Implementation Complete
**Scope:** `src/routes/distributions.ts`, `src/db/repositories/distributionRepository.ts`, `/admin/ledger/export`

---

## Overview

Finance teams need a stable export endpoint that emits **double-entry** ledger
lines (debit/credit, account code, memo) for distributions, payouts, fees, and
reversals so they can be loaded directly into accounting platforms such as
NetSuite. Previously the API exposed raw payouts and required clients to
transform them manually.

This change adds:

1. A deterministic **double-entry ledger builder** (`AccountingLedgerService`)
   that turns distribution and payout records into balanced debit/credit lines.
2. A **new repository read method** (`DistributionRepository.listForAccountingExport`)
   that fetches distributions + payouts for an offering (optionally a period).
3. A **stable JSON export** on the distributions router
   (`GET /offerings/:id/ledger/export`) gated by the same RBAC as distribution
   execution (admin, or startup owner of the offering).
4. An **admin streaming export** (`GET /admin/ledger/export`) that is RBAC-gated
   (`admin` only), audited, and supports **CSV** and **JSON-Lines** via HTTP
   `Accept` negotiation, each with a trailing checksum row and an export-id for
   replay detection.

## Double-entry model

Every distribution produces a balanced pair of ledger lines:

| Source | Debit (DR) | Credit (CR) |
|--------|-----------|-------------|
| Distribution run (`total_amount`) | `4000-DISTRIBUTION-EXPENSE` | `2100-DISTRIBUTION-PAYABLE` |
| Payout (`amount`) to an investor | `2100-DISTRIBUTION-PAYABLE` | `1000-INVESTOR-PAYOUT` |

Because each run and each payout posts offsetting debit/credit entries, the sum
of all debits always equals the sum of all credits. `AccountingLedgerService`
computes this invariant and exposes it as `totals.balanced`. Fee and reversal
lines follow the same balanced-pair discipline via the same account-code
mechanics, so the ledger remains globally balanced.

```
4000-DISTRIBUTION-EXPENSE  DR  100.00
2100-DISTRIBUTION-PAYABLE  CR  100.00     <- distribution run
2100-DISTRIBUTION-PAYABLE  DR  100.00
1000-INVESTOR-PAYOUT       CR  100.00     <- payout
------------------------------------------------
                            DR 200.00  =  CR 200.00  (balanced)
```

## Stability, idempotency, checksum, and export-id

- Line `id`s are deterministic hashes of their source row + account code +
  side, so the same underlying data always yields the same `id`s and the same
  ordering (enabling replay / diffing).
- The trailing `checksum` is a SHA-256 digest over a canonical sorted-key JSON
  serialization of all lines, so field order cannot perturb the digest.
- `export_id` is derived deterministically from the checksum and line ids, so
  identical exports produce identical ids — a client can detect duplicates or
  replay an export without re-downloading.

## Endpoints

### `GET /offerings/:id/ledger/export` (distributions router)

- Auth: `verifyJWT`. Role checks mirror distribution execution:
  - `admin` may export any offering.
  - `startup` may export only offerings they issued (verified via `offeringRepo`).
  - Any other role → `403`.
- Query: optional `period_id`; empty `period_id` → `400`.
- Response: `200` JSON `{ export_id, checksum, generated_at, lines, totals }`.
- Not wired (no repository / ledger service) → `404` (backward compatible).

### `GET /admin/ledger/export` (admin router)

- Auth: `requireAdmin` (Bearer JWT, `role === "admin"` only); non-admin → `403`.
- Query: `offering_id` (required, else `400`), `period_id` (optional),
  `limit` (clamped to `1..1000`).
- Format negotiation via `Accept`:
  - `application/json`, `application/x-jsonlines`, or any `json` → JSON-Lines.
  - otherwise (or absent) → CSV.
- Every successful call is written to the audit log (`action: ledger.export`)
  with actor attribution; an audit failure is logged but does not fail the
  export (making the endpoint resilient).
- Response headers include `X-Ledger-Export-Id` and `X-Ledger-Checksum`.
- Both CSV and JSONL append a trailing checksum row/line.

## Security and failure-mode handling

- Authorisation is enforced by `requireAdmin` (admin router) and in-handler role
  checks (distributions router); roles are read from the verified JWT, never
  from client-supplied headers.
- Raw error internals are never leaked to clients: internal errors are mapped to
  a generic `500`; if streaming has already begun, a sentinel line is written
  rather than exposing the underlying message.
- Query `period_id` / `offering_id` are used as bind parameters (parameterised
  SQL) — no string interpolation into SQL values.
- Amounts are decimal strings and summed with integer scaled arithmetic to avoid
  binary rounding.
- Deterministic ids / checksums make concurrent or repeated exports safe and
  diagnosable; the repository method is read-only.

## Compatibility and migration

- All changes are **additive**: no existing route, column, or response shape is
  changed.
- `DistributionRepository` gains one new read-only method; existing methods and
  their behaviour are unchanged.
- The new `/admin/ledger/export` is a new endpoint under the existing admin
  namespace and requires no database migration.
- If an operator has not wired a distribution accounting repository or ledger
  service into the distributions router, the new route returns `404` and the
  existing routes continue to work unchanged.
- The admin export uses the standard `audit_logs` table, which already exists.

## Validation

Focused tests cover:

- happy paths (admin export JSON, CSV, JSONL);
- invalid input and authorization boundaries (401/403/400/404);
- concurrency / replay / idempotency (deterministic export-id and checksum);
- failure recovery (repository throws → generic 500, no internal leak);
- backward compatibility (existing router call sites without the new deps);
- empty, duplicate, and boundary inputs (empty period, empty result set,
  limit clamping).

Run the focused tests:

```bash
npx jest src/services/accountingLedgerService.test.ts \
  src/services/accountingExportFormatter.test.ts \
  src/db/repositories/distributionRepository.test.ts \
  src/routes/distributionsAccountExport.test.ts \
  src/routes/adminLedgerExport.test.ts
```
