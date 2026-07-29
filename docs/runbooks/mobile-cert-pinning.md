# Mobile Companion API — Certificate Pinning Rotation Runbook

**Owner:** Backend Platform Team (on-call: #revora-backend)  
**Drill Cadence:** Quarterly  
**Last Updated:** 2026-07-28  
**Related Runbooks:**
- [`docs/runbooks/multi-region-failover.md`](multi-region-failover.md)
- [`docs/jwt-key-rotation.md`](../jwt-key-rotation.md)
- [`docs/kyc-webhook-dual-key.md`](../kyc-webhook-dual-key.md)
- [`docs/refresh-token-rotation.md`](../refresh-token-rotation.md)

> **Security note:** Actual pin hashes (SPKI SHA-256 fingerprints) and private key
> material are **never** stored in this repository. They live in the team's
> secrets vault (e.g., HashiCorp Vault or AWS Secrets Manager) under the path
> `revora/mobile/cert-pins/`. This runbook references vault paths and variable
> names only.

---

## Table of Contents

1. [Background and Risk](#background-and-risk)
2. [Architecture Overview](#architecture-overview)
3. [Pin Lifecycle and Vault Layout](#pin-lifecycle-and-vault-layout)
4. [When to Rotate](#when-to-rotate)
5. [Rotation Procedure — Step by Step](#rotation-procedure--step-by-step)
   - [Phase 0 — Pre-rotation prep](#phase-0--pre-rotation-prep)
   - [Phase 1 — Pin the new certificate in staging](#phase-1--pin-the-new-certificate-in-staging)
   - [Phase 2 — Phased production rollout](#phase-2--phased-production-rollout)
   - [Phase 3 — Old certificate decommission](#phase-3--old-certificate-decommission)
6. [Emergency Unpin Procedure](#emergency-unpin-procedure)
7. [Rollback Path](#rollback-path)
8. [Security Assumptions](#security-assumptions)
9. [Abuse and Failure Paths](#abuse-and-failure-paths)
10. [Quarterly Drill Checklist](#quarterly-drill-checklist)
11. [Drill Outcome Tracking](#drill-outcome-tracking)
12. [Related Code](#related-code)

---

## Background and Risk

Mobile clients (iOS and Android) enforce **TLS certificate pinning** against the
Revora companion API (`api.revora.io`). Pinning prevents MITM attacks by rejecting
TLS handshakes whose leaf or intermediate certificate does not match a known
SPKI SHA-256 fingerprint embedded in the app binary.

**The operational risk:** if the server certificate is rotated without first
updating the app's pin set, every mobile client on the old binary receives an
immediate hard TLS failure — no graceful degradation, no retry logic helps.
This is a **hard client outage** until users update the app.

This runbook documents the full rotation drill, including the dual-pin overlap
window, staged rollout, and the emergency unpin escape hatch.

---

## Architecture Overview

```
  Mobile App (iOS / Android)
      │
      │  TLS handshake
      │  ├── server cert SPKI  ──► compare against pinned set [pin_current, pin_next?]
      │  └── reject if no match (hard failure — no network request sent)
      │
  CDN / Load Balancer (terminates TLS)
      │
  api.revora.io  ──►  Express backend
```

**Pin set in the app binary contains up to two fingerprints:**

| Slot | Variable (vault) | Purpose |
|------|-----------------|---------|
| `pin_current` | `revora/mobile/cert-pins/current` | Active server certificate |
| `pin_next` | `revora/mobile/cert-pins/next` | Pre-published future certificate |

The `pin_next` slot allows a shipped app version to already trust the incoming
certificate before the server switches to it. This is the only way to rotate
without a forced-update hard outage.

---

## Pin Lifecycle and Vault Layout

```
Vault path                            Contents
─────────────────────────────────────────────────────────────────────
revora/mobile/cert-pins/current       SPKI SHA-256 of active cert
revora/mobile/cert-pins/next          SPKI SHA-256 of staged cert (blank when idle)
revora/mobile/cert-pins/previous      SPKI SHA-256 of last retired cert (kept 90 days)
revora/mobile/cert-pins/expiry        ISO-8601 expiry date of current cert
revora/mobile/cert-pins/rotation-log  Append-only history (date, engineer, action)
```

> **Access control:** Only the Secrets Rotation role in CI/CD and the on-call
> Platform Lead may write to `revora/mobile/cert-pins/`. All other roles are
> read-only for the `current` slot, no access for `next`.

### Generating a new SPKI fingerprint

```bash
# From a PEM certificate file (cert.pem)
openssl x509 -in cert.pem -noout -pubkey \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -binary \
  | base64
```

Store the resulting base64 string in `revora/mobile/cert-pins/next` — never in
any file committed to VCS.

---

## When to Rotate

Rotation is required in any of these circumstances:

| Trigger | Lead Time Required | Priority |
|---------|-------------------|----------|
| Certificate expiry (standard renewal) | ≥ 60 days before expiry | Planned |
| CA distrust / CA revocation event | Immediate | Critical |
| Private key compromise suspected | Immediate | Critical |
| Infrastructure migration (new CDN/ALB) | ≥ 30 days before cut | Planned |
| Quarterly drill (no real rotation) | Scheduled in advance | Drill |

**Planned rotations must complete Phase 1 (staging pin) at least 30 days before
the old certificate is retired from the server**, to give sufficient time for
app store review cycles and user adoption of the new binary.

---

## Rotation Procedure — Step by Step

### Phase 0 — Pre-rotation prep

- [ ] Generate the new TLS certificate and private key in the secrets vault.
      Do **not** place the private key anywhere in the repository.
- [ ] Compute the new certificate's SPKI SHA-256 fingerprint (see command above).
- [ ] Write the fingerprint to vault path `revora/mobile/cert-pins/next`.
- [ ] Confirm the cert expiry date and record it at `revora/mobile/cert-pins/expiry`.
- [ ] Notify the mobile team lead and app release manager of the upcoming rotation.
- [ ] Open a tracking issue/card referencing this runbook and the target rotation date.
- [ ] Schedule the quarterly drill if this is a planned rotation (see [Drill Checklist](#quarterly-drill-checklist)).

**Checkpoint:** `revora/mobile/cert-pins/next` is populated; mobile team is notified.

---

### Phase 1 — Pin the new certificate in staging

**Goal:** Validate the new certificate and pin set work correctly before any
production traffic or app binary changes.

1. **Deploy the new certificate to the staging environment** (`api-staging.revora.io`).
   The staging TLS terminator should present the new leaf certificate.

2. **Update the staging mobile build** to include `pin_next` in its pinned set
   alongside `pin_current` (dual-pin):

   ```
   // iOS — NSURLSession / TrustKit config (pseudocode, do not commit real pins)
   pinnedSPKIHashAlgorithms: [TSKAlgorithmSha256],
   pinnedLeafPublicKeyHashes: [
     "<pin_current from vault>",
     "<pin_next from vault>"
   ]
   ```

3. **Run the pinning smoke test** against staging:

   ```bash
   # Verify staging cert fingerprint matches expected next pin
   STAGING_HOST="api-staging.revora.io"
   EXPECTED_PIN=$(vault kv get -field=next revora/mobile/cert-pins)

   ACTUAL_PIN=$(echo | openssl s_client -connect ${STAGING_HOST}:443 -servername ${STAGING_HOST} 2>/dev/null \
     | openssl x509 -noout -pubkey \
     | openssl pkey -pubin -outform DER \
     | openssl dgst -sha256 -binary \
     | base64)

   if [ "$ACTUAL_PIN" = "$EXPECTED_PIN" ]; then
     echo "PASS: staging pin matches next vault entry"
   else
     echo "FAIL: mismatch — halt rotation"
     exit 1
   fi
   ```

4. **Verify dual-pin TLS acceptance** with the staging mobile build. Confirm:
   - Requests succeed against staging (new cert, dual-pin build).
   - Requests succeed against production (old cert, dual-pin build).
   - A request with only the new pin (simulating post-rotation) succeeds against staging.

5. **Submit the dual-pin app build for app store review** (iOS) and staged
   rollout (Android). Note that app store review can take 24–72 hours.

**Checkpoint:** Staging is green; app store submissions are in review.

---

### Phase 2 — Phased production rollout

**Prerequisite:** The dual-pin app version has reached ≥ 70% of active users
before the server certificate is swapped on production. Monitor adoption via
app analytics.

1. **Monitor app version adoption:**

   ```
   Target adoption gates before server cert swap:
     Gate A: 50% of DAU on dual-pin version → proceed to canary
     Gate B: 70% of DAU on dual-pin version → proceed to full rollout
   ```

2. **Canary rollout (Gate A reached):**
   - Swap the certificate on **one** availability zone or 10% of traffic weight.
   - Monitor error rates on `/health` and `/api/v1/` for 30 minutes.
   - Watch for TLS handshake errors in CDN/ALB logs (5xx spike or connection resets).
   - If clean, proceed; if errors spike, execute [Rollback Path](#rollback-path).

3. **Full production rollout (Gate B reached, canary clean):**
   - Swap the certificate on all remaining traffic.
   - Verify production pin:

   ```bash
   PROD_HOST="api.revora.io"
   EXPECTED_PIN=$(vault kv get -field=next revora/mobile/cert-pins)

   ACTUAL_PIN=$(echo | openssl s_client -connect ${PROD_HOST}:443 -servername ${PROD_HOST} 2>/dev/null \
     | openssl x509 -noout -pubkey \
     | openssl pkey -pubin -outform DER \
     | openssl dgst -sha256 -binary \
     | base64)

   [ "$ACTUAL_PIN" = "$EXPECTED_PIN" ] && echo "PASS" || echo "FAIL — investigate immediately"
   ```

4. **Promote vault entries:**

   ```bash
   # Vault promotion (run via CI/CD secrets rotation role, not manually)
   OLD_CURRENT=$(vault kv get -field=current revora/mobile/cert-pins)
   NEW_CURRENT=$(vault kv get -field=next    revora/mobile/cert-pins)

   vault kv put revora/mobile/cert-pins \
     previous="$OLD_CURRENT" \
     current="$NEW_CURRENT"  \
     next=""

   # Append to rotation log
   vault kv patch revora/mobile/cert-pins \
     rotation-log="$(date -u +%Y-%m-%dT%H:%M:%SZ) promoted next→current by ${USER}"
   ```

5. **Update `docs/runbooks/drill-log-mobile-cert-pinning.csv`** with the rotation
   outcome (date, engineer, old cert expiry, new cert expiry, user adoption % at swap).

**Checkpoint:** Production serves new cert; vault `current` updated; `next` cleared.

---

### Phase 3 — Old certificate decommission

- [ ] Keep vault `previous` populated for **90 days** after swap as an audit trail.
- [ ] After 90 days: clear `revora/mobile/cert-pins/previous`.
- [ ] Revoke the old certificate at the CA if it was compromised (not for normal expiry).
- [ ] File a task to remove the old pin from any app builds still in the wild
      (this is typically handled automatically as old app versions age out, but
      confirm with the mobile team).

---

## Emergency Unpin Procedure

> Use this path only when a critical TLS failure is causing a hard client outage
> and there is no time to go through the staged rotation process.

**Trigger:** TLS handshake failures spike for mobile clients; `pin_current` no
longer matches the server certificate (e.g., due to an unplanned cert replacement
at the CDN layer).

### Steps

1. **Declare an incident** in #revora-incidents. Assign an Incident Commander.

2. **Assess cause:** Was this an unplanned cert replacement? Key compromise?
   CDN misconfiguration?

3. **Issue an emergency app update with pinning disabled or widened:**
   - iOS: Remove `pinnedLeafPublicKeyHashes` from TrustKit config; submit
     expedited App Store review (cite safety issue).
   - Android: Set `cleartextTrafficPermitted="false"` but remove the `<pin-set>`
     from `network_security_config.xml`; push via Play Store internal track → 
     staged rollout 100%.

4. **Simultaneously, restore a known-good certificate on the server** (use the
   cert whose SPKI is in `revora/mobile/cert-pins/current` or `previous`).

5. **Monitor:** Confirm TLS handshake errors drop to zero within 15 minutes of
   the server cert restore. Mobile traffic will recover as:
   - Existing sessions: fail until cert is restored (step 4).
   - Updated app users: recover after app update (step 3).

6. **After stabilisation:** Follow the full rotation procedure starting at Phase 0
   to re-establish a clean pin state.

7. **Post-incident:** File a post-mortem in `docs/postmortems/`. Cross-reference
   this runbook and the drill log.

---

## Rollback Path

| Trigger | Action |
|---------|--------|
| Canary error rate > 1% TLS failures within 30 min | Revert CDN/ALB cert to previous; check vault `previous` pin |
| Mobile API 5xx spike > 5% post-swap | Revert to old cert; page mobile team |
| App store review rejection blocks dual-pin release | Halt Phase 2; extend old cert validity via CA if needed |
| Vault write failure during promotion | Re-run vault promotion script; do not swap server cert until vault is consistent |

### Reverting the server certificate

```bash
# Retrieve old cert from secrets vault (not from repo)
vault kv get revora/mobile/cert-pins/previous
# Redeploy old cert to CDN/ALB via your infrastructure automation
# (Terraform, Pulumi, or CDN UI — procedure is environment-specific)
```

After reverting, verify:

```bash
ACTUAL_PIN=$(echo | openssl s_client -connect api.revora.io:443 -servername api.revora.io 2>/dev/null \
  | openssl x509 -noout -pubkey \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -binary \
  | base64)
echo "Reverted pin: $ACTUAL_PIN"
# Should match vault revora/mobile/cert-pins/previous
```

---

## Security Assumptions

1. **Pins are never committed to VCS.** SPKI fingerprints and private keys live
   exclusively in the secrets vault. This runbook contains only vault paths and
   placeholder references.

2. **Dual-pin overlap window is mandatory.** The server certificate must not be
   swapped on production until the dual-pin app version covers ≥ 70% of active
   users. Skipping this gate is the primary risk path to a hard client outage.

3. **TLS termination is at a known boundary.** The CDN/ALB that terminates TLS
   must not silently re-sign with a different cert (e.g., CDN SSL interception).
   Verify the chain of trust end-to-end with `openssl s_client` from outside the
   internal network.

4. **Vault access is audited.** All reads/writes to `revora/mobile/cert-pins/`
   must produce an audit log entry. The Secrets Rotation CI role must be the only
   writer in non-emergency conditions.

5. **Emergency unpin is a last resort.** Disabling pinning removes the MITM
   protection for the duration of the outage window. It must be accompanied by
   enhanced traffic monitoring (WAF anomaly mode, Stellar transaction rate
   alerting) during that window.

6. **Quarterly drills use isolated staging** environments. No production cert or
   vault entry is modified during a drill.

---

## Abuse and Failure Paths

| Scenario | Behaviour | Mitigation |
|----------|-----------|-----------|
| Attacker performs MITM during unpin window | No cert pinning → TLS still validates chain of trust (CA validation), HSTS in place | Use strict CA issuance (DigiCert/Let's Encrypt via ACME), monitor anomalous sessions |
| CDN silently re-issues cert without notifying team | Pin mismatch → hard mobile outage | Subscribe to CDN cert-change webhooks; run daily fingerprint health check |
| App store rejects dual-pin update | Rotation is blocked | Maintain a 60-day buffer before cert expiry to allow resubmission |
| Vault unavailable during rotation | Rotation halted until vault is restored | Rotation is not a latency-sensitive path; do not bypass vault to recover |
| Private key leaked via log or error response | Key compromise → immediate emergency rotation | Scan logs for private key patterns via DLP; never log TLS material |
| `pin_next` written with wrong fingerprint | Dual-pin build trusts wrong cert | Always run Phase 1 smoke test before app store submission |

---

## Quarterly Drill Checklist

The drill is a dry-run against the **staging** environment only. No production
cert or vault entry is modified.

### Scheduling

- [ ] Schedule the drill 2 weeks in advance with the mobile team and platform on-call.
- [ ] Confirm the staging environment has a recent snapshot of the active certificate config.
- [ ] Confirm the drill owner (see Contact Rotation in multi-region failover runbook).

### Pre-Drill

- [ ] Read vault `revora/mobile/cert-pins/current` and confirm it matches the
      current staging server certificate fingerprint.
- [ ] Confirm `revora/mobile/cert-pins/next` is empty (clean starting state).
- [ ] Confirm all participants have vault read access to `revora/mobile/cert-pins/`.

### Drill Execution

1. **Generate a throwaway staging certificate** (self-signed is acceptable for drill purposes):
   - [ ] Generate cert and compute SPKI fingerprint.
   - [ ] Write fingerprint to `revora/mobile/cert-pins/next` in the **staging** vault namespace only.

2. **Deploy new cert to staging TLS terminator:**
   - [ ] Run the staging cert swap via infrastructure automation.
   - [ ] Confirm staging presents the new cert: run Phase 1 smoke test script above.

3. **Verify dual-pin staging build:**
   - [ ] Build a staging mobile binary with both `pin_current` and `pin_next`.
   - [ ] Confirm requests succeed against staging (new cert) and prod-staging (old cert).
   - [ ] Confirm a single-pin-only build (old pin only) fails against staging — this validates the pin enforcement is active.

4. **Simulate adoption gate:**
   - [ ] Document simulated adoption percentage (no real app store release needed for drill).
   - [ ] Confirm Gate A (50%) and Gate B (70%) thresholds are documented and agreed.

5. **Execute simulated Phase 2 swap on staging:**
   - [ ] Swap staging cert (if not already done in step 2).
   - [ ] Run the vault promotion script in dry-run mode (print commands, do not apply to prod vault).

6. **Test emergency unpin path:**
   - [ ] Simulate a hard outage: point staging TLS to a cert whose pin is NOT in the app.
   - [ ] Confirm mobile client receives a hard TLS failure (expected).
   - [ ] Execute emergency unpin steps 3–5 (app config change + server cert restore).
   - [ ] Confirm traffic recovers within 15 minutes.

7. **Verify rollback:**
   - [ ] Revert staging to original cert.
   - [ ] Confirm staging fingerprint matches `revora/mobile/cert-pins/current`.

### Post-Drill

- [ ] Log the drill outcome to `docs/runbooks/drill-log-mobile-cert-pinning.csv`.
- [ ] File a post-mortem if any step failed or exceeded its time target.
- [ ] Clear `revora/mobile/cert-pins/next` (staging vault namespace) after the drill.
- [ ] Update this runbook with any procedural improvements discovered.
- [ ] Schedule the next quarterly drill (≈ 13 weeks from current drill date).

---

## Drill Outcome Tracking

Drill outcomes are appended to `docs/runbooks/drill-log-mobile-cert-pinning.csv`.

| Date | Drill Owner | Environment | Phase Reached | Emergency Unpin Tested | Pass/Fail | Notes |
|------|-------------|-------------|---------------|------------------------|-----------|-------|

Each row records the date, the engineer who drove the drill, the environment
used, the highest phase completed, whether the emergency unpin path was tested,
whether the drill passed all gates, and any follow-up actions.

---

## Related Code

| File | Purpose |
|------|---------|
| `src/routes/health.ts` | Health endpoint used to verify API availability post-rotation |
| `src/config/env.ts` | Environment configuration including TLS-adjacent settings |
| `src/middleware/auth.ts` | Auth middleware — token flow that mobile clients exercise over pinned TLS |
| `docs/runbooks/drill-log-mobile-cert-pinning.csv` | Drill outcome log |
| `docs/jwt-key-rotation.md` | JWT secret rotation (companion to this runbook) |
| `docs/kyc-webhook-dual-key.md` | Dual-key pattern used for zero-downtime secret rotation |
| `docs/refresh-token-rotation.md` | Token lifecycle — depends on this runbook's TLS guarantees |
