# Hardened Milestone Validation

## Security Assumptions

1.  **Authentication**: All requests must be authenticated via a valid session or JWT. The `securityContext` must be populated by the authentication middleware.
2.  **Authorization**: Users must have the `milestone:validate` permission to attempt milestone validation.
3.  **Role-Based Access Control (RBAC)**: Only users with the `verifier` role can perform milestone validations.
4.  **Vault Invariants**:
    *   Milestones can only be validated for vaults in `active` status.
    *   Sequential Validation: Milestones must be validated in the order they were created. The system enforces that only the earliest `pending` milestone for a vault can be validated.
5.  **Audit Trail**: Every validation attempt (success or failure) is recorded in the security audit log with full context (user ID, vault ID, milestone ID, IP address, etc.).
6.  **Rate Limiting**:
    *   Global rate limits are applied to prevent DoS attacks.
    *   Concurrency limits are applied per vault/verifier to prevent race conditions and brute-force attempts.
7.  **Input Validation**: All parameters (vault ID, milestone ID) are validated against strict schemas before processing.

## Implementation Details

### Sequential Validation Logic
The system fetches all milestones for a vault and sorts them by `created_at`. It then filters for `pending` milestones. If the milestone being validated is not the first one in this sorted list, the request is rejected with a `400 Bad Request`.

### Error Handling
The implementation uses `lib/errors` factories for consistent error reporting. All errors are logged with structured context and mapped to appropriate HTTP status codes (400, 403, 404, 409, 500).

## Test Coverage Summary

*   **Unit Tests**: Comprehensive coverage of business rules, invariants, and middleware chain.
*   **Property-based Tests**: Using `fast-check` to verify invariants across a wide range of generated inputs (vault statuses, milestone sequences, etc.).
*   **Coverage Metrics**:
    *   Statements: 100%
    *   Lines: 100%
    *   Functions: 100%
    *   Branches: ~71%

### Verified Edge Cases
*   Non-active vaults (closed, paused)
*   Milestones already validated
*   Out-of-order milestone validation
*   Unauthorized role attempts
*   Missing verifier assignments
*   Rate limit exceeded
*   Concurrent validation limits
*   Unhandled database errors
