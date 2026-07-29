# Ledger-export retention labels and legal hold (#565)

Per-period retention labels prevent audit/ledger purge of periods under legal hold,
even after `AUDIT_RETENTION_DAYS` expires.

## Schema

Migration: `src/db/migrations/018_create_retention_labels.sql`

| Column | Purpose |
|--------|---------|
| `period_id` | UTC `YYYY-MM` key matching `to_char(audit_logs.created_at AT TIME ZONE 'UTC', 'YYYY-MM')` |
| `legal_hold` | When `true`, purge skips matching rows |
| `pending_action` | Dual-control queue: `add` or `remove` |

## Dual-control API (admin)

All routes require an admin JWT. Propose and approve **must** be different admins.

- `POST /api/v1/admin/retention-labels/:periodId/legal-hold/propose`
- `POST /api/v1/admin/retention-labels/:periodId/legal-hold/approve`
- `POST /api/v1/admin/retention-labels/:periodId/legal-hold/propose-release`
- `POST /api/v1/admin/retention-labels/:periodId/legal-hold/approve-release`
- `GET /api/v1/admin/retention-labels/:periodId`
- `GET /api/v1/admin/retention-labels/active`

## Purge behavior

`AuditPurgeService` / `AuditLogRepository.purgeBefore`:

1. Count expired rows whose period has `legal_hold = true` → metric `purge.skipped_hold` (sanitized as `purge_skipped_hold`).
2. Delete only expired rows **not** under an active hold.

### Hold removed → next cycle only

Approving a release clears `legal_hold` but does **not** run a purge. Eligible rows are
deleted on the **next** scheduled (or manual) `runPurge()` cycle.

## Security notes

- Two-key rule: approver identity must differ from proposer.
- Period IDs are strictly validated as `YYYY-MM`.
- Legal-hold mutations are written to `audit_logs`.
- Metrics labels are sanitized; no PII is attached to `purge.skipped_hold`.
