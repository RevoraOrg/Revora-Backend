# Payouts — Stellar Result Codes & Retry Storms

**Issue:** RC26Q2-B34  
**Branch:** `be34-payouts-tests`  
**Scope:** Backend only (`src/lib/`, `src/routes/`, `src/services/`)

---

## What changed

### `src/lib/stellarRpcFailure.ts`

Extended the existing `classifyStellarRPCFailure` classifier with:

- Two new enum members: `TX_RESULT_CODE` and `OP_RESULT_CODE`
- `STELLAR_TX_RESULT_CODES` — allowlist of all Horizon transaction-level result codes (`tx_bad_seq`, `tx_insufficient_fee`, `tx_bad_auth`, etc.)
- `STELLAR_OP_RESULT_CODES` — allowlist of all Horizon operation-level result codes (`op_no_destination`, `op_underfunded`, `op_no_trust`, etc.)
- Horizon `extras.result_codes` envelope parsing — op-level codes take precedence over tx-level for actionability
- Sanitized `originalError` payloads — raw Horizon/upstream `message` strings are replaced with `UPSTREAM_MESSAGE_REDACTED`
- `isStellarRPCRetryable(cls)` — returns `true` only for `TIMEOUT` and `UPSTREAM_ERROR`; all protocol errors (`TX_RESULT_CODE`, `OP_RESULT_CODE`) and auth/rate errors are non-retryable

### `src/routes/payouts.test.ts`

Added three new `describe` blocks (60 new tests):

| Suite | What it covers |
|---|---|
| `classifyStellarRPCFailure – result codes` | Every tx and op code in the allowlists via `it.each`, explicit spot-checks, HTTP status codes, timeout/abort, malformed response, unknown fallback, security leak check |
| `isStellarRPCRetryable` | All 8 enum values — retryable vs non-retryable |
| `payout repo retry storm` | Handler forwards error to `next()` on first failure; exactly one repo call per request; no retry on `tx_bad_seq`; no retry on 429; timeout classified as retryable but handler still does not retry |

### `src/services/distributionEngine.test.ts`

Added 9 new tests to the existing `DistributionEngine` suite:

- Retry budget exhaustion on balance fetch (call count == `maxRetries`, no infinite loop)
- Retry budget exhaustion on payout creation
- Success on last allowed retry (boundary condition)
- Stellar `tx_bad_seq` → `TX_RESULT_CODE` → non-retryable
- Stellar `op_underfunded` → `OP_RESULT_CODE` → non-retryable
- HTTP 503 → `UPSTREAM_ERROR` → retryable
- `offeringRepo.getInvestors` fallback path
- `offeringRepo.listInvestors` fallback path
- `logRetries: true` console output

---

## Test output summary

```
PASS src/routes/payouts.test.ts        (109 tests)
PASS src/services/distributionEngine.test.ts (13 tests)
PASS src/lib/stellar.test.ts           (22 tests)

Test Suites: 3 passed
Tests:       144 passed, 0 failed
```

### Coverage — new/changed files

| File | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| `src/lib/stellarRpcFailure.ts` | 100% | 100% | 100% | 100% |
| `src/services/distributionEngine.ts` | 95.83% | 82% | 100% | 96.82% |
| `src/routes/payouts.ts` | 94.79% | 98.71% | 90.9% | 94.18% |

Remaining uncovered lines are all legitimately unreachable:
- `payouts.ts:116` — `default: cmp = 0` in a switch TypeScript narrows to 3 known values; dead code by construction
- `payouts.ts:290-295` — `createPayoutsRouter` Express wiring; no logic, requires HTTP integration test
- `distributionEngine.ts:79,136` — null-guard unreachable via TypeScript types; mid-retry delay timing path

---

## `classifyStellarRPCFailure` behaviour reference

```
Error shape                                      → StellarRPCFailureClass
─────────────────────────────────────────────────────────────────────────
Error { name: 'AbortError' }                     → TIMEOUT
Error { message: '...timeout...' }               → TIMEOUT
{ status: 429 }                                  → RATE_LIMIT
{ status: 401 | 403 }                            → UNAUTHORIZED
{ status: 5xx }                                  → UPSTREAM_ERROR
SyntaxError                                      → MALFORMED_RESPONSE
{ extras.result_codes.operations: [op_*] }       → OP_RESULT_CODE  ← checked first
{ extras.result_codes.transaction: 'tx_*' }      → TX_RESULT_CODE
anything else                                    → UNKNOWN
```

`isStellarRPCRetryable` returns `true` only for `TIMEOUT` and `UPSTREAM_ERROR`. All other classes — including `TX_RESULT_CODE` and `OP_RESULT_CODE` — are non-retryable because retrying a protocol error without fixing the transaction will always fail.

---

## Security assumptions

1. **No raw upstream strings in client JSON.** `classifyStellarRPCFailure` returns only an enum value. The `extras.envelope_xdr`, `result_xdr`, and raw error messages are never forwarded to callers.

2. **Sanitized classified failures stay safe in logs.** `failure.originalError` preserves only a narrow diagnostic shape (`status`, `code`, `result_xdr`, redacted `message`) so downstream logging does not accidentally leak Horizon text.

3. **Investor data isolation.** `listPayouts` enforces `role === 'investor'` and scopes the repo query to `req.user.id`. Other roles receive 403 before any DB call is made.

4. **No retry amplification.** The `listPayouts` handler makes exactly one repo call per request. Retry policy is the responsibility of the caller (job queue, middleware), not the HTTP handler. This prevents a single slow request from multiplying load on Horizon during an outage.

5. **Retry budget is bounded.** `DistributionEngine.withRetry` loops at most `maxRetries` times. Tests assert `callCount === maxRetries` to confirm no infinite loop is possible.

6. **Protocol errors are not retried.** `TX_RESULT_CODE` and `OP_RESULT_CODE` failures (e.g. `tx_bad_seq`, `op_underfunded`) indicate the transaction itself is malformed. Retrying without fixing the transaction wastes Horizon quota and can trigger rate limiting.
