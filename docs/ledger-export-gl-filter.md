# Ledger Export GL-Account Filter (BE-012)

## Overview

`GET /api/v1/ledger/export` returns ledger entries scoped to a general-ledger
account (e.g. `1050-Custody`) with cursor-based pagination and a computed
totals row for client-side reconciliation.

The response shape is designed for downstream accounting systems that need to
pull batches on a schedule without double-counting or gap windows.

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │  GET /api/v1/ledger/export?gl_account=&cursor=&limit=              │
 │                                                                     │
 │  gl_account ──► LedgerExportService.byGlAccount()                   │
 │  cursor          │                                                   │
 │  (HMAC-signed)   ├── verifyCursor() ──► extracts last ID + scope    │
 │                  ├── repo.findByGlAccount() ──► entries + total     │
 │                  ├── computeTotals() ──► debit/credit/entry_count    │
 │                  ├── signCursor() ──► next_cursor (if has_more)     │
 │                  ▼                                                   │
 │  200 { entries, totals, next_cursor, has_more }                     │
 │  400 { code: "BAD_REQUEST" }  // missing gl_account / tampered      │
 │  500 Internal Server Error                                           │
 └─────────────────────────────────────────────────────────────────────┘
```

---

## Query Parameters

| Parameter     | Required | Default | Max    | Description                                   |
| :------------ | :------- | :------ | :----- | :-------------------------------------------- |
| `gl_account`  | Yes      | —       | —      | General-ledger account code (e.g. `1050-Custody`) |
| `cursor`      | No       | —       | —      | Opaque HMAC-signed cursor from previous response |
| `limit`       | No       | 100     | 1,000  | Max entries to return in one page             |

---

## Response Shape

```jsonc
{
  "entries": [
    {
      "id": "1",
      "gl_account": "1050-Custody",
      "entry_date": "2026-07-01",
      "description": "Client deposit",
      "debit_amount": "1000.00",
      "credit_amount": "0.00",
      "currency": "USD",
      "recorded_at": "2026-07-01T10:00:00Z",
      "entry_type": "deposit"
    }
  ],
  "totals": {
    "total_debit": "1012.50",
    "total_credit": "525.00",
    "entry_count": 4
  },
  "next_cursor": "ZXlKaGJHY2lPaUpJVXpJMU5pSXNJblI1Y0NJNklrcFhW...",
  "has_more": false
}
```

### Fields

| Field         | Type     | Description                                        |
| :------------ | :------- | :------------------------------------------------- |
| `entries`     | Array    | Ledger entries on this page, sorted by `id` ASC    |
| `totals`      | Object   | `total_debit`, `total_credit`, `entry_count`       |
| `next_cursor` | String   | Opaque cursor for the next page (absent if done)   |
| `has_more`    | Boolean  | `true` when additional pages are available         |

### Totals Row

The `totals` object is computed server-side to **exactly** equal the sum of
the returned entries to the last decimal place. This is done using BigInt
arithmetic (no floating point) on the `debit_amount` / `credit_amount` fields
of the current page.

```text
total_debit  = sum(entries[].debit_amount)
total_credit = sum(entries[].credit_amount)
entry_count  = entries.length
```

---

## Cursor Format

Cursors are opaque, HMAC-SHA256 signed, and scoped to a specific `gl_account`.

```
cursor = base64url(JSON.stringify({id, gl, t})) + '.' + base64url(HMAC-SHA256(secret, ...))
```

- **Payload**: `{ id, gl, t }` where `id` is the last entry ID, `gl` is the
  GL account, and `t` is a timestamp (for debugging).
- **Signature**: HMAC-SHA256 over the base64url-encoded payload.
- **Scope**: Cursors from one `gl_account` are rejected for another.

The signing secret is configured via `CURSOR_SIGNING_SECRET` (min 16 chars).
A tampered cursor produces `400 BAD_REQUEST`.

---

## Implementation

### HMAC Cursor Helpers

Located in [`src/lib/pagination.ts`](../src/lib/pagination.ts).

```typescript
function signCursor(payload: CursorPayload): string
function verifyCursor(cursor: string, expectedGl?: string): CursorPayload | null
```

### Service

Located in [`src/services/ledgerExportService.ts`](../src/services/ledgerExportService.ts).

- `LedgerExportService` — accepts a `LedgerExportRepository` via DI.
- `byGlAccount(glAccount, limit, cursor?)` — orchestrates lookup, totals, cursor.
- `InMemoryLedgerRepository` — in-memory implementation for testing.

### Route

Located in [`src/routes/ledgerExport.ts`](../src/routes/ledgerExport.ts).

- Mounted at `apiRouter.use("/ledger", ...)` in `src/index.ts`.
- Parses query parameters, delegates to service, returns JSON.

### Repository (production)

Located in [`src/db/repositories/ledgerEntryRepository.ts`](../src/db/repositories/ledgerEntryRepository.ts).

- `PgLedgerEntryRepository` — backed by a `ledger_entries` table.
- Uses parameterized queries, cursor-based `WHERE id > $2`.

---

## Security

| Concern                       | Mitigation                                                  |
| :---------------------------- | :---------------------------------------------------------- |
| Tampered cursor               | HMAC-SHA256 signature verified before decoding; fails 400   |
| Cross-account cursor reuse    | Cursor payload is scoped to `gl_account`; mismatch fails 400 |
| Cursor secret compromise      | Rotate `CURSOR_SIGNING_SECRET`; old cursors become invalid   |
| SQL injection                 | Parameterized queries only; no string concatenation          |
| Enumeration via cursor        | Payload contains only opaque last-ID; no sequential guess    |

---

## Error Responses

| Condition                          | Status | Body                                |
| :--------------------------------- | :----- | :---------------------------------- |
| Missing `gl_account`               | 400    | `{ code: "BAD_REQUEST", message }`  |
| Tampered / malformed cursor        | 400    | `{ code: "BAD_REQUEST", message }`  |
| Internal error                     | 500    | `{ code: "INTERNAL_ERROR" }`        |

---

## Test Coverage

Test file: [`src/routes/ledgerExport.test.ts`](../src/routes/ledgerExport.test.ts)

| Scenario                                   | Status |
| :----------------------------------------- | :----- |
| Returns entries with correct totals        | ✓      |
| Missing `gl_account` → 400                 | ✓      |
| Empty `gl_account` → 400                   | ✓      |
| Tampered cursor → 400                      | ✓      |
| No entries → empty list + zero totals      | ✓      |
| Pagination across 25 entries (3 pages)     | ✓      |
| Rejects cursor from different GL account   | ✓      |
| Respects custom limit parameter            | ✓      |
| Clamps limit to [1, 1000]                  | ✓      |
| Totals match sum of entries to last decimal| ✓      |
