# Incident Response Playbook — Alert-to-Runbook Mapping

Every alert name below maps to its runbook, owner, and expected first response.
New alerts MUST be added to this table before their PR merges (validated by CI).

## Mapping Table

| Alert Name | Description | Runbook | Owner | First Response |
|---|---|---|---|---|
| `HighErrorRate` | HTTP 5xx rate exceeds 1% over 5 min | [`METRICS_NEXT_STEPS.md`](../METRICS_NEXT_STEPS.md) | Backend Platform | Check recent deploys; inspect error logs; rollback if needed |
| `HighLatency` | P95 latency exceeds 2 s over 5 min | [`METRICS_NEXT_STEPS.md`](../METRICS_NEXT_STEPS.md) | Backend Platform | Check DB query times; review CPU/memory; scale horizontally |
| `DatabasePoolExhausted` | DB waiting connections > 0 for 1 min | [`METRICS_NEXT_STEPS.md`](../METRICS_NEXT_STEPS.md) | Backend Platform | Check `pg_stat_activity` for stuck queries; increase pool size; kill idle tx |
| `MemoryUsageHigh` | Heap usage > 85 % for 10 min | [`METRICS_NEXT_STEPS.md`](../METRICS_NEXT_STEPS.md) | Backend Platform | Inspect heap dump; look for leaks in recent changes; restart if critical |
| `OutboxSaturationCritical` | Outbox dispatcher lag reaches critical severity | [`outbox-lag-saturation-alerts.md`](../outbox-lag-saturation-alerts.md) | Backend Platform | Verify outbox consumer is running; check DB load; review webhook endpoint health |
| `payout_drift_alarm` | Non-zero payout drift > 24 h unresolved | [`payout-reconciliation.md`](payout-reconciliation.md) | Backend Platform | Inspect `payout_drift_reports`; compare on-chain vs DB amounts; replay missing tx |
| `payout_drift_missing_total` | Processed payouts without tx_hash | [`payout-reconciliation.md`](payout-reconciliation.md) | Backend Platform | Query `payout_drift_reports WHERE type = 'missing'`; retry Stellar submission |
| `payout_drift_underfunded_total` | On-chain amount < DB amount | [`payout-reconciliation.md`](payout-reconciliation.md) | Backend Platform | Review Stellar tx history; reconcile fee deductions; escalate if systemic |
| `payout_drift_overfunded_total` | On-chain amount > DB amount | [`payout-reconciliation.md`](payout-reconciliation.md) | Backend Platform | Confirm no duplicate submissions; file correction tx if needed |
| `payout_drift_duplicate_tx_total` | Multiple payouts share same tx_hash | [`payout-reconciliation.md`](payout-reconciliation.md) | Backend Platform | Deduplicate records; update `payout_drift_reports`; notify compliance |
| `oidc_discovery_changed` | OIDC discovery document content changed | [`oidc-discovery-digest-alert.md`](../oidc-discovery-digest-alert.md) | Auth Team | Verify IdP endpoint changes are expected; diff previous vs new document; acknowledge |
| `fx_provider_health_score` (degraded/demoted) | FX provider health score drops below threshold | [`fx-provider-health-scoring.md`](../fx-provider-health-scoring.md) | Backend Platform | Check provider latency/error rate; failover to secondary provider if demoted |
| `provider_demoted` | FX provider automatically demoted | [`fx-provider-health-scoring.md`](../fx-provider-health-scoring.md) | Backend Platform | Verify secondary provider is healthy; investigate root cause; re-promote after fix |
| `provider_degraded` | FX provider health score degraded | [`fx-provider-health-scoring.md`](../fx-provider-health-scoring.md) | Backend Platform | Monitor provider recovery; no immediate action unless persists > 15 min |
| `outbox_saturation_alerts` | Outbox pending records exceed saturation threshold | [`outbox-lag-saturation-alerts.md`](../outbox-lag-saturation-alerts.md) | Backend Platform | Scale outbox consumer; verify downstream webhook endpoints; clear backpressure |
| `migration_failed` | Database migration failed during deploy | [`payout-reconciliation.md`](payout-reconciliation.md) | Backend Platform | Check migration logs; rollback migration; notify team before retrying |
| `migration_rolled_back` | Migration auto-rolled back after failure | [`payout-reconciliation.md`](payout-reconciliation.md) | Backend Platform | Verify schema is at previous version; investigate failure cause |
| `MultiRegionFailover` | Active region health probe failed; failover triggered | [`multi-region-failover.md`](multi-region-failover.md) | Backend Platform | Confirm secondary region is serving; check DNS propagation; page secondary on-call |
| `contract_upgrade_auto_rollback` | Contract upgrade auto-rolled back | [`contract-upgrade-slsa-attestation.md`](../contract-upgrade-slsa-attestation.md) | Smart Contract Team | Verify on-chain state; re-run upgrade with fix; attest new deployment |
| `email_alarm_alignment_failure` | DKIM/SPF/DMARC alignment check failed for outbound email | [`emailDeliverabilityService.ts`](../../src/services/emailDeliverabilityService.ts) | Backend Platform | Inspect SES bounce complaint feed; update DNS records; re-send after fix |
| `email_alarm_high_bounce_ratio` | Bounce rate exceeds threshold over 1 h window | [`emailDeliverabilityService.ts`](../../src/services/emailDeliverabilityService.ts) | Backend Platform | Review recipient list quality; pause sends; warm up new sending domain |
| `CertPinningMismatch` | Mobile client TLS handshake errors due to cert pin mismatch | [`mobile-cert-pinning.md`](mobile-cert-pinning.md) | Backend Platform | Check vault `revora/mobile/cert-pins/current`; verify server cert fingerprint; execute Phase 0–3 rotation or emergency unpin |
| `DbPoolWaitersHigh` | DB pool waiters > 0 for 1 min (pool is the bottleneck) | [`../autoscaling-db-pool-signal.md`](../autoscaling-db-pool-signal.md) | Backend Platform | Confirm autoscaler scaled out; check `pg_stat_activity` for stuck queries; kill idle tx |
| `DbPoolUtilizationHigh` | DB pool utilization > 70% for 5 min | [`../autoscaling-db-pool-signal.md`](../autoscaling-db-pool-signal.md) | Backend Platform | Verify HPA scaled out; if utilization > 90% or waiters climb, check long-running tx and DB `max_connections` |

