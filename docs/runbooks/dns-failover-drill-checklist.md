# DNS Failover & TTL Drill Checklist

**Owner:** Backend Platform / SRE Team  
**Schedule:** Quarterly Game-Day Drill (Q1, Q2, Q3, Q4)  
**Target RTO:** 15 minutes (DNS propagation lag target: <= 120 seconds)  
**Target RPO:** 5 minutes  
**Last Updated:** 2026-07-29  

---

## 1. Overview & Security Assumptions

This checklist governs the quarterly DNS failover drill and TTL shortening procedure for Revora multi-region architecture (`us-east-1` primary, `eu-west-1` secondary).

### Security & Correctness Assumptions
- **Pre-Drill Shortening:** Baseline Route53 TTL (300s) must be pre-shortened to **60s** at least 24 hours prior to scheduled failover drills to ensure active client caching expires quickly.
- **Idempotency:** Drill verification scripts (`scripts/failover-drill/ttl-check.ts`) are read-only and safe to re-run repeatedly without mutating infrastructure state.
- **Partial Propagation Guard:** Traffic migration MUST NOT proceed if DNS resolution exhibits partial propagation across public resolvers. Allow 2x TTL window (120s) before executing DB promotion or cutting live application traffic.
- **Health-Check Policy:** DNS cutover must only occur if target region `/health` endpoint probes return HTTP `200 OK` with valid JSON payload.

---

## 2. Expected Propagation Window

| Metric | Target / Window | Operational Requirement |
|---|---|---|
| **Baseline TTL** | 300 seconds (5 min) | Normal operation caching |
| **Shortened Drill TTL** | 60 seconds (1 min) | Applied 24h prior to game day |
| **Expected Propagation Window** | 120 seconds (2x TTL) | Maximum allowed lag for 100% resolver convergence |
| **Resolver Coverage Target** | 100% (5/5 public resolvers) | Google (8.8.8.8, 8.8.4.4), Cloudflare (1.1.1.1), Quad9 (9.9.9.9), OpenDNS (208.67.222.222) |
| **Health Probe Timeout** | <= 5000 ms | Probe must complete within 5s per endpoint |

---

## 3. Quarterly Calendar Wiring & Schedule

| Quarter | Drill Window | Target Region Pair | Trigger & Lead |
|---|---|---|---|
| **Q1 Drill** | Last Thursday of January | `us-east-1` -> `eu-west-1` | Platform Lead / On-Call |
| **Q2 Drill** | Last Thursday of April | `eu-west-1` -> `us-east-1` | SRE Lead / On-Call |
| **Q3 Drill** | Last Thursday of July | `us-east-1` -> `eu-west-1` | Platform Lead / On-Call |
| **Q4 Drill** | Last Thursday of October | `eu-west-1` -> `us-east-1` | SRE Lead / On-Call |

---

## 4. Execution Checklist

### Phase 1: Pre-Drill Validation (T-24 Hours)
- [ ] **Shorten DNS TTL:** Update Route53 record TTL for `api.revora.io` from 300s to 60s.
- [ ] **Verify TTL Shortening:**
  ```bash
  npx ts-node scripts/failover-drill/ttl-check.ts --domain api.revora.io --expected-ip <PRIMARY_IP> --target-ttl 60
  ```
- [ ] **Confirm Health Probes:** Verify `/health` endpoints in both primary and secondary regions return HTTP 200.

### Phase 2: Game-Day Failover Drill Execution (T-0)
- [ ] **Simulate Primary Outage / Initiate Cutover:** Point Route53 failover record to secondary region ALB IP.
- [ ] **Run Automated Propagation & Health Verification:**
  ```bash
  npx ts-node scripts/failover-drill/ttl-check.ts --domain api.revora.io --expected-ip <SECONDARY_IP> --target-ttl 60 --json
  ```
- [ ] **Evaluate Propagation Status:**
  - If **`COMPLETE`** (100% resolvers updated & health probes pass): Proceed with replica promotion and traffic migration.
  - If **`PARTIAL`**: Hold traffic cut. Wait up to 120 seconds for full resolver convergence and re-run check.
  - If **`FAILED`**: Abort drill and investigate Route53 change status or resolver issues.

### Phase 3: Post-Drill Recovery & Restoration
- [ ] **Restore Route53 Primary Record:** Point `api.revora.io` back to primary region.
- [ ] **Reset Baseline TTL:** Restore Route53 TTL to 300 seconds.
- [ ] **Record Outcome:** Append drill outcome row to `docs/runbooks/drill-log-multi-region-failover.csv`.
