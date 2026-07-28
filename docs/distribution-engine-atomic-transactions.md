# Distribution Engine Atomic Batch Transaction Support

## Overview

The Distribution Engine now supports atomic database transactions for batch payout persistence. This ensures that if a crash or failure occurs during batch processing, the system maintains a consistent ledger where batches either fully commit or fully roll back.

## Problem Statement

**Previous Behavior (Issue #330):**
- Payouts were created one row at a time via `distributionRepo.createPayout()`
- A partial failure left a `distribution_run` in 'failed' status with some payouts persisted and others not
- No surrounding database transaction meant a crash mid-batch produced an inconsistent ledger

**Solution:**
Wrap each batch in the existing database transaction helper (`withTransaction`) so a batch either fully commits or rolls back atomically.

## Implementation Details

### Changes to DistributionRepository

The `DistributionRepository` methods now accept an optional `client` parameter (a `PoolClient` from within a transaction):

```typescript
// Before
async createPayout(input: CreatePayoutInput): Promise<Payout>

// After  
async createPayout(input: CreatePayoutInput, client?: Queryable): Promise<Payout>
```

Similarly for `createDistributionRun` and `updateRunStatus`.

### Changes to DistributionEngine

The constructor now accepts an optional `pool: Pool` parameter:

```typescript
constructor(
  private offeringRepo: any,
  private distributionRepo: any,
  private balanceProvider?: BalanceProvider,
  options: DistributionEngineOptions = {},
  private pool?: Pool  // Optional transaction pool
)
```

**Batch Processing Flow:**

1. For each batch of payouts:
   - If pool is available: wrap batch in `withTransaction(pool, async (client) => { ... })`
   - Pass the `client` to repository methods
   - If any payout fails, transaction rolls back
   - If batch succeeds, transaction commits
   - Idempotent skip logic prevents re-creating already-persisted payouts

2. After all batches:
   - Update the final distribution run status to 'completed' or 'failed'

### Backward Compatibility

- If no pool is provided, the engine falls back to non-transactional batch processing
- Existing code without transaction support continues to work unchanged
- Field name corrected from `distribution_run_id` to `distribution_id` in all contexts

## Security Assumptions

1. **Transaction Isolation:** Uses PostgreSQL's default READ COMMITTED isolation level to prevent dirty reads while maintaining acceptable concurrency

2. **Atomicity Boundary:** The batch is the atomicity boundary, not individual payouts
   - Each batch either fully commits or fully rolls back
   - If a batch fails, the next resume automatically retries from the last failed batch

3. **Idempotency:** The resumption logic queries for existing payouts before processing, ensuring already-persisted investors are skipped
   - This prevents duplicate payouts after resume
   - Multiple calls with same parameters return the same run

4. **Error Classification:** Stellar RPC errors are classified to distinguish transient failures from permanent ones
   - Retries use exponential backoff
   - Logs are sanitized to prevent leaking sensitive data

## Test Coverage

Comprehensive tests verify:

1. **Successful Batch Commit**
   - Payouts are created within transaction
   - Transaction commits successfully
   - Final status updates to 'completed'

2. **Idempotency with Transactions**
   - Second call returns cached result
   - No duplicate payouts created
   - Same distribution run ID returned

3. **Resume After Partial Failure**
   - First batch fails on specific payout
   - Payout is rolled back (not persisted)
   - Resume completes remaining payouts
   - Final status updates to 'completed'

4. **Multiple Batch Processing**
   - Large investor sets processed across multiple batches
   - Each batch atomic
   - All batches complete successfully

5. **Field Name Correctness**
   - Uses `distribution_id` (not deprecated `distribution_run_id`)
   - Works correctly in transaction context

6. **Backward Compatibility**
   - Falls back gracefully when pool not provided
   - Non-transactional path still works
   - Existing tests pass unchanged

## Rollback Behavior

When a batch transaction fails:

1. All payouts created within that batch are rolled back
2. The distribution run remains in 'processing' status
3. The batch can be retried
4. Idempotent skip logic prevents re-persisting already-committed payouts

## Performance Considerations

- **Connection Pooling:** Uses existing database pool connection
- **Batch Size:** Configurable via `batchSize` option (default: 50)
- **Retry Strategy:** Exponential backoff on transient failures
- **Lock Duration:** Transactions are short-lived (seconds or less)

## Running Tests

```bash
# Run all distribution engine tests
npm test -- src/services/distributionEngine.test.ts

# Run with coverage
npm test -- src/services/distributionEngine.test.ts --coverage
```

Expected test output should show >95% coverage with new transaction tests passing.

## Future Enhancements

1. **Savepoint Support:** Nested transactions via savepoints for complex workflows
2. **Connection Timeout:** Add configurable timeouts for long-running batches
3. **Metrics:** Add Prometheus metrics for batch processing duration and rollback frequency
4. **Monitoring:** Log slow transactions and high rollback rates for alerting

## References

- [PostgreSQL Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [node-postgres (pg) Documentation](https://node-postgres.com/)
- [Database Transaction Helper](../src/db/transaction.ts)
- [Distribution Repository](../src/db/repositories/distributionRepository.ts)
