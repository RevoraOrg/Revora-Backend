# Payout Batching Edge Cases

This document describes the payout batching implementation in the DistributionEngine, including edge case handling, security assumptions, and failure recovery strategies.

## Overview

The `DistributionEngine` now supports **batch processing** for large payout distributions, preventing database overload and enabling graceful handling of partial failures during revenue distribution.

## Batch Processing Algorithm

### Configuration

```typescript
interface DistributionEngineOptions {
  maxRetries?: number;          // Default: 3
  initialDelayMs?: number;      // Default: 500
  backoffFactor?: number;       // Default: 2
  logRetries?: boolean;         // Default: false
  batchSize?: number;           // Default: 50 (NEW)
}
```

### Processing Flow

1. **Validation Phase**
   - Validate `offeringId`, `revenueAmount`, and `period`
   - Acquire investor balances with retry logic
   - Compute prorated shares with rounding adjustment

2. **Distribution Run Creation**
   - Create distribution run record with status `processing`
   - Retry on transient failures (up to `maxRetries`)

3. **Batch Payout Processing**
   - Split payouts into batches of `batchSize` (default: 50)
   - Process each batch sequentially
   - Track successful and failed payouts independently
   - Continue processing subsequent batches even if one batch fails

4. **Result Aggregation**
   - Return `DistributionBatchResult` with:
     - `successfulPayouts`: Array of successfully created payouts
     - `failedPayouts`: Array of failed payouts with error classification
     - `totalPayouts`: Total number of payouts attempted

## Edge Cases Handled

### 1. Large Investor Sets

**Scenario:** Distribution to 150+ investors

**Solution:** 
- Process in batches of 50 (configurable)
- Prevents connection pool exhaustion
- Reduces memory footprint per transaction

**Test Coverage:** `distributionEngine.test.ts` → "processes large investor sets in batches"

### 2. Partial Batch Failures

**Scenario:** Database transient failure affects specific payouts within a batch

**Solution:**
- Each payout has independent retry logic
- Failed payouts are tracked with error classification
- Successful payouts are persisted
- Distribution run remains valid

**Test Coverage:** `distributionEngine.test.ts` → "handles partial batch failures gracefully"

### 3. Single Investor Distribution

**Scenario:** Only one investor in the offering

**Solution:**
- Batch size of 1 works correctly
- No special handling required
- Full validation and rounding logic applies

**Test Coverage:** `distributionEngine.test.ts` → "processes single investor distribution (batch size = 1)"

### 4. Rounding Precision

**Scenario:** Very small or very large revenue amounts

**Solution:**
- Round to 2 decimal places (cents)
- Adjust largest share to absorb rounding difference
- Ensure sum of payouts equals `revenueAmount` exactly

**Test Coverage:**
- "handles very small revenue amounts with rounding"
- "handles very large revenue amounts without precision loss"

### 5. Complete Batch Failure

**Scenario:** Entire batch fails (e.g., database connection lost)

**Solution:**
- Catch batch-level errors
- Log failure with error classification
- Continue processing next batch
- Return partial results to caller

**Test Coverage:** `distributionEngine.test.ts` → "continues processing next batch after batch failure"

## Security Assumptions

### Input Validation

- **revenueAmount**: Must be > 0 and ≤ 10^15 (prevent overflow)
- **offeringId**: Must be non-empty string
- **period.start/end**: Valid ISO-8601 dates, end > start
- **totalBalance**: Must be > 0 (prevent division by zero)

### Error Boundary Enforcement

1. **No Raw Error Messages to Clients**
   - All errors are classified using `classifyStellarRPCFailure()`
   - Client-facing responses use `ErrorCode` enum values
   - Full error details logged server-side only

2. **Error Classification**
   ```typescript
   enum StellarRPCFailureClass {
     TIMEOUT = 'TIMEOUT',
     RATE_LIMIT = 'RATE_LIMIT',
     UPSTREAM_ERROR = 'UPSTREAM_ERROR',
     MALFORMED_RESPONSE = 'MALFORMED_RESPONSE',
     UNAUTHORIZED = 'UNAUTHORIZED',
     UNKNOWN = 'UNKNOWN',
   }
   ```

3. **Structured Error Responses**
   ```typescript
   // Client receives:
   {
     code: 'INTERNAL_ERROR',
     message: 'Internal server error',
     requestId: 'req-123'
   }

   // Server logs:
   {
     level: 'ERROR',
     message: 'Payout creation failed',
     offeringId: 'off-1',
     investorId: 'i-1',
     errorClass: 'UPSTREAM_ERROR',
     fullError: 'Detailed error message...'
   }
   ```

