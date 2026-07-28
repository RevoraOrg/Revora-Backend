# Distribution Engine Safety and Idempotency

This document outlines the design decisions and implementation details for ensuring the safety, idempotency, and robustness of the `DistributionEngine` in the Revora Backend.

## Idempotency Strategy

The `DistributionEngine` uses a parameter-based idempotency strategy. A distribution run is uniquely identified by the combination of:
- `offering_id`: The ID of the offering.
- `period_id`: The ID of the revenue period.
- `total_amount`: The total amount of revenue being distributed.

When `distribute()` is called, the engine first queries the database to see if a run with these parameters already exists.

### Case 1: Run is 'completed'
If a completed run is found, the engine immediately returns the cached results (the run details and the individual payouts). This prevents duplicate distributions and ensures that multiple calls with the same parameters are safe.

### Case 2: Run is 'processing' or 'failed' (Resumption)
If a run exists but is not completed, the engine enters a **resumption flow**. This is key to "at-least-once safety".

## Resumption Logic and At-Least-Once Safety

The resumption flow ensures that every payout is eventually persisted, even if the process is interrupted (e.g., node crash, network failure).

1. **Fetch Existing Payouts**: The engine retrieves all payouts already stored for the given run ID.
2. **Filter Required Payouts**: The engine computes the full set of required payouts based on the current balances.
3. **Delta Persistence**: It filters out any payouts that have already been persisted (based on `investor_id`).
4. **Retry Missing Payouts**: It attempts to persist only the missing payouts.
5. **Finalization**: Once all payouts are successfully persisted, the run status is updated to `completed`.

This design guarantees that we never skip an investor and never create duplicate payouts for the same run.

## Error Handling and Stellar RPC Failures

The engine integrates with the `classifyStellarRPCFailure` utility to handle transient failures from the Stellar network or other upstream providers gracefully.

### `classifyStellarRPCFailure` Behavior
This utility maps arbitrary error objects into deterministic, client-safe classes:
- `TIMEOUT`: Network timeouts or abort errors.
- `RATE_LIMIT`: HTTP 429 responses.
- `UPSTREAM_ERROR`: HTTP 5xx responses from Horizon/RPC nodes.
- `UNAUTHORIZED`: HTTP 401/403 responses.
- `MALFORMED_RESPONSE`: Syntax errors in JSON parsing.

In the `DistributionEngine`, these classifications are used for:
- **Structured Logging**: Log entries include the `failureClass` for better observability.
- **standardized Errors**: Upstream errors are wrapped in `AppError` (via `Errors.serviceUnavailable`) before being returned to the caller, ensuring no sensitive raw error strings cross the trust boundary.

### Retries
The engine uses an exponential backoff retry strategy for all transient failures (database queries and balance fetching).

## Related Files
- [distributionEngine.ts](file:///c:/Users/EMMA/Desktop/revora/src/services/distributionEngine.ts) - Main implementation.
- [distributionRepository.ts](file:///c:/Users/EMMA/Desktop/revora/src/db/repositories/distributionRepository.ts) - Database interactions.
- [stellarRpcFailure.ts](file:///c:/Users/EMMA/Desktop/revora/src/lib/stellarRpcFailure.ts) - Error classification logic.
- [stellar.test.ts](file:///c:/Users/EMMA/Desktop/revora/src/lib/stellar.test.ts) - Tests for Stellar client interactions.
