# Distribution Engine Retry Strategy

This document outlines the retry strategy and security hardening implemented in the `DistributionEngine` service.

## Overview

The `DistributionEngine` is responsible for computing and persisting revenue distributions and individual payouts. Because these operations involve multiple database transactions and potentially external balance providers, it is critical to handle transient failures gracefully.

## Retry Mechanism

The engine implements an **Exponential Backoff Retry Strategy** for all critical I/O operations:

1.  **Balance Acquisition**: Retries if the balance provider or offering repository fails to return investor balances.
2.  **Distribution Run Creation**: Retries the initial persistence of the distribution run record.
3.  **Individual Payout Creation**: Each payout is persisted with its own retry cycle, ensuring that a transient failure for one investor doesn't necessarily block the entire process immediately, although the engine will eventually throw if a payout cannot be persisted after all attempts.

### Configuration

The strategy can be configured via `DistributionEngineOptions`:

- `maxRetries` (default: 3): Total number of attempts for each operation.
- `initialDelayMs` (default: 500): Initial delay before the first retry.
- `backoffFactor` (default: 2): Multiplier for the delay after each subsequent failure.
- `logRetries` (default: false): Whether to log retry attempts to the console.

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

## Failure Handling

If an operation fails after all retry attempts, the engine throws a descriptive error. The caller (e.g., a background job or API handler) is responsible for:
1. Logging the final failure.
2. Potentially marking the distribution run as `failed` in the database.
3. Notifying administrators if manual intervention is required.

## Testing

The retry logic is verified using deterministic unit tests that mock transient failures:
- Successful recovery after 1 or 2 failures.
- Final failure after exceeding `maxRetries`.
- Validation of all input constraints.
- Verification of rounding logic and proration accuracy.