### Authorization

- Only `admin` or offering owner (`startup`) can trigger distributions
- Ownership verified via `offeringRepo.getById()`
- Investor role explicitly denied (403 Forbidden)

## Failure Modes and Recovery

### Transient Failures

**Examples:** Database lock, network timeout, rate limit

**Recovery:**
- Automatic retry with exponential backoff
- Configurable `maxRetries` (default: 3)
- Delay = `initialDelayMs * (backoffFactor ^ (attempt - 1))`

### Persistent Failures

**Examples:** Database down, invalid schema, permission denied

**Recovery:**
- Fail specific payout after exhausting retries
- Track in `failedPayouts` array
- Continue processing remaining payouts
- Caller responsible for:
  - Logging final failure
  - Marking distribution run as `failed` or `partial`
  - Notifying administrators

### Partial Distribution Completion

**Scenario:** 80 of 100 payouts succeed

**State:**
- Distribution run: `processing` (should be updated to `partial` by caller)
- 80 payouts: `pending` status in database
- 20 payouts: tracked in `failedPayouts` array

**Manual Recovery:**
1. Review failed payouts in logs
2. Fix underlying issue (e.g., database connection)
3. Manually retry failed payouts via admin endpoint
4. Update distribution run status to `completed`

## Performance Characteristics

### Time Complexity

- **Balance Acquisition:** O(n) where n = number of investors
- **Share Computation:** O(n)
- **Payout Persistence:** O(n / batchSize) batches × O(batchSize) payouts per batch
- **Overall:** O(n) with constant factor based on `batchSize`

### Space Complexity

- **Memory:** O(n) for storing payout results
- **Database:** O(n) for payout records

### Benchmarks (Expected)

| Investors | Batch Size | Est. Time | DB Connections |
|-----------|------------|-----------|----------------|
| 50        | 50         | ~500ms    | 1-2            |
| 150       | 50         | ~1500ms   | 1-2            |
| 500       | 50         | ~5000ms   | 1-2            |
| 1000      | 100        | ~8000ms   | 1-2            |

*Note: Times are estimates and depend on database performance, network latency, and retry behavior.*

## Structured Logging

### Events Logged

1. **Distribution Batch Started**
   ```json
   {
     "level": "INFO",
     "message": "Distribution batch started",
     "offeringId": "off-1",
     "runId": "run-123",
     "period": { "start": "...", "end": "..." },
     "revenueAmount": 10000,
     "investorCount": 150,
     "batchSize": 50
   }
   ```

2. **Payout Creation Failed**
   ```json
   {
     "level": "ERROR",
     "message": "Payout creation failed",
     "offeringId": "off-1",
     "runId": "run-123",
     "investorId": "i-42",
     "errorClass": "UPSTREAM_ERROR",
     "batchNumber": 2
   }
   ```

3. **Distribution Batch Completed**
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

### Test Coverage

- **distributionEngine.ts:** ≥95%
- **distributions.ts (routes):** ≥95%
- **distributionsRoute.ts:** ≥95% (maintained)

### Test Categories

1. **Unit Tests:** `src/services/distributionEngine.test.ts`
   - Batch size limits
   - Partial failures
   - Rounding precision
   - Retry strategy
   - Error classification

2. **Route Tests:** `src/routes/distributions.test.ts`
   - Validation edge cases
   - Authorization scenarios
   - Error handling
   - Response format

3. **Integration Tests:** (optional) `src/__tests__/distributions-e2e.test.ts`
   - End-to-end happy path
   - Multi-investor distribution

## Backward Compatibility

The original `distribute()` method is preserved for backward compatibility:

```typescript
// Old interface (still works)
const result = await engine.distribute(offeringId, period, revenueAmount);
console.log(result.payouts); // Array of successful payouts

// New interface (recommended)
const batchResult = await engine.distributeWithBatch(offeringId, period, revenueAmount);
console.log(batchResult.successfulPayouts);
console.log(batchResult.failedPayouts);
console.log(batchResult.totalPayouts);
```

## Migration Guide

If you're currently using `distribute()`, no changes are required. To leverage batch processing features:

1. Update to use `distributeWithBatch()` for detailed results
2. Configure `batchSize` in `DistributionEngineOptions`
3. Handle `failedPayouts` in your application logic
4. Monitor structured logs for batch operations

## See Also

- [Distribution Engine Retry Strategy](./distribution-engine-retry-strategy.md)
- [Stellar RPC Failure Classification](./stellar-rpc-failure-classification.md)
- [Structured Error Mapping](./structured-error-mapping.md)
