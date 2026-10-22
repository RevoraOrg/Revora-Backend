# OFAC / EU / UK Sanctions Screening on Investment Submission

## Overview

Before any investment is persisted, the investor **and any beneficial owners**
are screened against the latest verified OFAC SDN (and EU/UK, when snapshots are
available) sanctions list. A scheduled job refreshes the lists daily and stores
a **versioned, checksum-verified snapshot** so that a past screening decision can
be reproduced for audits.

The screening result and the exact list version used are stored **on the
investment row**, guaranteeing that a pass decision is traceable to the specific
list revision that authorized it.

## Data model

### `investments` (altered by migration `025`)
| Column                    | Type        | Purpose                                                        |
| ------------------------- | ----------- | -------------------------------------------------------------- |
| `screening_status`        | `VARCHAR(32)` | `passed`, `blocked`, or `error`                             |
| `screening_list_version`  | `VARCHAR(128)` | OFAC snapshot version used (e.g. publication date)         |
| `screening_result`        | `JSONB`     | Full screening outcome incl. versions + matches                 |

### `sanctions_screening_snapshots`
Versioned, checksum-verified snapshots keyed by `(list_source, version)`.

| Column                 | Type        | Purpose                                        |
| ---------------------- | ----------- | ---------------------------------------------- |
| `list_source`          | `VARCHAR(32)` | `ofac`, `eu_consolidated`, `uk_hmt`          |
| `version`              | `VARCHAR(128)` | Source list revision                       |
| `entry_count`          | `INTEGER`   | Number of normalized entries                    |
| `normalized_checksum`  | `VARCHAR(64)` | SHA-256 of canonicalized entries            |
| `entries`              | `JSONB`     | The normalized entries themselves                |

## Components

### `src/db/repositories/sanctionsListRepository.ts`
Stores and reads versioned snapshots. `calculateChecksum` produces a canonical
SHA-256 of the entries; `verifyChecksum` lets an auditor re-verify integrity.
`findLatest` **throws when no verified snapshot exists** (fail-closed) so an
investment can never be cleared against an empty list.

### `src/services/sanctionsScreeningService.ts`
- `normalizeName` applies Unicode **NFKD** decomposition, removes combining
  diacritical marks, lower-cases, and collapses whitespace — defeating
  homoglyph / fullwidth / accented variants (`Iván` ≡ `Ivan`).
- Matching: `exact`, `alias`, and `partial` (substring ≥ 3 chars).
- Returns `complete` + `cleared`. When any supported source lacks a verified
  snapshot, `complete == false` and callers MUST reject (fail-closed). Partial
  matches are treated as hits (flagged for review, never auto-passed).

### `src/jobs/refreshSanctionsListsJob.ts`
Daily job that loads the OFAC list via `OfacSanctionsLoader` (which verifies the
upstream Ed25519 signature and pinned parse hash), re-checks the canonical
checksum, and persists a new snapshot. On any verification failure it records a
`failed` metric and **does not promote** a partial/untrusted list — the previous
snapshot stays current.

### Screening step in `src/services/investmentService.ts`
1. Resolves the investor's name (via `UserRepository`) plus `beneficial_owners`.
2. Runs `SanctionsScreeningService.screen(...)` **before** `repo.create(...)`.
3. **On a hit**: writes an audit log (`investment_sanctions_screening_blocked`)
   with the reason and a reviewer-queue link, then throws `403`.
4. **On an incomplete list**: writes an audit log (`error`) and throws `503`
   (fail-closed).
5. **On a pass**: records `passed` + version + result onto the investment row.

Wiring: `src/services/investmentServiceSetup.ts` builds the service with
screening + audit dependencies; `src/routes/investments.ts` and the batch worker
(`ROLE=batch|all`) initialize it.

## Security assumptions

- **Fail-closed default**: an investment is never cleared against a missing,
  stale, or untrusted list.
- **Checksum verification**: list content is integrity-checked before the
  snapshot is trusted; tampered/truncated downloads cannot be promoted.
- **Unicode normalization**: NFKD + combining-mark removal prevents homoglyph /
  fullwidth / accented bypasses.
- **Audit trail**: every blocked/error decision is written to `audit_logs` with
  the reason and an **internal reviewer-queue link** to `/api/v1/aml/ofac-reviews`.
- **Link sanitization** (`src/lib/reviewLink.ts`): only relative, single-segment
  internal paths are persisted — scheme/host injection and `..` traversal are
  rejected so a caller-controlled value can never forge an external link.

## Edge cases handled

| Scenario                              | Behavior                                                  |
| ------------------------------------- | ---------------------------------------------------------- |
| No verified list snapshot             | `complete=false` → investment rejected (503, fail-closed)  |
| OFAC signature / pin-hash check fails | Job refuses to persist; previous snapshot retained         |
| Partial-match alias (e.g. `Maria`)     | Flagged as `partial` hit → review, never auto-passed       |
| Unicode / homoglyph name              | Matched after NFKD + combining-mark normalization          |
| Beneficial owner hit                  | Screened alongside investor; blocks the submission         |
| No screening service configured        | Screening skipped (opt-out for tests / local dev)          |

## Environment

| Variable                  | Required | Default | Description                              |
| ------------------------- | -------- | ------- | ---------------------------------------- |
| `OFAC_LIST_URL`           | No       | —       | OFAC SDN list CSV URL                    |
| `OFAC_SIG_URL`            | No       | —       | Ed25519 signature (hex) URL              |
| `OFAC_TRUST_ANCHOR_BASE64`| No       | —       | Base64 Ed25519 public key for signature |
| `OFAC_FETCH_TIMEOUT_MS`   | No       | 30000   | Fetch timeout                            |

The daily refresh job is enabled for `ROLE=batch` or `ROLE=all`.

## Testing

```bash
npx jest src/db/repositories/sanctionsListRepository.test.ts \
  src/services/sanctionsScreeningService.test.ts \
  src/jobs/refreshSanctionsListsJob.test.ts \
  src/services/investmentService.test.ts \
  src/lib/reviewLink.test.ts --coverage
```

Coverage on the feature set is held to **≥ 95%** (statements/functions/lines).

Key test scenarios:
- fail-closed when a list source is missing,
- exact / alias / partial match behavior,
- Unicode normalization equivalence,
- investment blocked (no insert + audit log) vs. passed (logs version/result),
- checksum verify + tamper detection,
- daily refresh success and fail-closed persistence refusal.