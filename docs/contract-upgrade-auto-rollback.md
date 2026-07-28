# Contract upgrade auto-rollback

## Overview

The contract upgrade orchestrator now watches post-upgrade health signals and can automatically mark an upgrade as failed when regressions exceed defined thresholds. This protects deployments from continuing after a suspected bad promotion.

## Trigger conditions

Auto-rollback is only attempted when all of the following are true:

- the upgrade is still in the `applied` state;
- an already-approved rollback plan exists;
- the revert rate meets or exceeds `0.1`;
- the failed reconciliation count meets or exceeds `10`.

## Security assumptions

- The rollback path is intentionally gated by an already-approved rollback plan to avoid unauthorized or accidental rollbacks.
- The service only transitions upgrades from `applied` to `failed` once, preventing repeated rollback events for the same upgrade.
- The rollback decision emits an audit event with the rollback plan identifier, the health-signal payload, and the cause string so post-incident review remains deterministic.

## Audit behavior

The orchestrator emits the `upgrade.autorollback.triggered` audit event when an auto-rollback is triggered. This event is designed to be consumed by paging and alerting pipelines.

## Failure handling

If the health signal is below threshold, or the rollback plan is not approved, no rollback is triggered. The service remains idempotent and does not oscillate rollback decisions for already-failed upgrades.
