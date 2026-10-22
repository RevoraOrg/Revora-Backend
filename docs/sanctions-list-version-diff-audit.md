# Sanctions List Version Diff and Audit Trail

Issue: Revora-Backend#680  
Branch: `feat/sanctions-list-diff-audit`

---

## Overview

When Treasury updates the OFAC, EU Consolidated, UN Security Council, or UK HMT
sanctions lists, the backend must:

1. **Record every load** with a SHA-256 hash of the raw payload and a
   deterministic hash of the parsed entries for offline integrity verification.
2. **Compute a per-entity diff** (added / removed / modified) against the most
   recent previous version of the same list source.
3. **Persist diff details** linked to the new version row so auditors can
   reconstruct the exact state of any version.
4. **Emit `sanctions.list.diff.size`** as a Prometheus-style gauge so Treasury
   can alert on abnormally large or unexpected list changes.
5. **Provide a downloadable changelog** endpoint restricted to the `compliance`
   and `admin` roles.
6. **Retain 7 years** of list versions for regulatory compliance; enforce via a
   scheduled job.

---

## Architecture

```
OfacSanctionsLoader               SanctionsListDiffService
   ↓  (parsed entries)                   ↓
   └──────────────────────────────────► recordLoadWithDiff()
                                              │
                               ┌──────────────┼──────────────┐
                               │              │              │
                    createVersion()   createDiffDetail()  setGauge()
                               │              │
                     sanctions_list_versions  sanctions_list_diff_details
```

### Database tables

| Table | Purpose |
|---|---|
| `sanctions_list_versions` | One row per list load; stores `raw_payload_hash`, `parse_hash`, `diff_summary`, `diff_size`, `signature_valid`, and a `previous_version_id` FK |
| `sanctions_list_diff_details` | One row per changed entity; `change_type` ∈ `{added, removed, modified}`; `previous_data` / `new_data` stored as JSONB |

Migration: `src/db/migrations/021_create_sanctions_list_versions.sql`

### Retention policy

Versions older than 7 years (`SEVEN_YEAR_MS`) are deleted by calling
`SanctionsListDiffService.applyRetentionPolicy(cutoffDate)` from a scheduled
job. Cascade deletes automatically remove associated `diff_details` rows.

---

## API Endpoints

All endpoints are mounted under `/api/v1/compliance` and require a valid JWT
with role `compliance` **or** `admin`.

### `GET /compliance/sanctions-versions`

Returns the most recent version from each supported list source, or a paginated
list for a specific source.

**Query params:**

| Param | Type | Default | Max | Description |
|---|---|---|---|---|
| `source` | string | — | — | One of `ofac`, `eu_consolidated`, `un_sc`, `uk_hmt` |
| `limit` | integer | 100 | 1000 | Max rows |

**Response `200`:**
```json
{
  "versions": [
    {
      "id": "uuid",
      "list_source": "ofac",
      "version": "2024-06-01",
      "raw_payload_hash": "a3b4...",
      "parse_hash": "c5d6...",
      "entry_count": 12345,
      "diff_summary": { "added": 12, "removed": 3, "modified": 0, "total_changes": 15 },
      "diff_size": 15,
      "previous_version_id": "uuid | null",
      "signature_valid": true,
      "loaded_at": "2024-06-01T02:00:00Z",
      "created_at": "2024-06-01T02:00:05Z"
    }
  ]
}
```

---

### `GET /compliance/sanctions-versions/:versionId`

Returns the full version record plus all per-entity diff detail rows.

**Response `200`:**
```json
{
  "version": { /* SanctionsListVersion */ },
  "diff_details": [
    {
      "id": "uuid",
      "version_id": "uuid",
      "entity_uid": "12345",
      "entity_name": "Acme Exports LLC",
      "change_type": "added",
      "previous_data": null,
      "new_data": { "uid": "12345", "name": "Acme Exports LLC", ... }
    }
  ]
}
```

---

### `GET /compliance/sanctions-changelog/:versionId`

Returns a plain-text human-readable changelog as a downloadable file.

**Response `200`:**
- `Content-Type: text/plain; charset=utf-8`
- `Content-Disposition: attachment; filename="sanctions-changelog-ofac-2024-06-01.txt"`

**Sample response body:**
```
Sanctions List Changelog
======================
Source: ofac
Version: 2024-06-01
Loaded At: 2024-06-01T02:00:00.000Z
Previous Version: <uuid>
Total Changes: 15

Added Entities (12):
  - Acme Exports LLC (UID: 12345)
  ...

Removed Entities (3):
  - Old Corp Ltd (UID: 67890)
  ...

No modified entities.
```

---

## Metrics

| Metric name | Type | Labels | Description |
|---|---|---|---|
| `sanctions.list.diff.size` | Gauge | `list_source`, `version` | Total entities changed (added + removed + modified) per load |
| `sanctions.list.diff.changes_detected` | Counter | `list_source`, `version` | Incremented once per load when `diff_size > 0`; not emitted on no-change reloads |
| `sanctions.list.retention.applied` | Counter | — | Number of version rows deleted by the retention job |

---

## Security Assumptions

1. **Authentication**: every endpoint enforces `requireCompliance` which
   verifies the JWT signature using `HMAC-SHA256` and checks `role ∈
   {compliance, admin}`. No plaintext secrets are logged.
2. **SQL injection prevention**: all repository queries use parameterised
   `$1`, `$2` placeholders via `pg`.
3. **Header injection prevention**: the `Content-Disposition` filename is
   sanitised with `/[^a-z0-9._-]/gi` before being written to the response.
4. **Diff detail integrity**: diff detail rows are written only after the
   parent `sanctions_list_versions` row is successfully committed. The
   previous bug that wrote rows with `version_id = ''` is fixed.
5. **No-change reloads**: recorded with `diff_size = 0` and do not trigger
   the `changes_detected` alert counter, preventing alert fatigue during
   routine re-fetches that produce no actual changes.
6. **Retention policy**: the 7-year cutoff is enforced externally by a
   scheduled job. The service method never silently prunes data.

---

## Usage (loader integration)

```typescript
import { OfacSanctionsLoader } from './services/ofacSanctionsLoader';
import { SanctionsListDiffService } from './services/sanctionsListDiffService';
import { SanctionsListVersionsRepository } from './db/repositories/sanctionsListVersionsRepository';
import { pool } from './db/pool';

const loader = new OfacSanctionsLoader({ /* config */ });
const repo = new SanctionsListVersionsRepository(pool);
const diffService = new SanctionsListDiffService(repo);

// Weekly cron / on-demand refresh
async function refreshSanctionsList(version: string): Promise<void> {
  const result = await loader.loadSanctions(version);

  await diffService.recordLoadWithDiff(
    'ofac',
    result.version,
    /* rawPayload from loader */ '',
    result.entries,
    result.signatureValid,
    result.parseHash,  // avoid re-hashing if already computed
  );
}

// Scheduled retention cleanup (run monthly)
async function applyRetention(): Promise<void> {
  const cutoff = new Date(Date.now() - diffService.SEVEN_YEAR_MS ?? (7 * 365.25 * 24 * 60 * 60 * 1000));
  await diffService.applyRetentionPolicy(cutoff);
}
```

---

## Test Coverage

Tests live in:
- `src/services/sanctionsListDiffService.test.ts` — unit tests for the service
- `src/routes/compliance.test.ts` — integration tests for the HTTP routes

Run targeted:
```bash
npx jest --testPathPattern='sanctionsListDiffService|compliance' --coverage
```

Coverage enforced at ≥ 95 % branches / functions / lines / statements globally
via `jest.config.js`.
