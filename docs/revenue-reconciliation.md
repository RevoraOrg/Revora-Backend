# Revenue Reconciliation: Drift Detection + Alerts

## Overview
The Revenue Reconciliation Service provides deterministic validation of revenue distribution integrity by comparing internal database records with on-chain state (Stellar/Soroban).

## Key Features
- **Drift Detection**: Detects discrepancies between the local database's total distributed amount and the on-chain total distributed amount.
- **Structured Logging**: All reconciliation results and discrepancies are logged with structured context for production monitoring.
- **Alerts**: Discrepancies exceeding defined tolerances are logged at `ERROR` or `CRITICAL` levels to trigger monitoring alerts.
- **Security-First Error Handling**: RPC failures are classified using `classifyStellarRPCFailure` to ensure safe, client-facing error messages without leaking internal system details.

## Reconciliation Logic
1. **Local Check**: Sums up all `RevenueReport` entries and compares them with `DistributionRun` totals in the local database.
2. **On-Chain Check**: Queries the Soroban contract for the `total_distributed` state.
3. **Drift Calculation**: Calculates the absolute difference (drift) between local and on-chain totals.
4. **Validation**: Checks for:
    - Revenue mismatches (Reported vs. Paid).
    - Investor allocation integrity.
    - Rounding loss adjustments.
    - Distribution status validity.

## Security Assumptions
- **Trust Boundary**: The Stellar RPC/Horizon API is considered an external system. All responses are classified to ensure no raw upstream error strings cross the API boundary.
- **Source of Truth**: The blockchain is the final source of truth for "actual" payouts. Drift indicates a synchronization issue or potential unauthorized activity.
- **Deterministic Validation**: The reconciliation process is idempotent and deterministic for a given set of inputs.

## Risk Note
- **High Drift**: Significant drift (e.g., > 10x tolerance) is treated as a `CRITICAL` discrepancy, potentially indicating a severe data integrity issue or double-spending on-chain.
- **RPC Availability**: Reconciliation depends on Stellar RPC availability. Timeouts or rate limits are handled gracefully but will result in a `RPC_ERROR` warning in the reconciliation result.
