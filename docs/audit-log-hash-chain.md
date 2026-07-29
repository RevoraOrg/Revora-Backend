# Audit Log Hash Chain Integrity

## Overview

The `audit_logs` table is append-only and tamper-evident. Each row stores:

| Column | Purpose |
|--------|---------|
| `prev_hash` | `row_hash` of the prior row, or the genesis anchor for the first row |
| `row_hash` | SHA-256 of a canonical pipe-delimited payload including `prev_hash` |

Verification walks rows in `(created_at ASC, id ASC)` order and detects:

- **Edits** — stored `row_hash` no longer matches row content (`hash_mismatch`)
- **Deletes** — subsequent `prev_hash` no longer links (`gap_detected`)
- **Missing hashes** — incomplete migration or manual schema damage (`missing_hashes`)

## Security assumptions

1. **Append-only enforcement** — PostgreSQL `BEFORE UPDATE` and `BEFORE DELETE` triggers reject mutations.
2. **Hash computation at insert** — `BEFORE INSERT` trigger sets `prev_hash` and `row_hash`; application code cannot skip the chain.
3. **Genesis anchor** — `SHA-256('REVORA_AUDIT_LOG_GENESIS_v1')` is shared between SQL and TypeScript.
4. **Periodic verification** — nightly scheduler and CI workflow detect tampering even if triggers were bypassed at the DB admin layer.
5. **No secrets in hashes** — only row fields already stored in `audit_logs` are hashed.

## Schema migration

Migration `013_audit_log_hash_chain.sql`:

1. Adds `prev_hash` and `row_hash`
2. Backfills existing rows in chain order
3. Sets `NOT NULL` constraints
4. Installs insert + deny-update/delete triggers

Apply with:

```bash
npm run migrate
```

## Verification

### CLI (operations / CI)

```bash
npm run verify-audit-integrity
```

- Exit `0` — chain valid
- Exit `1` — tamper detected or runtime error

### Standalone Receipt Verifier CLI (Auditors)

Auditors can verify an exported audit log excerpt against a published cryptographic receipt without running the application server or accessing the database:

```bash
npx ts-node scripts/verify-audit-receipt.ts --receipt <path-or-url-to-receipt> --excerpt <path-or-url-to-excerpt>
```

Or positional format:

```bash
npx ts-node scripts/verify-audit-receipt.ts <receipt.json> <excerpt.json-or-jsonl>
```

#### Verification Receipt Schema (`AuditReceipt`)

```json
{
  "version": "revora-audit-receipt-v1",
  "published_at": "2026-01-15T10:15:00.000Z",
  "start_prev_hash": "bee58147dc813f93e3b43277b5da53c1a1620f2258f953b75a25fe5774f999be",
  "expected_head_hash": "75da7a8205ab1cb890612851d7ae5ca2da6a390cca5df14754b75597ff8d1f7e",
  "total_rows": 3,
  "start_id": "00000000-0000-4000-8000-000000000001",
  "end_id": "00000000-0000-4000-8000-000000000003",
  "signature": "ed25519:abcdef1234567890"
}
```

#### Exit Codes & Output Format

- `0` — Pass: Step-by-step derivation trace confirms integrity of all log entries against the published receipt.
- `1` — Fail: Tamper detected, missing entries (truncated excerpt), broken chain link, or missing receipt anchor. Emits actionable recovery recommendation details.

Pass `--json` to output machine-readable JSON reports.

### Programmatic

```typescript
import { verifyAuditLogIntegrity } from './security/audit';
import { pool } from './db/client';

const result = await verifyAuditLogIntegrity(pool);
if (!result.valid) {
  console.error(result.failure);
}
```

### In-memory tests

```typescript
import { verifyAuditHashChain } from './security/auditHashChain';
```

## Metrics and alarms

`AuditIntegrityScheduler` records:

| Metric | Type | Meaning |
|--------|------|---------|
| `audit_integrity_valid` | gauge | `1` last pass, `0` failure |
| `audit_integrity_rows_verified` | gauge | Rows checked |
| `audit_integrity_verification_duration_ms` | histogram | Check duration |
| `audit_integrity_failures_total` | counter | Failures by `failure_type` |
| `audit_integrity_success_total` | counter | Successful checks |
| `audit_integrity_verification_errors_total` | counter | Runtime errors |

On failure the scheduler emits a structured **critical** log with `alarm: audit_log_integrity_failure`.

Enable in production:

```typescript
import { pool } from './db/client';
import { createAuditIntegrityScheduler } from './security/audit';

const scheduler = createAuditIntegrityScheduler(pool, { runOnStart: true });
scheduler.start();
```

Default interval: **24 hours** (`AUDIT_INTEGRITY_INTERVAL_MS` can be wired at bootstrap if needed).

## Nightly CI verification

`.github/workflows/audit-integrity-nightly.yml` runs:

1. PostgreSQL service container
2. `npm run migrate`
3. `npm run test:audit-integrity`
4. `npm run verify-audit-integrity`

Workflow failure should page on-call via existing GitHub alerting integrations.

## Testing

```bash
npm run test:audit-integrity
```

Coverage includes:

- Valid empty, single, and multi-row chains
- Mid-chain tamper (edited action/details)
- Deleted row (gap detection)
- Forged `row_hash`
- Missing hashes / broken genesis
- Post-migration backfill simulation
- Scheduler metrics and alarms
- CLI exit codes

## Canonical payload format

```
id|user_id|action|resource|details|ip_address|user_agent|created_at_ms|prev_hash
```

- Null fields → empty string
- `ip_address` → host only (no CIDR)
- `created_at_ms` → Unix epoch milliseconds

This format is implemented in both `audit_log_canonical_payload()` (SQL) and `buildAuditCanonicalPayload()` (TypeScript) and must remain synchronized.

## Relevant code

- `src/db/migrations/013_audit_log_hash_chain.sql`
- `src/security/auditHashChain.ts`
- `src/security/auditIntegrityScheduler.ts`
- `src/cli/verifyAuditIntegrity.ts`
- `src/db/repositories/auditLogRepository.ts`
- `src/security/audit.ts`
