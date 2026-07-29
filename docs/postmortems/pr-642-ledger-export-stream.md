# Postmortem: Large Ledger Export Timeouts and Memory Exhaustion

- **PR:** #642
- **Severity:** SEV-1
- **Incident start:** 2026-07-28 14:00 UTC
- **Incident end / mitigated:** 2026-07-29 01:00 UTC
- **Author(s):** Godfr3y
- **Status:** Final

## Summary

Full-year ledger exports exceeding 50 MB timed out (504 Gateway Timeout) and exhausted heap memory under standard buffered JSON serialization. This was resolved by implementing a streaming JSON-Lines export endpoint utilizing a database cursor and backpressure.

## Timeline

All times in UTC.

| Time | Event |
|------|-------|
| 14:00 | Compliance team reported that the standard ledger export failed to download for a large offering with a 504 Gateway Timeout. |
| 14:15 | Engineering detected high memory usage and Node.js heap limit warnings on instance container api-01. |
| 14:30 | Mitigation branch `feat/ledger-export-stream-jsonl` created to stream results chunk-by-chunk. |
| 01:00 | PR #642 implemented and verified with all tests passing. |

## Blast Radius

- **Offerings affected:** Large volume offerings (e.g. offering-999)
- **Investors affected:** None (internal audit tool)
- **Payouts affected:** None
- **Systems affected:** Ledger export service

## Decimals Affected (Total)

- **Total decimals affected:** N/A (this was a performance and download timeout issue, not a ledger drift incident).
- **Breakdown by offering/asset:**
  | Offering | Asset | Amount | Drift type |
  |----------|-------|--------|------------|
  | N/A | N/A | N/A | N/A |

## Root Cause

Querying all journal entries for a full year and buffering them in memory before serializing them as a single JSON array caused substantial memory footprint and long-running queries, resulting in Nginx/Cloudflare gateway timeouts (504) and Node process heap exhaustion.

## Detection

Automated alarms on memory saturation and 504 status codes on `/ledger/export`.

## Resolution

Implemented `GET /ledger/export.jsonl` utilizing `pg-cursor` for streaming rows in 100-row batches, enforcing backpressure, and inserting keepalive comments every 100 rows to satisfy reverse proxy inactivity timers.

## What Would Have Prevented This

- Implementing streaming serialization from the inception for large database queries instead of buffering collections in-memory.

## Action Items

| Owner | Action | Due date | Status |
|-------|--------|----------|--------|
| Godfr3y | Deploy streaming ledger export to staging and production. | 2026-07-30 | Open |
