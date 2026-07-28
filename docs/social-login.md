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

