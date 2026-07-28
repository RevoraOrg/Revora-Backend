# Distribution Engine Retry Strategy

This document outlines the retry strategy and security hardening implemented in the `DistributionEngine` service.

## Overview

The `DistributionEngine` is responsible for computing and persisting revenue distributions and individual payouts. Because these operations involve multiple database transactions and potentially external balance providers, it is critical to handle transient failures gracefully.

## Retry Mechanism

The engine implements an **Exponential Backoff Retry Strategy** for all critical I/O operations:

1.  **Balance Acquisition**: Retries if the balance provider or offering repository fails to return investor balances.
2.  **Distribution Run Creation**: Retries the initial persistence of the distribution run record.
3.  **Individual Payout Creation**: Each payout is persisted with its own retry cycle, ensuring that a transient failure for one investor doesn't necessarily block the entire process immediately.

### Configuration

The strategy can be configured via `DistributionEngineOptions`:

- `maxRetries` (default: 3): Total number of attempts for each operation.
- `initialDelayMs` (default: 500): Initial delay before the first retry.
- `backoffFactor` (default: 2): Multiplier for the delay after each subsequent failure.
- `logRetries` (default: false): Whether to log retry attempts to the console.
- `batchSize` (default: 50): **NEW** - Maximum payouts per batch to prevent database overload.

## Batch Processing

### Overview

Starting with version 2.0, the `DistributionEngine` supports **batch processing** for large payout distributions. This prevents overwhelming the database with hundreds of simultaneous INSERT operations and enables graceful handling of partial failures.

### How It Works

1. **Split Payouts into Batches**: Payouts are divided into chunks of `batchSize` (default: 50).
2. **Sequential Batch Processing**: Each batch is processed one at a time.
3. **Independent Failure Tracking**: Failed payouts are tracked separately without aborting the entire distribution.
4. **Partial Results**: The engine returns both successful and failed payouts to the caller.

### API

```typescript
// New method with batch details
const result = await engine.distributeWithBatch(offeringId, period, revenueAmount);

console.log(result.successfulPayouts); // Array of successful payouts
console.log(result.failedPayouts);     // Array of failed payouts with error classification
console.log(result.totalPayouts);      // Total attempted
```

### Error Classification

Failed payouts include an `errorClass` field using the `StellarRPCFailureClass` enum:

- `TIMEOUT`: Request timed out
- `RATE_LIMIT`: Rate limited by upstream service
- `UPSTREAM_ERROR`: Server error from external service
- `MALFORMED_RESPONSE`: Invalid response format
- `UNAUTHORIZED`: Authentication/authorization failure
- `UNKNOWN`: Unclassified error

This ensures **raw error messages never leak to clients** while maintaining full debugging information in server logs.

### Partial Failure Handling

**Scenario:** 150 investors, batch 2 experiences transient failure

**Result:**
- Batch 1 (50 payouts): ✅ Success
- Batch 2 (50 payouts): ⚠️ 45 success, 5 failed
- Batch 3 (50 payouts): ✅ Success

**Total:** 145 successful, 5 failed

The distribution run remains valid, and the caller can:
1. Log the partial failure
2. Notify administrators
3. Retry failed payouts manually
4. Update distribution run status to `partial` or `completed`

### Performance Benefits

| Investors | Without Batching | With Batching (50/batch) |
|-----------|------------------|---------------------------|
| 50        | 50 connections   | 50 connections            |
| 150       | 150 connections  | 50 connections (reused)   |
| 500       | 500 connections  | 50 connections (reused)   |

Batching significantly reduces connection pool pressure and memory usage for large distributions.

## Security Assumptions and Hardening

### Input Validation

- **revenueAmount**: Must be strictly positive (> 0).
- **offeringId**: Must be provided and non-empty.
- **period**: Must contain valid `start` and `end` dates.
- **Total Balance**: The sum of all investor balances must be strictly positive to avoid division by zero.

### Data Integrity

- **Proration Accuracy**: Payouts are computed based on the ratio of an investor's balance to the total balance.
- **Rounding Adjustment**: The engine ensures that the sum of all payouts matches the `revenueAmount` exactly by adjusting the largest share with the rounding difference (up to 0.01 units).
- **Precision**: Amounts are rounded to 2 decimal places (cents) for persistence.

### Persistence Guarantees

- **Status Tracking**: Distribution runs are created with a `processing` status.
- **Individual Retries**: Payouts are attempted individually, allowing the engine to recover from temporary database locks or network blips during a large batch of payouts.
- **Batch Isolation**: Each batch is processed independently, preventing cascading failures.

### Error Boundary Enforcement

- **No Raw Errors to Clients**: All client-facing errors use the `ErrorCode` enum from `lib/errors`.
- **Structured Logging**: Full error details are logged server-side with context (offeringId, runId, investorId, errorClass).
- **Request ID Propagation**: Error responses include `requestId` for traceability.

## Failure Handling

If an operation fails after all retry attempts, the engine:

1. **For Individual Payouts**: Records the failure in `failedPayouts` array with error classification
2. **For Distribution Run**: Throws a descriptive error (caller handles status update)
3. **Logs the Failure**: Structured log entry with all relevant context

The caller (e.g., a background job or API handler) is responsible for:
1. Logging the final failure.
2. Potentially marking the distribution run as `failed` or `partial` in the database.
3. Notifying administrators if manual intervention is required.
4. Retrying failed payouts via admin endpoint if needed.

## Structured Logging

The engine emits structured logs for observability:

### Events

- **Distribution batch started**: Logs offeringId, investorCount, batchSize
- **Payout creation failed**: Logs investorId, errorClass, batchNumber
- **Distribution batch completed**: Logs successful/failed counts, duration

### Example

```json
{
  "level": "INFO",
  "message": "Distribution batch completed",
  "offeringId": "off-1",
  "runId": "run-123",
  "successfulPayouts": 148,
  "failedPayouts": 2,
  "totalPayouts": 150,
  "duration": 3456
}
```

## Testing

The retry logic and batch processing are verified using deterministic unit tests that cover:

- Successful recovery after 1 or 2 failures.
- Final failure after exceeding `maxRetries`.
- Validation of all input constraints.
- Verification of rounding logic and proration accuracy.
- **NEW**: Batch processing with large investor sets (150+).
- **NEW**: Partial batch failure handling.
- **NEW**: Error classification without raw message leakage.
- **NEW**: Backward compatibility with original `distribute()` method.

## Migration Guide

If you're currently using `distribute()`, **no changes are required**. The method is fully backward compatible.

To leverage new batch features:

1. Call `distributeWithBatch()` instead of `distribute()`
2. Handle `failedPayouts` in your application logic
3. Monitor structured logs for batch operations
4. Configure `batchSize` in `DistributionEngineOptions` if needed

## See Also

- [Payout Batching Edge Cases](./payout-batching-edge-cases.md) - Detailed documentation on batching
- [Stellar RPC Failure Classification](./stellar-rpc-failure-classification.md) - Error classification details
- [Structured Error Mapping](./structured-error-mapping.md) - Error handling patterns
