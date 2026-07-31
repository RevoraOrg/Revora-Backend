# Social Account Linking — Proof-of-Possession Challenge and Anomaly Detection

Implements the "wave 7" hardening for Google/Apple account linking: a social
identity may **never** be linked to an existing Revora account on trust-on-first-
use email match alone. Linking requires a proof-of-possession (PoP) challenge,
and a suspicious "same social `sub`, many candidate accounts" pattern emits an
alert that feeds the AML workflow.

## Security model

### 1. Proof-of-possession before linking

`SocialAuthService.linkProvider()` requires:

- a valid session for the target account (`requireAuth` middleware), **and**
- the account's current password (`currentPassword` in the request body), **and**
- `confirm: true` in the request body.

The password re-entry is the proof-of-possession: possession of the account's
credentials, not merely possession of a provider ID token, is what authorises a
link. Without it, an attacker who has obtained a Google/Apple token could
otherwise replay it against any account whose email matches the token's email.

Order of operations in `linkProvider()`:

1. **Verify the ID token first** (`verifyVerifiedEmail`) so every subsequent
   step — including step-up failures — can be attributed to the trusted
   `sub` claim.
2. Verify the current password (step-up).
3. Reject if the social identity is already linked to another account, or the
   provider email belongs to another password account.
4. Create the `social_identities` row (guarded by `UNIQUE (provider, provider_subject)`).

### 2. Anomaly detector — social identity spraying

`SocialLinkAnomalyDetector` (`src/auth/social/socialLinkAnomalyDetector.ts`)
detects when **one** verified `(provider, provider_subject)` is attempted
against **many distinct candidate accounts** within a sliding window.

| Setting            | Default | Meaning                                                        |
|--------------------|---------|----------------------------------------------------------------|
| `threshold`        | `5`     | Distinct candidate accounts that trigger an alert              |
| `windowMs`         | `24h`   | Sliding window over which candidates are counted               |
| `cooldownMs`       | `1h`    | Minimum gap between alerts for the same identity               |

Each link attempt is recorded with its outcome
(`link_success` / `step_up_failed` / `identity_conflict` / `email_conflict`).
Repeated attempts against the **same** account count once, so legitimate
fat-fingering never triggers; only a spray across distinct accounts does.

When the threshold is crossed the detector:

1. increments the `social_link_anomaly_total` counter (label: `provider` only —
   no PII),
2. logs a high-severity `ALARM: social account-linking anomaly detected`,
3. records a `SECURITY_VIOLATION` audit event (`social_link_anomaly_detected`,
   outcome `BLOCKED`) with the candidate account IDs in `details`,
4. feeds the configurable `SocialLinkAnomalyAmlSink` (default:
   `AuditLogAmlSink`; a production deployment can supply a sink that creates an
   `aml_alerts` row or opens a compliance case).

**Failure isolation:** detection is best-effort. Store, audit, metric and AML
sink failures are caught so a detector problem can never break an otherwise
valid link flow.

## Files

| File | Purpose |
|------|---------|
| `src/auth/social/socialLinkAnomalyDetector.ts` | Detector + `SocialLinkAnomalyAmlSink` + default `AuditLogAmlSink` |
| `src/auth/social/socialLinkAttemptStore.ts` | Attempt-store interface + in-memory + PostgreSQL implementations |
| `src/db/migrations/025_create_social_link_attempts.sql` | `social_link_attempts` table |
| `src/auth/social/socialAuthService.ts` | `linkProvider()` — PoP step-up + attempt recording |
| `src/auth/social/socialAuthRoute.ts` | `confirm: true` + `currentPassword` required on `/link` |

## Persistence

Migration `025_create_social_link_attempts.sql` creates `social_link_attempts`:

| Column            | Notes |
|-------------------|-------|
| `provider`        | `google` \| `apple` |
| `provider_subject`| Verified `sub` claim |
| `user_id`         | Candidate account |
| `outcome`         | `link_success` \| `step_up_failed` \| `identity_conflict` \| `email_conflict` |
| `attempted_at`    | `TIMESTAMPTZ` |
| PK                | `(provider, provider_subject, user_id)` — each candidate counted once |

The PK makes `ON CONFLICT DO UPDATE` safe under concurrent link attempts.

`PgSocialLinkAttemptStore` is the production implementation; tests use
`InMemorySocialLinkAttemptStore`. For multi-instance deployments the store
should be a shared store (Redis or PostgreSQL).

## Abuse / failure paths

| Scenario | Behaviour |
|----------|-----------|
| Same sub sprayed across ≥ `threshold` accounts | Alert emitted (metric + alarm + audit + AML sink), PoP still enforced per attempt |
| Wrong password repeatedly on **one** account | Counted once; no alert |
| Non-existent user ID probes | **Not** recorded (avoids fabricated alert noise) |
| Identity already linked to another account | Attempt recorded as `identity_conflict` |
| Detector store / AML sink down | Detection skipped, link flow unaffected |
| Expired/wrong PoP | `STEP_UP_REQUIRED` (401), attempt recorded as `step_up_failed` |

## Metrics

- `social_link_anomaly_total` (counter) — number of detected anomaly patterns.
- Reuse existing per-identity rate limiting from
  `src/middleware/socialAntiEnumerationMiddleware.ts` as the login-side defence.

## Tests

```bash
npx jest src/auth/social/socialLinkAnomalyDetector.test.ts src/auth/social/socialAuthService.test.ts
```

Covers threshold crossing, single-account non-triggering, window expiry,
cooldown re-arm, provider/subject isolation, sink/audit failure isolation, and
the malicious-link scenarios end-to-end through `SocialAuthService.linkProvider`.
