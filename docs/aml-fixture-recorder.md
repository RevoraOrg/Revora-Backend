# AML recorder fixture contract

This note documents the intent and boundary behavior of the fixture recorder used for AML/KYC provider interactions.

## Purpose

The recorder captures request/response traces, redacts sensitive values, and writes deterministic JSON fixtures for test replay. It is intentionally scoped to test-only code paths and must not be imported into production logic.

## Public contract

The main exported structures are:

- `RecordedRequest`: a request trace with method, path, headers, optional body, and timestamp.
- `RecordedResponse`: a response trace with status, headers, body, and timestamp.
- `RecordedInteraction`: a labeled pair of a request and its response.

These objects are treated as structural contracts in tests and runtime validation. Invalid input is rejected with `TypeError` so failures are deterministic and easy to diagnose.

## Security assumptions

- Redaction runs before serialization to disk.
- Header names and values are validated so malformed data does not quietly propagate into fixtures.
- HTTP status values must remain within the valid 100-599 range.
- Request paths must be non-empty and must start with `/` to avoid malformed routing traces.

## State transitions

The recorder remains in a simple lifecycle:

1. `createRecorder` creates an empty in-memory recording session.
2. `record()` appends a new interaction and increments the count.
3. `flush()` writes the full fixture file and persists redaction metadata.
4. `loadFixtures()` reads the saved JSON back for replay or assertion.

This gives deterministic test behavior and keeps fixture generation easy to reason about during CI and audit reviews.
