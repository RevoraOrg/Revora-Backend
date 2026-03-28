# Investment Double-Submit Protection

## Overview

The Investment Double-Submit Protection capability ensures that developers and downstream services interacting with the Revora backend cannot accidentally process an identical investment operation multiple times.

This feature relies on an idempotency key passed through HTTP headers, creating exactly-once processing guarantees within a definable time boundary (e.g., 24 hours). This middleware intercepts business logic at the routing layer and prevents race conditions and redundant execution in case of retries, timeouts, or UI defects resulting in multiple consecutive click events.

## Architectural & Security Assumptions

1. **Idempotency Key Requirement**: The middleware enforces the presence of the `x-idempotency-key` HTTP header. Missing headers result in a strict HTTP `400 Bad Request` immediate rejection.
2. **Contextual Namespacing (Cross-User Collision Mitigation)**: Security explicitly namespaces incoming idempotency keys with the authenticated `user.id` (e.g., `<user-id>:<idempotency-key>`). This completely isolates caching domains across varying user sessions, preventing account "A" from accidentally (or intentionally) overriding the processing boundaries of account "B".
3. **Atomic State Transition**: 
   - A new key immediately transitions into a `processing` lock state, rejecting overlapping concurrent identical requests with a `409 Conflict`.
   - On response resolution, if the execution produced a successful standard output (`2xx`), the state becomes `completed`, returning a deeply-cached copy for subsequent replays.
   - For failed executions containing error codes (e.g. `5xx`), the `processing` lock is actively deleted, letting genuine transient failures immediately retry.
4. **Time-To-Live Boundary (TTL)**: Cached keys (and completed responses) automatically expire and clear out after standard 24 hours, ensuring long-term memory resilience without unneeded bloat.

## Testing Strategy

Explicit, deterministic test cases encompass Edge capabilities checking for:
- Missing headers and authentication faults.
- Standard flow (success parsing).
- Concurrency simulation hitting `409 Conflict` mid-processing locks.
- Cache replays hitting returning successfully saved references.
- Forced internal errors triggering automated lock clearance.
- Clock-manipulation simulation testing rigorous expiration mechanisms.

Detailed suites are available functionally under `src/routes/health.test.ts` to uphold a rigorous > 95% branch coverage execution requirement.
