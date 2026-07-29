# Multi-Region Failover Runbook

**Owner:** Backend Platform Team (on-call: #revora-backend)  
**RTO Target:** 15 minutes  
**RPO Target:** 5 minutes  
**Last Updated:** 2026-06-27

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Region Topology](#region-topology)
3. [Failure Detection](#failure-detection)
4. [DNS Cut Procedure](#dns-cut-procedure)
5. [Replica Promotion](#replica-promotion)
6. [Idempotency-Store Warm-Up](#idempotency-store-warm-up)
7. [Traffic Drain](#traffic-drain)
8. [Rollback Path](#rollback-path)
9. [Contact Rotation](#contact-rotation)
10. [Quarterly Game-Day Drill Checklist](#quarterly-game-day-drill-checklist)
11. [Drill Outcome Tracking](#drill-outcome-tracking)
12. [Related Code](#related-code)

---

## Architecture Overview

The Revora backend runs across two AWS regions (primary and secondary) with:

- **Compute:** Express application behind an ALB/NLB in each region.
- **Database:** PostgreSQL primary in the primary region; streaming replica in the secondary region.
- **DNS:** Route53 latency-based or failover routing pointing at the active region's load balancer.
- **Idempotency store:** In-memory or Redis-backed cache for webhook delivery idempotency keys.
- **Stellar Horizon:** Each region maintains its own connection pool to Stellar.

```
  Users
    |
  Route53 (failover)
    |
  +-----------+-----------+
  |                       |
  [ALB: us-east-1]        [ALB: eu-west-1]
  |                       |
  Express                 Express
  |                       |
  PostgreSQL (primary) <- Streaming replica
  |                       |
  Redis (idempotency)     Redis (cold)
```

---

## Region Topology

| Designation | Region | DNS Name | DB Role |
|-------------|--------|----------|---------|
| Primary     | us-east-1 | `api.revora.io` (active) | Read/Write |
| Secondary   | eu-west-1 | `api-eu.revora.io` (standby) | Read-only replica |

The Route53 record `api.revora.io` uses a failover routing policy. Under normal operations traffic flows to the primary region.

---

## Failure Detection

### Automated Signals

| Signal | Source | Threshold | Action |
|--------|--------|-----------|--------|
| DB health probe fails | `/health` endpoint | 3 consecutive failures in 30s | Page on-call |
| ALB 5xx rate > 5% | CloudWatch | 5-min window | Page on-call |
| Replica lag > 30s | `pg_stat_replication` | Sustained 60s | Alert (no page) |
| Route53 health check failure | Route53 | 2 consecutive failures | Automatic DNS cut |

### Manual Verification

Before declaring a region-level outage, confirm via:

```bash
# 1. Check primary DB health
curl -sf https://api.revora.io/health | jq .status

# 2. Check secondary replica health
curl -sf https://api-eu.revora.io/health | jq .status

# 3. Verify replica lag on secondary
psql $DATABASE_URL_SECONDARY -c "
  SELECT pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(),
         pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) AS lag_bytes;
"
```

---

## DNS Cut Procedure

**RTO contribution:** ~2 minutes  
**Risk:** Partial propagation during TTL window

### Steps

1. **Verify secondary is ready to accept traffic:**
   ```bash
   ./scripts/drill-multi-region-failover.sh --check-replica
   ```

2. **Update Route53 failover record:**
   ```bash
   aws route53 change-resource-record-sets \
     --hosted-zone-id ZONE_ID \
     --change-batch '{
       "Changes": [{
         "Action": "UPSERT",
         "ResourceRecordSet": {
           "Name": "api.revora.io",
           "Type": "A",
           "SetIdentifier": "secondary",
           "Failover": "PRIMARY",
           "FailoverRoutingConfig": {
             "Primary": false,
             "Secondary": true
           },
           "AliasTarget": {
             "HostedZoneId": "SECONDARY_ALB_ZONE",
             "DNSName": "SECONDARY_ALB_DNS",
             "EvaluateTargetHealth": true
           }
         }
       }]
     }'
   ```

3. **Wait for DNS propagation:**
   ```bash
   # Check from multiple locations
   dig api.revora.io @8.8.8.8 +short
   dig api.revora.io @1.1.1.1 +short
   ```
   Allow 2x the record TTL (typically 60s TTL → wait 120s).

4. **Verify traffic reaches secondary:**
   ```bash
   curl -sf https://api.revora.io/health | jq .status
   ```

5. **Log the cutover:**
   ```bash
   echo "FAILOVER $(date -u +%Y-%m-%dT%H:%M:%SZ) primary=us-east-1 secondary=eu-west-1" >> docs/runbooks/drill-log-multi-region-failover.csv
   ```

---

## Replica Promotion

**RTO contribution:** ~5 minutes  
**Risk:** Data loss within RPO window (up to 5 min)

### Prerequisites

- Confirm primary is truly unavailable (not a network partition that resolves itself).
- Capture the last consistent LSN from the replica for RPO measurement.

### Steps

1. **Stop replication on the secondary:**
   ```bash
   psql $DATABASE_URL_SECONDARY -c "SELECT pg_promote();"
   ```
   This converts the read-only replica into a standalone read/write primary.

2. **Verify promotion:**
   ```bash
   psql $DATABASE_URL_SECONDARY -c "SELECT pg_is_in_recovery();"
   # Must return 'f' (false) — not in recovery mode
   ```

3. **Update application configuration:**
   - Set `DATABASE_URL` in the secondary region's environment to point to the newly promoted primary.
   - Deploy the config change or trigger a secret rotation if using a secret manager.

4. **Record RPO:**
   ```bash
   # Check if any transactions were lost by comparing WAL positions
   psql $DATABASE_URL_SECONDARY -c "
     SELECT now() - pg_postmaster_start_time() AS uptime;
   "
   ```

5. **Validate write capability:**
   ```bash
   curl -sf -X POST https://api.revora.io/health/startup | jq .
   ```

### Stale Replica Promotion (Edge Case)

If the replica is significantly behind (e.g., hours due to a network issue):

1. **Assess RPO impact:** Determine if the lag represents acceptable data loss.
2. **If lag is acceptable:** Proceed with promotion despite the gap — the `idempotency-store warm-up` will catch duplicate deliveries.
3. **If lag is NOT acceptable:** 
   - Option A: Wait for replica to catch up (if primary is expected to return soon).
   - Option B: Restore from the latest WAL archive backup and replay to the latest safe point.
   - Option C: Accept the stale promotion and reconcile after failover using payout drift detection.

**Security note:** A stale replica may serve outdated idempotency keys. The warm-up procedure in the next section is designed to detect and purge stale entries.

---

## Idempotency-Store Warm-Up

**RTO contribution:** ~3 minutes  
**Risk:** Duplicate webhook deliveries if idempotency keys are stale

The idempotency store (Redis or in-memory map) in the secondary region starts cold. Warm it up to prevent duplicate webhook processing.

### Steps

1. **Seed from the database:**
   ```sql
   SELECT idempotency_key, created_at
   FROM webhook_deliveries
   WHERE created_at > NOW() - INTERVAL '24 hours'
   ORDER BY created_at DESC;
   ```

2. **Load into the idempotency cache:**
   ```bash
   ./scripts/drill-multi-region-failover.sh --warm-idempotency
   ```
   This loads the last 24 hours of idempotency keys into the cache.

3. **Verify coverage:**
   ```bash
   redis-cli -h $REDIS_HOST KEYS "idempotency:*" | wc -l
   # Should match the count from step 1
   ```

4. **Set a TTL on all warm-up entries:**
   ```redis
   # Each key should get TTL = 24h - age_of_key
   # So older keys expire sooner
   ```
   This prevents stale keys from accumulating after the warm-up.

### Partial DNS Propagation (Edge Case)

During DNS propagation, some clients may still hit the old primary region while others reach the new secondary. Idempotency keys may be written to either store. The warm-up procedure must handle this:

- The application should check both the local cache and the database for idempotency keys.
- After full propagation (2x TTL), the reverse-proxy in the old region should return 503 to drain remaining connections.

---

## Traffic Drain

**RTO contribution:** ~2 minutes  
**Risk:** In-flight requests are lost or duplicated

1. **Drain the primary ALB:**
   ```bash
   aws elbv2 modify-target-group-attributes \
     --target-group-arn PRIMARY_TARGET_GROUP \
     --attributes Key=deregistration_delay.timeout_seconds,Value=30
   ```

2. **Monitor in-flight requests drain to zero:**
   ```bash
   aws elbv2 describe-target-health \
     --target-group-arn PRIMARY_TARGET_GROUP \
     --query 'TargetHealthDescriptions[].TargetHealth.State'
   ```

3. **After drain is complete:** Stop the primary application processes to prevent split-brain writes.
   ```bash
   ssh primary-host "systemctl stop revora-backend"
   ```

---

## Rollback Path

If the secondary region fails or the primary region recovers within the RTO window:

### Rollback Triggers

| Condition | Action |
|-----------|--------|
| Secondary health checks fail within 5 min of cutover | Roll back immediately |
| Primary region is confirmed operational within RTO window | Roll back |
| Data inconsistency detected during warm-up | Roll back and investigate |

### Steps

1. **Reverse the DNS cut:**
   ```bash
   aws route53 change-resource-record-sets \
     --hosted-zone-id ZONE_ID \
     --change-batch '{
       "Changes": [{
         "Action": "UPSERT",
         "ResourceRecordSet": {
           "Name": "api.revora.io",
           "Type": "A",
           "SetIdentifier": "primary",
           "Failover": "PRIMARY",
           "AliasTarget": {
             "HostedZoneId": "PRIMARY_ALB_ZONE",
             "DNSName": "PRIMARY_ALB_DNS",
             "EvaluateTargetHealth": true
           }
         }
       }]
     }'
   ```

2. **Restore the original primary database (no re-promotion needed if it was never corrupted):**
   - Verify the primary is healthy: `curl -sf https://api.revora.io/health/startup`
   - If the primary was corrupted, restore from the latest WAL archive backup.

3. **Point the secondary back as a replica:**
   ```bash
   # On the secondary, re-initiate streaming replication
   psql $DATABASE_URL_SECONDARY -c "
     SELECT pg_create_physical_replication_slot('secondary');
   "
   # Then restart PostgreSQL with primary_conninfo pointing back to the primary
   ```

4. **Re-run the health verification:**
   ```bash
   ./scripts/drill-multi-region-failover.sh --all
   ```

---

## Contact Rotation

On-call schedule for region-failover decisions:

| Role | Responsibility | Primary | Secondary |
|------|---------------|---------|-----------|
| Incident Commander | Declares failover, approves DNS cut | Platform Lead | Backend Lead |
| DB Operator | Executes replica promotion | DB Admin (pg) | Backend Lead |
| Network Operator | Executes DNS cut | DevOps/SRE | Platform Lead |
| Communications | Notifies stakeholders | PM | Engineering Manager |

**Escalation:** If the primary contact does not respond within 5 minutes, escalate to the secondary contact.

---

## Quarterly Game-Day Drill Checklist

Each quarter, run a full failover drill and check off each step.

### Pre-Drill

- [ ] Schedule the drill with stakeholders 2 weeks in advance.
- [ ] Verify the drill environment is isolated from production traffic (use a staging or mirrored region pair).
- [ ] Confirm the secondary region has a recent snapshot of production data.
- [ ] Review the RTO/RPO targets: `RTO=15m`, `RPO=5m`.
- [ ] Ensure all on-call contacts are available during the drill window.

### Drill Execution

1. **Simulate primary outage:**
   - [ ] Stop the primary region application: `ssh primary-host "systemctl stop revora-backend"`
   - [ ] Stop the primary database: `ssh primary-db "systemctl stop postgresql"`

2. **Verify detection:**
   - [ ] Confirm `/health` returns 503 for the primary region.
   - [ ] Confirm the secondary replica lag is within acceptable bounds.

3. **Execute failover:**
   - [ ] Run DNS cut procedure (Section 3).
   - [ ] Promote replica to primary (Section 4).
   - [ ] Warm up idempotency store (Section 5).

4. **Verify secondary:**
   - [ ] `/health` returns 200 on `api.revora.io`.
   - [ ] Write a test record to the promoted DB.
   - [ ] Verify idempotency cache coverage > 99% of recent keys.

5. **Measure:**
   - [ ] Record total failover time (target: < 15 min).
   - [ ] Record RPO (data loss window, target: < 5 min).

6. **Rollback:**
   - [ ] Restore primary region services.
   - [ ] Reverse DNS cut.
   - [ ] Re-establish replication.
   - [ ] Verify full health on primary.

### Post-Drill

- [ ] Log the drill outcome to `docs/runbooks/drill-log-multi-region-failover.csv`.
- [ ] File a post-mortem if any target was missed.
- [ ] Update this runbook with any procedural improvements discovered.

---

## Drill Outcome Tracking

Drill outcomes are logged to `docs/runbooks/drill-log-multi-region-failover.csv`.

| Date | Tester | RTO (min) | RPO (min) | Pass/Fail | Notes |
|------|--------|-----------|-----------|-----------|-------|

Each row records the date, the engineer who drove the drill, the measured RTO and RPO, whether the drill passed both targets, and any notes or follow-up actions.

---

## Related Code

| File | Purpose |
|------|---------|
| `src/db/client.ts` | Database connection pool and health check |
| `src/routes/health.ts` | Health endpoints used for failover detection |
| `src/config/env.ts` | Environment configuration including `DATABASE_URL` |
| `src/middleware/idempotency.ts` | Idempotency middleware that keys off request hashes |
| `scripts/drill-multi-region-failover.sh` | Automated drill script for failover verification |
| `scripts/failover-drill/ttl-check.ts` | Automated DNS TTL policy, propagation lag, and health-check verification script |
| `docs/runbooks/dns-failover-drill-checklist.md` | DNS failover drill checklist, expected propagation windows, and quarterly calendar |