## Runbook Index

| Runbook | Path | Covers |
|---|---|---|
| Payout Reconciliation | [`payout-reconciliation.md`](payout-reconciliation.md) | `payout_drift_*` alerts |
| Multi-Region Failover | [`multi-region-failover.md`](multi-region-failover.md) | `MultiRegionFailover` |
| Outbox Saturation | [`../outbox-lag-saturation-alerts.md`](../outbox-lag-saturation-alerts.md) | `OutboxSaturationCritical`, `outbox_saturation_alerts` |
| OIDC Discovery Change | [`../oidc-discovery-digest-alert.md`](../oidc-discovery-digest-alert.md) | `oidc_discovery_changed` |
| FX Provider Health | [`../fx-provider-health-scoring.md`](../fx-provider-health-scoring.md) | `fx_provider_health_score`, `provider_demoted`, `provider_degraded` |
| Metrics & Alerting | [`../METRICS_NEXT_STEPS.md`](../METRICS_NEXT_STEPS.md) | `HighErrorRate`, `HighLatency`, `DatabasePoolExhausted`, `MemoryUsageHigh` |
| Mobile Cert Pinning | [`mobile-cert-pinning.md`](mobile-cert-pinning.md) | `CertPinningMismatch` |
| Contract Upgrade | [`../contract-upgrade-slsa-attestation.md`](../contract-upgrade-slsa-attestation.md) | `contract_upgrade_auto_rollback` |
| DB Pool Autoscaling | [`../autoscaling-db-pool-signal.md`](../autoscaling-db-pool-signal.md) | `DbPoolWaitersHigh`, `DbPoolUtilizationHigh` |

## Adding a New Alert

1. Add a row to the **Mapping Table** above.
2. Ensure the associated runbook exists or link to an existing one.
3. Run `npx ts-node scripts/validate-alert-mappings.ts` locally to confirm the mapping passes CI.
4. The CI gate `npm run validate:alert-mappings` will fail if any alert referenced in code is missing from the table.

## CI Validation

The script `scripts/validate-alert-mappings.ts` scans the codebase for alert references
(metric counters, Prometheus alert rules, structured log alert calls) and ensures every
one appears in the mapping table. The CI workflow runs this check on every PR.
