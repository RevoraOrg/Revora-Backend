# OpenAPI Request/Response Conformance

## Overview
To enforce strict parity between our Express backend and the OpenAPI specification (`src/docs/openapi.yaml`), we have introduced an automated conformance testing suite: `src/__tests__/openapi-conformance.test.ts`.

## How It Works
The conformance test dynamically parses the fully-dereferenced OpenAPI document using `@apidevtools/swagger-parser` and drives tests using `supertest`.

1. **Schema Strictness Enforcement**: 
   The test suite traverses the OpenAPI schema's `responses` block and strictly applies `additionalProperties: false` to all object definitions. This guarantees that any handler returning undocumented extra fields will fail the test immediately.
2. **Operation Execution**:
   It dynamically iterates over every documented path and method.
3. **Validation**:
   The response body is evaluated against the `openapi.yaml` schema corresponding to the actual status code returned by the Express handler (`res.status`). We use `ajv` and `ajv-formats` for accurate JSON Schema validation.
4. **Undocumented Status Catching**:
   If a handler returns a status code that is NOT documented in `openapi.yaml` for that operation, the test fails, preventing silent failure paths. Unmounted endpoints gracefully skip because they correctly return an explicit `Route not found` ErrorResponse format rather than a business logic error.

## Running the Conformance Suite
To execute the tests locally:
```bash
npm run test -- src/__tests__/openapi-conformance.test.ts
```

## Maintenance Guidelines
- Ensure that whenever you add new properties to a response, they are accurately captured in `openapi.yaml`.
- Ensure all expected success and error status codes (e.g., `400`, `401`, `404`, `503`) are modeled in the spec for your handlers.
