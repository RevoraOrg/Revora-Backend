# Payout Reconciliation Runbook

**Owner:** Backend Platform Team (on-call: #revora-backend)  
**Severity Rubric:** See [Severity Definitions](#severity-rubric)  
**Last Updated:** 2026-06-24

---

## Table of Contents

1. [Overview](#overview)
2. [Severity Rubric](#severity-rubric)
3. [Automated Drift Detection](#automated-drift-detection)
4. [Triage Steps](#triage-steps)
5. [Missing Payments](#missing-payments)
6. [Duplicated Payments](#duplicated-payments)
7. [Under-funded / Over-funded Payments](#under-funded--over-funded-payments)
8. [Asset Issuer Changes Mid-Period](#asset-issuer-changes-mid-period)
9. [Partial Fills](#partial-fills)
10. [Replay Procedure](#replay-procedure)
11. [Metrics and Alarms](#metrics-and-alarms)
12. [Postmortems](#postmortems)
13. [Related Code](#related-code)

---

## Overview

The Distribution Engine records payouts in the `distribution_payouts` table and submits corresponding payment transactions to the Stellar network. This runbook describes how operators reconcile those off-chain records against on-chain Stellar payment history, triage discrepancies, and replay failed or missing payments.

**Sources of truth:**
- **Off-chain:** `distribution_payouts` table (status, amount, tx_hash)
- **On-chain:** Stellar Horizon / Soroban RPC transaction history
- **Drift reports:** `payout_drift_reports` table (nightly automated snapshots)

---

## Severity Rubric

| Severity | Criteria | Response Time | Example |
|----------|----------|--------------|---------|
| **CRITICAL** | Drift > $10,000 or > 10% of total distribution amount; duplicate payment confirmed on-chain | 15 min | Double-payment of $50k to investor |
| **HIGH** | Drift $1,000–$10,000; missing tx_hash on processed payouts > 24h old; duplicate tx_hash detected | 1 hour | 50 payouts marked processed without Stellar submission |
| **MEDIUM** | Drift $100–$1,000; under-funded payment < 1% of expected; reconciliation alarm older than 24h | 4 hours | Single payout missing $200 due to rounding |
| **LOW** | Drift < $100; isolated missing tx_hash < 1h old; cosmetic issues in drift report | Next business day | Stale drift report from previous night |

---

## Automated Drift Detection

The **PayoutDriftDetector** runs nightly (every 24 hours) and:

1. Queries all `distribution_payouts` with `status = 'processed'`
2. Checks for:
   - **Missing tx_hash:** payouts marked processed but lacking a Stellar transaction hash
   - **Duplicate tx_hash:** multiple payouts sharing the same hash (potential double-credit)
   - **On-chain verification:** for payouts with tx_hash, queries Stellar Horizon to confirm amount matches
3. Persists results to `payout_drift_reports`
4. Emits Prometheus metrics (see [Metrics and Alarms](#metrics-and-alarms))

**Alarm:** `payout_drift_alarm` gauge = 1 when any non-zero drift is older than 24 hours. This should trigger a pager notification.

---

## Triage Steps

When an alarm fires or a drift report shows discrepancies:

1. **Acknowledge the alarm** in the on-call rotation.
2. **Open the latest drift report:**
   ```sql
   SELECT * FROM payout_drift_reports
   ORDER BY run_at DESC LIMIT 1;
   ```
3. **Check the `details` JSONB column** for individual drift entries with their `drift_type` classifications.
4. **Determine severity** using the [Severity Rubric](#severity-rubric).
5. **Follow the appropriate section below** for the drift type.

---

## Missing Payments

**Symptom:** `missing_count > 0` in drift report; payouts exist in DB with `status = 'processed'` but `tx_hash IS NULL`.

**Causes:**
- DistributionEngine crash after marking payout processed but before submitting to Stellar
- Stellar RPC timeout that was classified as retryable but retry exhausted
- Bug in the submission pipeline

**Triage:**

1. Identify affected payouts:
   ```sql
   SELECT dp.*, d.offering_id
   FROM distribution_payouts dp
   JOIN distributions d ON d.id = dp.distribution_id
   WHERE dp.status = 'processed' AND dp.tx_hash IS NULL
   ORDER BY dp.created_at ASC;
   ```
2. Check the age of the oldest missing payout — if > 24h, escalate to HIGH/CRITICAL.
3. Verify the investor's Stellar account has not already received the payment by checking the Stellar account history (via Horizon).
4. If the payment was **never sent**, follow the [Replay Procedure](#replay-procedure).
5. If the payment **was sent** but tx_hash was not recorded, update the payout row manually:
   ```sql
   UPDATE distribution_payouts
   SET tx_hash = '<tx_hash>', updated_at = NOW()
   WHERE id = '<payout_id>';
   ```

---

## Duplicated Payments

**Symptom:** `duplicate_tx_count > 0`; multiple payouts share the same `tx_hash`.

**Causes:**
- Idempotency key collision
- Replay of a distribution run that was partially completed
- Bug in batch processing creating duplicate payout rows

**Triage:**

1. Identify the duplicated tx_hash:
   ```sql
   SELECT tx_hash, COUNT(*), ARRAY_AGG(id) AS payout_ids
   FROM distribution_payouts
   WHERE tx_hash IS NOT NULL AND status = 'processed'
   GROUP BY tx_hash
   HAVING COUNT(*) > 1;
   ```
2. Compare the amounts and investor_ids for each duplicate — are they identical or different?
3. **If amounts and investors differ:** One payout is legitimate, the other is erroneous. Determine which is correct by cross-referencing the Stellar transaction:
   - Use Horizon to fetch the actual payment operations for that tx_hash
   - The on-chain operations are the ground truth
4. **Mark the erroneous payout** as `failed`:
   ```sql
   UPDATE distribution_payouts
   SET status = 'failed', updated_at = NOW()
   WHERE id = '<erroneous_payout_id>';
   ```
5. **If amounts are identical and investor matches:** This is likely an idempotent retry that created a duplicate row. Delete or mark the extra row as `failed`.

---

## Under-funded / Over-funded Payments

**Symptom:** `underfunded_count` or `overfunded_count > 0`; on-chain amount differs from DB amount.

**Causes:**
- Stellar transaction fee deducted from payment amount
- Rounding discrepancy in the proration logic
- Manual intervention on Stellar (someone edited the trust line or sent a different amount)

**Triage:**

1. Check the drift details:
   ```sql
   SELECT details FROM payout_drift_reports
   WHERE offering_id = '<offering_id>'
   ORDER BY run_at DESC LIMIT 1;
   ```
2. Extract the specific payout ID and verify on-chain via Horizon.
3. **If under-funded by < tolerance (0.01):** Likely a rounding artifact — no action needed.
4. **If under-funded by > tolerance:** Submit a supplemental payment for the difference via the DistributionEngine's replay mechanism (see [Replay Procedure](#replay-procedure)).
5. **If over-funded:** Reconcile by recording the surplus — this may need compliance/legal review before action.

---

## Asset Issuer Changes Mid-Period

**Scenario:** The Stellar asset issuer changes the asset's issuer account during a distribution period.

**Impact:** Existing payouts with `tx_hash` referencing the old issuer are still valid, but new submissions must use the new issuer account.

**Triage:**

1. Identify affected payouts where the `tx_hash` asset issuer differs from the current issuer:
   ```sql
   SELECT dp.*
   FROM distribution_payouts dp
   JOIN distributions d ON d.id = dp.distribution_id
   WHERE dp.status IN ('pending', 'failed')
     AND d.offering_id = '<offering_id>';
   ```
2. Update the distribution configuration with the new issuer details in the `offerings` table or env config.
3. **Do NOT replay** payouts that were already processed under the old issuer — those are settled.
4. For pending/failed payouts, submit them using the new issuer via the standard replay procedure.
5. Update the drift report to note the issuer change in the `details` JSONB field.

---

## Partial Fills

**Scenario:** A Stellar payment operation partially filled (e.g., path payment with slippage).

**Impact:** The on-chain amount differs from the expected payout amount. This is distinct from under-funding — partial fills are expected in certain market conditions.

**Triage:**

1. Verify the partial fill by checking the Stellar operation's `amount` and `source_amount`:
   ```bash
   curl -s "https://horizon-testnet.stellar.org/transactions/<tx_hash>/operations"
   ```
2. Compare the `amount` received by the destination with the expected payout amount.
3. **If difference is within slippage tolerance (configurable, default 1%):** Log and accept — this is normal path payment behavior.
4. **If difference exceeds slippage tolerance:**
   - Check if the path expired or the liquidity pool dried up
   - Re-submit with a more conservative slippage setting
   - Record the residual as a new payout for the difference
5. Update the payout record with the actual on-chain amount:
   ```sql
   UPDATE distribution_payouts
   SET amount = '<actual_onchain_amount>', updated_at = NOW()
   WHERE id = '<payout_id>';
   ```

---

## Replay Procedure

Use this procedure when payouts need to be re-submitted to Stellar:

### Prerequisites
- You have identified the specific payouts to replay (see triage sections above)
- The Stellar account has sufficient funds (XLM for fees + asset for payments)
- The offering is still active or you have override permissions

### Steps

1. **Verify the payout has not already been settled on-chain:**
   ```bash
   curl -s "https://horizon-testnet.stellar.org/accounts/<investor_stellar_address>/payments?limit=1"
   ```
   Cross-reference the amount and memo.

2. **If on-chain does not show the payment, proceed with replay.**

3. **Reset the payout status to `pending`:**
   ```sql
   UPDATE distribution_payouts
   SET status = 'pending', tx_hash = NULL, updated_at = NOW()
   WHERE id = '<payout_id>';
   ```

4. **Trigger the DistributionEngine for the relevant offering + period:**
   - Via API (if exposed): `POST /api/v1/distributions/replay` with `{ offering_id, period_id }`
   - Via direct service call: invoke `DistributionEngine.distribute(offeringId, period, revenueAmount)`

5. **If the DistributionEngine idempotency check blocks the replay** (because it finds an existing run), you may need to clear or update the existing run:
   ```sql
   UPDATE distributions
   SET status = 'pending', updated_at = NOW()
   WHERE offering_id = '<offering_id>' AND period_id = '<period_id>';
   ```

6. **Monitor the replay:**
   ```sql
   SELECT status, successful_payouts, failed_payouts
   FROM distributions
   WHERE offering_id = '<offering_id>' AND period_id = '<period_id>';
   ```

7. **Run a manual drift check** after replay to confirm resolution:
   ```sql
   SELECT * FROM payout_drift_reports
   WHERE offering_id = '<offering_id>'
   ORDER BY run_at DESC LIMIT 1;
   ```

8. **Clear the alarm** if drift is resolved (next automated run will clear the gauge).

---

## Metrics and Alarms

### Metrics emitted by PayoutDriftDetector

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `payout_drift_missing_total` | Counter | `offering_id` | Processed payouts without tx_hash |
| `payout_drift_underfunded_total` | Counter | `offering_id` | On-chain amount < DB amount |
| `payout_drift_overfunded_total` | Counter | `offering_id` | On-chain amount > DB amount |
| `payout_drift_duplicate_tx_total` | Counter | `offering_id` | Payouts sharing same tx_hash |
| `payout_drift_alarm` | Gauge | `offering_id` | 1 if non-zero drift > 24h old, else 0 |
| `payout_drift_oldest_age_hours` | Gauge | `offering_id` | Age of oldest unresolved drift (hours) |
| `payout_drift_run_duration_ms` | Histogram | `status` | Duration of drift detection run |

### Pager Alarm Wiring

The `payout_drift_alarm` gauge is set to `1` when:
- Any drift type count > 0 AND
- `oldest_drift_age_hours > 24`

Configure your monitoring system (PagerDuty / Opsgenie) to trigger on:
```
payout_drift_alarm{offering_id!=""} > 0
```
Recommended evaluation interval: 5 minutes, with a 5-minute trigger window to avoid flapping.

### Automated Resolution

The alarm auto-clears when the next nightly run detects zero drift. No manual intervention is required for transient issues that self-resolve.

---

## Postmortems

Any incident triaged above as **CRITICAL** (or otherwise labeled `SEV-1` on its
tracking PR/issue) requires a written postmortem before the fix is merged.

- **Template:** [`docs/postmortems/_template.md`](../postmortems/_template.md)
- **File naming:** `docs/postmortems/pr-<PR_NUMBER>.md` or
  `docs/postmortems/pr-<PR_NUMBER>-<slug>.md`
- **Required sections:** timeline, blast radius, total decimals (monetary drift)
  affected, and at least one "what would have prevented this" action item.
- **Enforcement:** `.github/workflows/postmortem-required.yml` fails the PR's
  status check if it carries the `SEV-1` label and no matching postmortem file
  is present among its changed files; removing the label skips the check.

---

## Related Code

| File | Purpose |
|------|---------|
| `src/services/payoutDriftDetector.ts` | Nightly drift detection scheduled job |
| `src/db/repositories/payoutDriftRepository.ts` | DB access for drift reports and payout queries |
| `src/db/migrations/015_create_payout_drift_reports.sql` | Schema for drift report persistence |
| `src/services/distributionEngine.ts` | Core distribution logic |
| `src/services/reconciliationScheduler.ts` | Existing revenue reconciliation scheduler |
| `src/lib/stellarTransactionVerifier.ts` | On-chain transaction verification |
| `src/lib/metrics.ts` | Metrics collector |
