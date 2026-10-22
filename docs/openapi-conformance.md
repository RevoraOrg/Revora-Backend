# OpenAPI Request/Response Conformance

## Overview
`src/__tests__/openapi-conformance.test.ts` enforces strict parity between the
Express backend served by `src/index.ts` and the OpenAPI document
(`src/docs/openapi.yaml`). It asserts **both** the request schemas and the
response schemas that handlers actually serve, and that every served route is
documented (and every documented route is served).

## How It Works
The suite derives the API surface from the **served Express app**
(`express-list-endpoints`), not from the spec, so the spec cannot silently
drift from the handlers. Two tests run:

1. **Bidirectional route parity** — every HTTP operation actually mounted on
   the app must appear in the spec, and every operation in the spec must be
   mounted. A mismatch (added route, deleted route, renamed handler) fails the
   suite immediately.
2. **Request + response conformance** — each served operation is executed:
   - A request body is generated deterministically from the declared
     `requestBody` schema, then validated against that same schema (proving
     the request schema is well-formed and the body we send conforms to it).
   - The resulting response is validated against the JSON schema declared for
     the **actual** status code the handler returned. If a handler returns a
     status code that is not documented for the operation, the suite fails —
     preventing silent/unmodeled failure paths.

Schemas are made strict by recursively applying `additionalProperties: false`
to every object response (and request) schema unless it explicitly opts out
with `additionalProperties: true`. A handler returning an undocumented field
fails validation.

`ajv` + `ajv-formats` perform the JSON Schema validation. The spec is fully
dereferenced with `@apidevtools/swagger-parser` before compiling.

## Running the Conformance Suite
```bash
npm test -- src/__tests__/openapi-conformance.test.ts src/__tests__/openapi.test.ts
```

The related `src/__tests__/openapi.test.ts` suite also asserts route parity in
isolation and doubles as a cheap smoke check.

## Maintenance Guidelines
- **Whenever you add, remove, or change a handler's route, method, request
  body, or response** in `src/index.ts`, update `src/docs/openapi.yaml` so the
  spec matches. The conformance suite will otherwise fail.
- Model every HTTP status code a handler can actually return, including
  `400`, `401`, `403`, `404`, `409`, `429`, `422`, `500`, and `503`.
- Keep object response schemas strict (`additionalProperties: false`) so
  undocumented fields are caught. Use `additionalProperties: true` only for
  genuinely open records (e.g. persisted domain objects whose shape is owned
  elsewhere).
- The conformance suite is hermetic: it points the Stellar Horizon health
  probe at a local fast-failing address and closes DB pools afterward, so it
  runs without a database or external network.