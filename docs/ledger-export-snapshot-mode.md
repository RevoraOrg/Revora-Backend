# Ledger Export Snapshot Mode

## Overview

The Ledger Export Snapshot Mode provides **byte-for-byte reproducible exports** for auditors who need to hash-verify downloaded files against what the ledger produced.

When `snapshot=true` is specified, the export:

1. **Resolves late-arriving events** to a closed period boundary using `cutoff_at`
2. **Emits deterministic ordering** sorted by `(entry_date ASC, id ASC)`
3. **Computes SHA-256** during export and returns it in both the response body and HTTP headers

## API Reference

### Request

```http
GET /ledger/export?gl_account={gl_account}&snapshot=true&cutoff_at={iso8601_timestamp}
```

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `gl_account` | string | Yes | GL account identifier to export |
| `snapshot` | string | No | Set to `"true"` to enable snapshot mode |
| `cutoff_at` | string | No | ISO 8601 timestamp; entries recorded after this time are excluded. Requires `snapshot=true` |
| `limit` | number | No | Maximum entries to return (default: 100, max: 1000) |
| `cursor` | string | No | Pagination cursor for next page |

### Response Headers (Snapshot Mode)

| Header | Description |
|--------|-------------|
| `Content-SHA-256` | SHA-256 hash of the export (hex, 64 characters) |
| `X-Snapshot-Mode` | Set to `"true"` when snapshot mode is active |
| `X-Snapshot-Cutoff-At` | The cutoff timestamp used (if `cutoff_at` was provided) |

### Response Body

```json
{
  "entries": [...],
  "totals": {
    "total_debit": "1000.00",
    "total_credit": "500.00",
    "entry_count": 2
  },
  "next_cursor": "...",
  "has_more": false,
  "content_sha256": "a1b2c3d4e5f6...64 hex chars..."
}
```

## Security Assumptions

1. **Late-arriving events** after `cutoff_at` are excluded and logged for audit trail
2. **Deterministic sort** ensures the same data always produces the same hash
3. **SHA-256 hash** allows byte-for-byte verification of downloaded exports
4. **HTTP headers** provide transport-level verification without parsing the body

## Usage Examples

### Basic Snapshot Export

```bash
curl "http://localhost:3000/ledger/export?gl_account=1050-Custody&snapshot=true"
```

### Snapshot with Cutoff

```bash
curl "http://localhost:3000/ledger/export?gl_account=1050-Custody&snapshot=true&cutoff_at=2026-07-02T12:00:00Z"
```

### Verify Export Hash

After downloading the export, verify the hash:

```bash
# Download the export
curl -o export.jsonl "http://localhost:3000/ledger/export?gl_account=1050-Custody&snapshot=true"

# Compute SHA-256
sha256sum export.jsonl

# Compare with the hash from the response or Content-SHA-256 header
```

## Implementation Details

### Deterministic Sorting

Entries are sorted by:
1. `entry_date` ascending (primary)
2. `id` ascending (secondary, for tie-breaking)

This ensures consistent ordering regardless of insertion order or database state.

### Hash Computation

The SHA-256 hash is computed over the canonical JSONL representation:
- One JSON object per line
- No trailing newline in hash input
- Entries sorted deterministically before hashing

### Cutoff Filtering

When `cutoff_at` is provided:
- Only entries with `recorded_at <= cutoff_at` are included
- Late-arriving events are silently excluded (logged at debug level)
- The cutoff timestamp is included in response headers for verification

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Empty result set | Returns empty entries array, no `content_sha256` |
| `cutoff_at` without `snapshot=true` | Returns 400 error |
| Invalid `cutoff_at` format | Returns 400 error |
| `snapshot=false` | Behaves exactly like default (non-snapshot) mode |
| All entries excluded by cutoff | Returns empty entries, no `content_sha256` |

## Testing

Run the snapshot mode tests:

```bash
npm test -- --testPathPattern=ledgerExport.test.ts
```

Test coverage includes:
- Deterministic hash computation
- Entry sorting verification
- Cutoff filtering
- Pagination in snapshot mode
- Invalid parameter handling
- Edge cases (empty results, all excluded)
