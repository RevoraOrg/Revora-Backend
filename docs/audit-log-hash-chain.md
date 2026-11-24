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
6. **External publication** — when `WITNESS_REKOR_URL` is set, the verified chain head is published to a Rekor transparency log so the root has a public, append-only timestamp. When it is unset, the in-process mock witness is used (development/test only).

## External witness publication (Rekor)

`RekorWitnessClient` implements the `WitnessClient` interface used by `AuditWitnessPublisher`. The scheduler selects it automatically when `WITNESS_REKOR_URL` is configured:

```bash
WITNESS_REKOR_URL=https://rekor.sigstore.dev
```

### Submission format

The client posts a Rekor v1 `rekord` proposed entry to `/api/v1/log/entries`:

```json
{
  "apiVersion": "0.0.1",
  "kind": "rekord",
  "spec": {
    "data": { "content": "<base64 of the UTF-8 SHA-256 root hash>" },
    "signature": {
      "format": "x509",
      "content": "<base64 signature>",
      "publicKey": { "content": "<base64 SPKI DER public key>" }
    }
  }
}
```

A fresh P-256 keypair is generated for each submission. The signature exists only to satisfy Rekor's signed-entry schema; the ephemeral public key is not a Revora identity or a long-lived signing credential. The tamper-evidence property comes from the public log recording that exact root hash at a specific time.

### Receipt mapping

A successful Rekor response is a UUID-keyed object. The client maps it to `WitnessReceipt`:

| Receipt field | Source |
|---------------|--------|
| `rootHash` | Root hash passed to `publish()` |
| `witnessType` | Constant `rekor` |
| `publishedAt` | Rekor `integratedTime` (Unix seconds) |
| `receiptData.uuid` | Response object key or `ETag` header |
| `receiptData.logIndex` | Rekor `logIndex` |
| `receiptData.integratedTime` | Rekor `integratedTime` |
| `receiptData.logId` | Rekor `logID` (when present) |

### Security and failure handling

- Only HTTPS endpoints without embedded credentials are accepted. Production requests use `safeFetch`, which validates DNS/addresses, pins connections, and re-validates redirects.
- Root hashes must be 64-character SHA-256 hex strings; arbitrary strings are rejected before any request is made.
- Each attempt has an abort timeout (default 10s). HTTP 5xx, 429, timeouts, and network errors are retried with exponential backoff (default 3 retries, 250ms base). HTTP 4xx and malformed 2xx responses fail immediately.
- Exhausted failures throw `RekorWitnessError`; `AuditWitnessPublisher` logs an `audit_witness_publish_failure` alarm and applies its own retry policy without failing local integrity checks.
- Tests inject a stubbed fetch implementation, so no real network calls are made.

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
