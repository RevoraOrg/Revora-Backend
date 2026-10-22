# Ledger export streaming endpoint

## Overview

The ledger export endpoint exposes a streaming JSON-Lines export at `/ledger/export.jsonl` for large ledger snapshots. The response is emitted chunk-by-chunk, uses a manifest line first, and inserts a keepalive comment every 100 rows so intermediary proxies do not drop the socket before the full export arrives.

## Security assumptions

- Authentication is required upstream and the route rejects requests without a resolved security context.
- Offering access control is expected to be enforced earlier in the request pipeline.
- The endpoint uses a database cursor rather than materializing the full result in memory, limiting memory pressure for large exports.

## Behavior

- The route validates the `offeringId`, `year`, and `periodId` query parameters.
- A `pg-cursor` is used to stream rows from the database incrementally.
- The first line of the response is a JSON manifest containing the offering identifier, optional filters, and an estimated row count.
- Each subsequent line is a JSON object row payload, and every 100th row is followed by a `# keepalive` comment to keep the connection alive.
- If the client disconnects mid-stream, the stream destroys itself and releases the cursor and pooled client so the database resources are not leaked.

## Metrics

The endpoint emits:

- `export.stream.rows`: counter for rows emitted.
- `export.stream.duration`: histogram for total stream duration.

## Testing notes

The route is covered by regression tests for authentication, validation, filtering, manifest emission, keepalive insertion, and cleanup when the stream is destroyed early.
