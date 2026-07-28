# Vesting Partial Claim Tracking

## Overview

This document describes the tracking mechanism for partial claims in vesting schedules to ensure mathematical integrity and prevent balance inconsistencies.

## Partial-Claim Cursor/Ledger

The partial-claim cursor maintains the state of claimed amounts in the vesting schedule. It acts as a ledger that records each partial draw, ensuring:

- No double-claiming of vested tokens
- Accurate calculation of remaining vested amounts
- Prevention of "dust loss" that could mimic rug pull vectors

### Cursor Implementation

- **Cumulative Claimed Amount**: Tracks the total amount claimed so far
- **Last Claim Index**: Points to the last processed vesting event
- **Validation Rules**:
  - Claims cannot exceed available vested amount
  - Claims must be sequential (no gaps)
  - Rollback on failure preserves cursor state

### Ledger Entries

Each partial claim creates a ledger entry with:
- Timestamp
- Claimed amount
- Remaining vested amount
- Transaction hash (for on-chain verification)

### Security Assumptions

- Cursor state is immutable once committed
- Failures result in explicit errors, not silent losses
- All claims are validated against the vesting schedule math

### Tests

All statements are backed by automated tests in `src/vesting_test.rs`:
- Cursor advancement on successful claims
- Rejection of invalid claim amounts
- Ledger consistency after rollbacks
- Edge cases: zero claims, full claims, overlapping claims

Test coverage: ≥95% for new paths.
