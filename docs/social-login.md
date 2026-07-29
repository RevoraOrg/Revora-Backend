# Social Login Security Model

Revora supports Google and Apple login through explicit account linking. A verified provider email
is never enough to claim an existing password account.

## Provider Verification

`JwksSocialTokenVerifier` validates compact JWT identity tokens before any account lookup:

- Google issuers are pinned to `https://accounts.google.com` and `accounts.google.com`.
- Apple issuer is pinned to `https://appleid.apple.com`.
- Audience must match configured client IDs:
  - `GOOGLE_OAUTH_CLIENT_ID` or `GOOGLE_CLIENT_ID`
  - `APPLE_CLIENT_ID` or `APPLE_SERVICE_ID`
- Signatures are verified against provider JWKS using RS256.
- Expired, not-yet-valid, missing-subject, missing-email, and unverified-email tokens are rejected.

## Account Linking

Social login works only after the primary account links the provider:

1. The user signs in through the existing password flow.
2. The user calls `POST /api/auth/social/:provider/link`.
3. The request must include `confirm: true`, `currentPassword`, and a provider `idToken`.
4. The current password is verified as step-up authentication before linking.

The database enforces:

- `UNIQUE (provider, provider_subject)` so one provider account cannot control multiple users.
- `UNIQUE (user_id, provider)` so a user has at most one Google and one Apple identity.

## Login Behavior

`POST /api/auth/social/:provider/login` requires a verified provider token and an existing linked
identity. If a password account exists with the same verified email but no linked identity, the
login is rejected with `EMAIL_ACCOUNT_REQUIRES_LINK` to prevent unverified account takeover.

If a provider email changes after linking, login continues to use the stable provider subject and
updates the stored provider email only after the new email is verified by the provider.

## Unlink Behavior

`DELETE /api/auth/social/:provider/link` requires the same `confirm: true` and `currentPassword`
step-up check. Unlink is idempotent: repeating unlink returns `{ "unlinked": false }`.

## Anti-Enumeration Hardening

The public login endpoint (`POST /api/auth/social/:provider/login`) is protected against
timing-based account enumeration by two complementary defences:

1. **Per-provider-sub rate bucket** — a fixed-window counter keyed by `"<provider>:<sub>"` is
   incremented for each login attempt.  An attacker who probes the same account repeatedly
   exhausts that identity's bucket regardless of how many IPs they rotate through.  Requests
   exceeding the limit receive a `429 Too Many Requests` response with a `Retry-After` header.

2. **Constant-time identity lookup** — `loginWithProvider` wraps the `findByProviderSubject` call
   in `constantTimeLookup`, which pads the response to a minimum floor
   (`CONSTANT_TIME_LOOKUP_MIN_MS = 50 ms`) so the "not found" and "found" code paths return in
   approximately the same wall-clock time.

See [`docs/social-anti-enumeration.md`](social-anti-enumeration.md) for full details.

## Provider Key Rotation Handling

Google and Apple periodically rotate their signing keys. The `JwksSocialTokenVerifier`
handles key rotation transparently:

### JWKS Caching

Provider JWKS (JSON Web Key Sets) are fetched from the provider's published JWKS URL
and cached in memory with a 10-minute TTL. Tokens whose signing keys are present in the
cache are verified immediately without any outbound request.

### Single-Flight Refresh on Unknown KID

When a JWT references a `kid` (Key ID) not present in the cached key set:

1. A JWKS refresh is triggered (subject to rate limits).
2. Verification is retried once using the refreshed keys.
3. If the KID is still unknown after refresh, the token is rejected with `INVALID_TOKEN`.
4. Only one outbound JWKS request is made per provider for concurrent unknown-KID requests —
   all waiters share the same in-flight refresh promise (single-flight).

### Refresh Rate Limiting

Refresh attempts are rate-limited per provider to prevent refresh storms during outages:

- Configurable budget: `refreshBudgetPerMinute` (default: 10).
- Separate budget per provider (Google and Apple are tracked independently).
- When the budget is exhausted for the current 60-second window, refresh is skipped and the
  existing cache is used, causing an `INVALID_TOKEN` rejection for unknown KIDs.
- The budget resets automatically when the 60-second window expires.

### Metrics

The counter metric `social.keys.refresh.attempts` is emitted for every refresh attempt,
with the following labels:

- `provider` — `google` or `apple`
- `outcome` — one of:
  - `attempt` — a refresh is starting
  - `success` — the refresh completed and keys were refreshed
  - `failure` — the refresh failed (e.g., network error, provider outage)
  - `skipped` — the caller joined an existing in-flight refresh (single-flight reuse)
  - `rate_limited` — the refresh was skipped because the budget was exhausted

### Security Guarantees

- JWT validation behaviour is unchanged except for the refresh retry.
- Verification is never skipped.
- Signatures are always validated using the provider's public keys.
- Issuer and audience validation remain intact.
- Unknown keys never bypass authentication — if the refreshed keys also lack the KID,
  the token is rejected.
- Refresh failures do not authenticate users — errors return `INVALID_TOKEN`.
- Provider outages cannot create refresh loops because the retry is bounded to exactly
  one attempt and the rate limit caps outbound requests.

### Configuration

The verifier accepts an optional `refreshBudgetPerMinute` parameter (default 10) and an
optional `metrics` object for emitting `social.keys.refresh.attempts`. The default verifier
constructed by `createDefaultSocialTokenVerifierFromEnv()` uses environment variables:

- `GOOGLE_OAUTH_CLIENT_ID` or `GOOGLE_CLIENT_ID` — Google audience/client ID
- `APPLE_CLIENT_ID` or `APPLE_SERVICE_ID` — Apple audience/service ID

