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

> **How this drill wires into the quarterly schedule:**
> The Revora SRE/Platform team maintains a shared team calendar (Google Calendar "Revora Reliability Drills").
> Quarterly drill windows are pre-booked as recurring events on the last Thursday of January/April/July/October,
> with a 72-hour pre-drill reminder that explicitly links to this runbook and requires the on-call lead to
> acknowledge T-24h TTL shortening action. A calendar invite automation (hosted in `.claude/scheduled_tasks.lock`)
> blocks off the 2-hour game-day window and assigns:
> 1. **Primary Operator** – executes steps and runs `ttl-check.ts`
> 2. **Secondary Observer** – records outcomes to the drill-log CSV and calls rollback if criteria are breached
> 3. **DB On-Call** – available for replica promotion decisions during live cutover
>
> In CI, the `.github/workflows/ci.yml` contract can be extended to smoke-test the drill script's
> idempotency and lint properties on every PR that touches `scripts/failover-drill/*`.

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
- [ ] **Expected Outcome (Pre-Drill):** propagationStatus = `COMPLETE` (all 5 resolvers report TTL <= 60s and correct primary IP). If status = `PARTIAL` or `FAILED`, pause drill schedule and investigate cache poisoning / NS issues before proceeding.
- [ ] **Confirm Health Probes:** Verify `/health` endpoints in both primary and secondary regions return HTTP 200.
- [ ] **Escalation Contacts:** Confirm DB and network on-call rotas are staffed for the drill window.

### Phase 2: Game-Day Failover Drill Execution (T-0)
- [ ] **Simulate Primary Outage / Initiate Cutover:** Point Route53 failover record to secondary region ALB IP.
- [ ] **Run Automated Propagation & Health Verification:**
  ```bash
  npx ts-node scripts/failover-drill/ttl-check.ts --domain api.revora.io --expected-ip <SECONDARY_IP> --target-ttl 60 --json
  ```
- [ ] **Evaluate Propagation Status:**
  - If **`COMPLETE`** (100% resolvers updated & health probes pass): Proceed with replica promotion and traffic migration.
  - If **`PARTIAL`** (distinct clearly-labeled state): **HOLD TRAFFIC CUT.** Wait up to 120 seconds for full resolver convergence and re-run check. If PARTIAL persists after 3 re-runs, escalate to Phase 4 abort criteria.
  - If **`FAILED`**: Abort drill and investigate Route53 change status or resolver issues.

### Phase 3: Post-Drill Recovery & Restoration
- [ ] **Restore Route53 Primary Record:** Point `api.revora.io` back to primary region.
- [ ] **Reset Baseline TTL:** Restore Route53 TTL to 300 seconds.
- [ ] **Restore Primary DB Writer:** Demote secondary replica back to streaming-standby mode.
- [ ] **Verify Full Recovery:** Re-run ttl-check against primary IP and confirm propagation = COMPLETE.
- [ ] **Record Outcome:** Append drill outcome row to `docs/runbooks/drill-log-multi-region-failover.csv`.

---

## 5. Rollback / Abort Criteria

**Abort the drill immediately and initiate rollback if ANY of the following are true:**

| # | Abort Criterion | Threshold / Trigger | Required Action |
|---|---|---|---|
| A1 | **TTL not shortened in time** | T-24h pre-check shows > 1 resolver still returning TTL > 60s (status = PARTIAL / FAILED) | Reschedule drill. Do NOT proceed to T-0 cutover. |
| A2 | **Partial propagation persists** | propagationStatus = `PARTIAL` across 3 consecutive script runs with >= 4 min interval between runs | Hold, do not cut traffic. Roll back Route53 record set to primary IP. |
| A3 | **Health probe failures** | Any target region `/health` endpoint returns non-200 status AFTER propagation reaches COMPLETE | Abort cutover. Investigate secondary app deployment or DB connectivity. Re-run health-only probes (`--health-url` only) until green. |
| A4 | **DNS propagation FAILED** | Zero public resolvers updated after 10 minutes (status = FAILED, 0 propagated) | Page network on-call. Revert Route53 change. Open postmortem entry in `docs/postmortems/` using `_template.md`. |
| A5 | **Secondary DB not ready** | Replica lag > 100 MB OR pg_is_in_recovery() != 't' on secondary at T-0 | Do not promote. Cancel drill window, reschedule with DB team. |
| A6 | **Business hours incident** | Any active SEV-2+ incident open against primary platform during drill window | Pause drill immediately. Resume at next available quarter window. |

### Rollback Sequence (when any abort criterion is met)
1. Revert Route53 A record weight / failover policy back to primary region ALB.
2. Confirm `ttl-check.ts` shows COMPLETE back to primary IP.
3. Leave short TTL (60s) in place for 1 additional hour post-rollback to catch straggler clients.
4. Restore baseline 300s TTL after final recovery confirmation.
5. File drill log entry with ABORTED status and reference the specific abort criterion (A1–A6).

---

## 6. Sign-Off & Audit Trail

- [ ] **Primary Operator signature:** _______________________  Date: ____________
- [ ] **Secondary Observer signature:** ____________________  Date: ____________
- [ ] **Drill Outcome:** ⬜ PASS (COMPLETE propagation, no aborts)  ⬜ ABORTED (see A1–A6)  ⬜ PARTIAL PASS with rollback
- [ ] **Drill log CSV updated:** `docs/runbooks/drill-log-multi-region-failover.csv`
- [ ] **Lessons learned captured:** Postmortem folder if applicable.

---

**Related Runbooks:**
- `docs/runbooks/multi-region-failover.md` — full multi-region topology and replica promotion steps
- `scripts/drill-multi-region-failover.sh` — companion shell drill for DB replica and idempotency checks
