# API Version Prefix Consistency

## Overview
This document details the standardization of the API version prefix across the Revora Backend services. The system relies on an environment variable `API_VERSION_PREFIX` with a default of `/api/v1` to namespace all API endpoints.

## Implementation Details
- The version prefix is centrally managed in `src/index.ts`.
- Non-API endpoints such as infrastructure and operational routes (e.g. `/health`) intentionally omit the prefix to maintain predictable tooling integrations explicitly separate from business logic routing.
- All internal domains, endpoints, and authenticated operations run exclusively through the prefixed router.

## Security Assumptions & Abuse/Failure Paths
1. **Unprefixed Access Denial:** Any API route accessed without the proper version prefix correctly defaults into the application's wildcard 404 response. No unversioned fallback exists for API logic domains, effectively preventing version confusion, downgrade attacks, or unintended route enumeration outside the explicit API boundary.
2. **Explicit Auth Boundary Constraints:** Authentication middlewares (e.g. `requireAuth`) are intentionally mounted within the prefixed API router or specific protected sub-routers (such as `createMilestoneValidationRouter`). By strictly scoping these, we ensure any external or malicious access targeting paths like `/vaults/...` without `/api/v1` prefix encounters a 404 rather than an improper execution path. This guarantees our authentication boundary is mathematically sealed against improper path canonicalization.
3. **Graceful Defaults & Failures:** `API_VERSION_PREFIX` relies on process environment but provides a hardcoded fallback (`/api/v1`). If the configuration environment crashes, the API gracefully binds to the fallback, averting an unintentional binding to the root `/` namespace which would expose business logic directly and break infrastructure routing assumptions.

## Testing Strategy
- Core test `Revora-Backend/src/routes/health.test.ts` acts as the definitive integration test for endpoint scoping across generic and protected domains.
- Verified missing prefix results deterministically into 404 for API resources.
- Validated prefix propagates gracefully to internal routes.

### Test Output and Security Notes (`npx jest src/routes/health.test.ts`)
The `API Version Prefix Consistency tests` suite successfully validates the implemented security and boundary assumptions:

```text
PASS src/routes/health.test.ts
  Health Router
    √ should return 200 when both DB and Stellar are up
    ...
  API Version Prefix Consistency tests
    √ should resolve /health without API prefix (303 ms)
    √ should resolve api routes with API_VERSION_PREFIX (27 ms)
    √ should return 404 for api routes without prefix (20 ms)
    √ should correctly scope protected endpoints under the prefix (30 ms)
    √ should 404 for protected endpoints if prefix is lacking (22 ms)

Test Suites: 1 passed, 1 total
Tests:       10 passed, 10 total
```
This guarantees no regressions in routing boundaries occur as subsequent business logic routers merge into `apiRouter`.
