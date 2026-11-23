# Deterministic Investor Statement PDF Generator with Signed Hash (#874)

## Overview

Investors receive quarterly statements (positions, distributions, fees, tax
classifications) as PDFs. Statements are generated with a **frozen layout** so
regenerating the same statement yields **byte-identical output and the same
sha256**, enabling immutable archival and tamper detection.

The flow:

1. `BalanceSnapshotService` snapshots end-of-period token balances per holder
   (`token_balance_snapshots`), and `DistributionRepository` records
   distribution runs + payouts.
2. `DefaultStatementDataProvider` assembles the statement content for an
   investor + period from snapshots, investments, distributions, revenue
   reports, and tax lots.
3. `renderStatementPdfWithContent` renders a deterministic PDF whose bytes are
   a pure function of (job metadata, statement content, watermark state,
   ledger revision hash) — never of the wall clock or random state.
4. The batch worker persists the artifact and its sha256: the
   `pdf_render_jobs` row is the `(statement_id, sha256, generated_at)` triple
   (`id`, `checksum`, `updated_at`).
5. `GET /statements/:periodId/:investorId` **re-verifies the sha256 against
   the stored bytes before serving**; a mismatch returns `409 CONFLICT`.

## Data lineage (why these modules)

| Section on statement | Source |
|----------------------|--------|
| Positions            | `BalanceSnapshotRepository.findByHolderAndPeriod` — snapshots written by `BalanceSnapshotService`; latest snapshot per offering wins (mid-period transfers collapse to end-of-period position) |
| Distributions        | `DistributionRepository.listPayoutsByInvestorForPeriod` — payouts joined to `distributions` on `period_id` |
| Fees (retained)      | `DistributionRepository.listByPeriod` + `listPayoutsByPeriod`: Σ(total_amount) − Σ(payouts), clamped at 0 |
| Transactions         | `InvestmentRepository.listByInvestor` (filtered to the `YYYY-MM` window) + period payouts |
| Revenue              | `RevenueReportRepository.getByOfferingAndPeriod` across the investor's holdings |
| Tax classifications  | `InvestmentLotRepository.listByInvestor` — immutable lot data (jurisdiction, cost basis, acquisition date) |

## Determinism contract

The rendered bytes contain **no wall-clock or random values**:

- `generatedAt` from the content model is never embedded.
- All dates render via `Date.toISOString()` (UTC, fixed-width).
- All amounts are passed through as decimal strings (no locale formatting).
- Every section is defensively re-sorted with stable comparators inside the
  renderer, so byte-identical output holds even if a provider returns rows in
  a different order.
- The frozen-layout renderer is text-based with fixed column separators — no
  external font metrics, so output cannot drift across hosts or OS updates
  ("frozen fonts" = no font dependency at all).

## Persisted hash + fetch-time verification

`PdfRenderJobRepository.markCompleted(id, storageKey, checksum)` already
persists the sha256 in `pdf_render_jobs.checksum`. The fetch path uses
`findCompletedByInvestorAndPeriod(investorId, periodId)` which returns only
`completed` rows (a pending/failed render is never served).

On every fetch the endpoint:

1. Recomputes `sha256(storedBytes)`.
2. Compares it to the persisted `checksum`.
3. Serves `200 application/pdf` with `X-Statement-Sha256` + `ETag` headers on
   match, or `409 CONFLICT` (+ security log `statement.tamper-detected`) on
   mismatch.

## Security assumptions

1. Identity comes from the verified JWT (`verifyJWT` populates `req.user`);
   headers are never trusted for identity.
2. Authorization: `admin`/`compliance` may fetch any statement; `investor`
   only their own (`req.user.id === investorId`). Other roles are forbidden —
   issuers cannot enumerate investor statements.
3. Path parameters are validated (non-empty, ≤ 128 chars) before use.
4. Bytes are never served without passing the persisted-hash check.
5. The renderer escapes PDF string literals (`\`, `(`, `)`) and collapses
   newlines in free text, so statement data cannot inject PDF directives.
6. Metric/log labels use non-PII fragments; tamper logs never include full
   artifact contents.

## Failure modes

| Scenario | Behaviour |
|----------|-----------|
| No completed job for (investor, period) | `404 NOT_FOUND` |
| Job completed but artifact missing from storage | `404 NOT_FOUND` |
| Stored bytes hash ≠ persisted checksum | `409 CONFLICT` + `statement.tamper-detected` log |
| Storage read error | `500` (internal, message not leaked) |
| Unauthenticated / wrong owner / wrong role | `401` / `403` |
| Worker crash mid-render | Row stays `processing`, reclaimed after stale window; re-render produces identical bytes (idempotent storage key) |
| Transient render failure | Back to `pending` with backoff; retried render is byte-identical |

## Compatibility

- No existing tables are altered. `pdf_render_jobs.checksum` continues to be
  the persisted hash; the new fetch endpoint only *reads* completed rows.
- New repository methods (`findByHolderAndPeriod`, `listByPeriod`,
  `listPayoutsByInvestorForPeriod`, `listPayoutsByPeriod`,
  `findCompletedByInvestorAndPeriod`) are additive.
- The existing `renderStatementPdfDetails` / `makeStatementRenderFn` API is
  unchanged; the content-aware pipeline is added alongside it via
  `renderStatementPdfWithContent` / `makeContentStatementRenderFn`.
- Storage currently defaults to `InMemoryStatementPdfStorage` (see `index.ts`
  mount); replace with the S3-backed adapter when deployed. Without an
  adapter, fetch requests simply `404` (fail-safe).

## Tests

```bash
npx jest --runInBand \
  src/services/statementDataProvider.test.ts \
  src/services/statementPdfService.test.ts \
  src/routes/statements.test.ts \
  src/db/repositories/pdfRenderJobRepository.test.ts \
  src/db/repositories/balanceSnapshotRepository.test.ts \
  src/db/repositories/distributionRepository.test.ts \
  --coverage \
  --collectCoverageFrom='src/services/statementDataProvider.ts' \
  --collectCoverageFrom='src/services/statementPdfService.ts' \
  --collectCoverageFrom='src/routes/statements.ts'
```

Coverage includes: happy paths, IDOR/authz boundaries, tampered bytes (409),
empty/zero-distribution periods, mid-period transfers, invalid inputs, and
determinism (identical inputs → identical sha256; mutated content → different
sha256).
