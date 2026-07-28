# Storage-Layout Drift Report

## Overview

Before scheduling a Soroban contract upgrade, a dry-run diff report flags
potential storage-layout incompatibilities between the currently deployed
code-id and the proposed target code-id.

## How it works

1. The caller posts two **ABI descriptors** (JSON objects describing each
   code-id's storage entries) to `POST /api/v1/contract-upgrades/drift-report`.
2. The service validates both descriptors, computes a structural diff, and
   classifies the severity.
3. If breaking changes are detected, a `STORAGE_LAYOUT_DRIFT_ALARM` is
   emitted via the structured logger (consumed by the alerting pipeline).

## Storage-entry schema

| Field         | Type     | Description                                          |
|---------------|----------|------------------------------------------------------|
| `key`         | `string` | Unique key within the contract's storage namespace   |
| `storageType` | `enum`   | `instance`, `persistent`, or `temporary`             |
| `valueType`   | `string` | Soroban value type (`Bytes`, `Uint32`, `Address`, …) |
| `description` | `string` | Optional human-readable description                  |

## Breaking changes (block the upgrade)

- Removing a storage entry that existed in the current version.
- Changing the storage lifetime of an existing entry
  (`instance ↔ persistent ↔ temporary`).
- Changing the value type of an existing entry.

## Safe changes (allow the upgrade)

- Adding new storage entries (defaults are set by the contract).
- No structural changes (identical layout).

## Recommendation matrix

| Condition                    | Recommendation     |
|------------------------------|--------------------|
| No changes                   | `safe`             |
| Additions only               | `review_required`  |
| Any removal or modification  | `blocking`         |

## API

### `POST /api/v1/contract-upgrades/drift-report`

**Request body:**

```json
{
  "current_descriptor": { "version": "1.0", "codeId": "aaa", "entries": [...] },
  "target_descriptor":  { "version": "1.0", "codeId": "bbb", "entries": [...] },
  "upgrade_id": "optional-upgrade-id"
}
```

**Responses:**

| Status | Meaning                                                    |
|--------|------------------------------------------------------------|
| 200    | Safe or review_required — no breaking changes              |
| 422    | Blocking — breaking storage-layout changes detected         |
| 400    | Missing or malformed descriptors                            |
| 503    | Drift service not initialised                               |

**Response body:**

```json
{
  "report": {
    "currentCodeId": "aaa",
    "targetCodeId": "bbb",
    "timestamp": "2026-07-28T12:00:00.000Z",
    "diff": {
      "added": [...],
      "removed": [...],
      "modified": [...]
    },
    "hasBreakingChanges": true,
    "breakingChanges": ["Removed storage entry 'owner' (instance/Address)"],
    "recommendation": "blocking"
  },
  "alert_emitted": true
}
```

## Security assumptions

- The endpoint is admin-only (`requireAdmin` middleware).
- Descriptors are validated at runtime via Zod schemas; malformed input
  is rejected with a 400 error.
- The service is stateless — reports are not persisted. Callers may persist
  the returned report in the audit log as needed.
- The alert alarm is emitted via the structured logger and should be
  consumed by the existing alerting/monitoring pipeline.
