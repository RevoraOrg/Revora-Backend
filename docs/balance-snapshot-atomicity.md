# Balance Snapshot Atomicity

## Overview
The Balance Snapshot functionality captures the current token holdings for a specific offering at the end of a business period. Due to the high sensitivity of financial aggregates, it is imperative that these snapshots are inserted *atomically*. Partial snapshots could irreparably skew distributions and reconcilements.

## Atomic Guarantees
The atomicity is built upon `BalanceSnapshotRepository.insertMany` combining batch interactions within explicit standard transaction blocks (`BEGIN`, `COMMIT`, `ROLLBACK`). 

```typescript
// Natspec example inside the implementation
/**
 * @dev Enforces snapshot consistency across the token holders.
 * Reverts entirely dropping the transaction if one mapping insertion malfunctions natively.
 */
```

### Assumptions
1. **Implicit Postgres Transaction Limits**: We assume snapshot amounts won't exceed single-batch payload limits of Pg connections. Exceeding ~10,000 distinct holders could require paginated snapshots.
2. **Synchronous Exclusivity**: The atomic boundary does currently rely on DB transactions instead of serialized queue jobs. High concurrency requests to the identical endpoint could produce race conditions if `skipIfExists` logic triggers concurrently.

## Security Context
The endpoint `POST /api/v1/offerings/:offeringId/snapshots` enforces strict authorization (`x-user-id`, `x-user-role`). Admin or explicit operator permissions are presumed through the downstream handler, rejecting anything unauthenticated.

## Expected Failure Paths
- **DB Connection Termination**: Immediately cascades a `ROLLBACK`.
- **Duplicate Constraints (Optional)**: Re-triggering the same atomic flow safely drops into an idempotent validation branch preventing duplicate keys.
- **Missing Period Constraints**: Rejected preemptively resolving a `400 Bad Request`.
