<!--
  Reconciliation postmortem template.

  File naming convention (enforced by .github/workflows/postmortem-required.yml):
    docs/postmortems/pr-<PR_NUMBER>.md
    docs/postmortems/pr-<PR_NUMBER>-<short-slug>.md

  Any pull request labeled SEV-1 must add a file matching this pattern before
  it can be merged. Copy this template, fill in every section, and do not
  delete sections that don't apply -- write "N/A" with a one-line reason
  instead, so reviewers can tell "not applicable" from "forgotten".
-->

# Postmortem: <short incident title>

- **PR:** #<pr-number>
- **Severity:** SEV-1
- **Incident start:** <YYYY-MM-DD HH:MM UTC>
- **Incident end / mitigated:** <YYYY-MM-DD HH:MM UTC>
- **Author(s):** <name(s)>
- **Status:** Draft | Final

## Summary

Two to three sentences: what broke, who/what was affected, how it was resolved.

## Timeline

All times in UTC.

| Time | Event |
|------|-------|
| <HH:MM> | <e.g. payout_drift_alarm fired for offering X> |
| <HH:MM> | <detection / escalation / mitigation / resolution steps> |

## Blast Radius

- **Offerings affected:** <ids / "none">
- **Investors affected:** <count / "none">
- **Payouts affected:** <count, and status: missing / duplicated / under- or over-funded>
- **Systems affected:** <e.g. Distribution Engine, Stellar submission, reconciliation scheduler>

## Decimals Affected (Total)

State the total monetary drift this incident caused, summed across every affected
payout/offering, in the format `<amount> <asset code>` per asset. This number is
the headline severity metric referenced in the [payout reconciliation runbook's
severity rubric](../runbooks/payout-reconciliation.md#severity-rubric) and must
reconcile against the relevant `payout_drift_reports` rows.

- **Total decimals affected:** <e.g. 12,430.50 USDC>
- **Breakdown by offering/asset:**
  | Offering | Asset | Amount | Drift type |
  |----------|-------|--------|------------|
  | <id>     | <code>| <amt>  | missing / duplicate / under-funded / over-funded |

## Root Cause

What actually caused this, at the level of the specific code path, race condition,
or operational action. Avoid stopping at "the alarm fired" -- trace it back.

## Detection

How was this found? (automated alarm, drift report, investor report, manual audit)
If detection was slower than it should have been, say so and by how much.

## Resolution

What was done to stop the bleeding and repair the data (replays, manual `UPDATE`s,
supplemental payments, etc.), with links to the specific triage steps in the
[payout reconciliation runbook](../runbooks/payout-reconciliation.md) that were followed.

## What Would Have Prevented This

- <bulleted list of concrete, actionable changes -- code, alarms, process --
  that would have stopped this incident before it happened or shortened its
  blast radius. At least one bullet is required.>

## Action Items

| Owner | Action | Due date | Status |
|-------|--------|----------|--------|
| <name> | <concrete follow-up> | <YYYY-MM-DD> | Open |
