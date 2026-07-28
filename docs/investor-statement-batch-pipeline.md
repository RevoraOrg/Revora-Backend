# Investor Statement PDF Batch Pipeline

## Problem

Closing a period requires rendering thousands of investor statement PDFs.
Doing that **serially** exceeds the maintenance window. A process crash mid-run
must not lose progress or leave **duplicate** PDF objects in storage.

## Solution

A Postgres-backed, resumable job queue:

```
enqueuePeriod(period, investors)
        │
        ▼
┌─────────────────────┐
│ pdf_render_batches  │  run summary / counters
└─────────┬───────────┘
          │ 1:N
          ▼
┌─────────────────────┐     claim (SKIP LOCKED + stale reclaim)
│  pdf_render_jobs    │◄──────────────────────────────────────┐
│  status checkpoint  │                                       │
└─────────┬───────────┘                                       │
          │                                                   │
          ▼                                                   │
   worker pool (N)  ──render──► storage.put(deterministic key)│
          │                                                   │
          ├── success → markCompleted (storage_key, checksum)─┘
          └── failure → pending+backoff OR failed dead-letter
```

Checkpoints live **only in Postgres** (job `status`, `storage_key`, `checksum`,
`claimed_at`). Workers are memory-stateless and safe to kill.

## Components

| Piece | Path |
|-------|------|
| Migration | `src/db/migrations/017_create_pdf_render_jobs.sql` |
| Repository | `src/db/repositories/pdfRenderJobRepository.ts` |
| Renderer | `src/services/statementPdfService.ts` |
| Worker | `src/services/statementPdfBatchWorker.ts` |

### Claim semantics

`claimJobs(limit, staleAfterMs)` selects:

- `status = pending AND available_at <= NOW()`, or
- `status = processing AND claimed_at` older than the stale window (crash reclaim)

…with `FOR UPDATE SKIP LOCKED`, then flips rows to `processing` and commits
**before** rendering so locks are not held across PDF generation.

### No duplicate outputs

Storage keys are deterministic:

`statements/{period_id}/{investor_id}.pdf`

A resumed job overwrites the same object. Completion is recorded only after a
successful `putObject`, so receivers never see two keys for one investor/period.

### Throughput metric

| Metric | Type | Meaning |
|--------|------|---------|
| `statement_pdf_jobs_enqueued_total` | counter | Jobs inserted |
| `statement_pdf_jobs_completed_total` | counter | Successful renders |
| `statement_pdf_jobs_failed_total` | counter | Dead-lettered jobs |
| `statement_pdf_render_duration_ms` | histogram | Per-job latency |
| `statement_pdf_throughput_jobs_per_sec` | gauge | Sliding 60s completion rate |
| `statement_pdf_batch_backlog` | gauge | Pending+processing count |

## Failure modes

| Scenario | Behaviour |
|----------|-----------|
| Worker crash mid-render | Row stays `processing` until stale window, then reclaimable |
| Transient render error | Back to `pending` with exponential `available_at` backoff |
| Exhausted attempts | `failed` dead-letter; batch failed_jobs++ |
| Re-enqueue same investors in batch | `ON CONFLICT DO NOTHING` |
| Two workers race | `SKIP LOCKED` — each job claimed once |
| Resume after partial success | Only pending/stale processing rows claimed; completed skipped |

## Security assumptions

1. Worker endpoints / admin enqueue APIs must be authenticated (admin-only).
2. Metric labels use short non-PII fragments (`period` truncated, `batch` hex prefix).
3. Storage keys must not embed secrets; investor IDs are already authz-scoped upstream.
4. Overwrite-on-resume prevents orphan objects from multiplying attack surface in buckets.

## Running the tests

```bash
npx jest --runInBand \
  src/services/statementPdfBatchWorker.test.ts \
  src/db/repositories/pdfRenderJobRepository.test.ts \
  --coverage \
  --collectCoverageFrom='src/services/statementPdfBatchWorker.ts' \
  --collectCoverageFrom='src/services/statementPdfService.ts' \
  --collectCoverageFrom='src/db/repositories/pdfRenderJobRepository.ts' \
  --coverageThreshold='{"global":{"statements":95,"branches":90,"functions":95,"lines":95}}'
```

## Example usage

```ts
const storage = new InMemoryStatementPdfStorage(); // or S3 adapter
const repo = new PdfRenderJobRepository(pool);
const worker = new StatementPdfBatchWorker(
  repo,
  makeStatementRenderFn(storage),
  metrics,
  { concurrency: 8, batchSize: 50, staleAfterMs: 15 * 60_000 },
);

await worker.enqueuePeriod('2026-06', investorIds);
worker.start(); // or cron: await worker.drainOnce();
```

## Files changed

| File | Change |
|------|--------|
| `017_create_pdf_render_jobs.sql` | Batches + jobs tables |
| `pdfRenderJobRepository.ts` | Enqueue / claim / checkpoint |
| `statementPdfService.ts` | Deterministic render + storage |
| `statementPdfBatchWorker.ts` | Pool + metrics + resume |
| `*.test.ts` | Edge cases incl. crash resume |
| `docs/investor-statement-batch-pipeline.md` | This document |
