# OIDC Front-Channel Logout Support (BE-017)

## Overview

Revora-Backend implements the **OpenID Connect Front-Channel Logout 1.0** specification,
allowing Identity Providers (IdPs) to initiate single-logout (SLO) by sending a signed
logout token to Revora. When an IdP session is terminated, all associated Revora sessions
for that user are invalidated.

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │                         Front-Channel Logout Flow                          │
 │                                                                            │
 │  IdP ──► GET/POST /auth/oidc/logout?logout_token=<JWT>                    │
 │              │                                                             │
 │              ▼                                                             │
 │      ┌───────────────┐    ┌────────────────┐    ┌───────────────────────┐  │
 │      │ Parse JWT     │───►│ Find Provider  │───►│ Validate Logout Token │  │
 │      │ header (iss)  │    │ by issuer_url  │    │ (sig, event, nonce,   │  │
 │      └───────────────┘    └────────────────┘    │  expiry, jti replay)  │  │
 │                                                 └───────────┬───────────┘  │
 │                                                             ▼              │
 │                                      ┌──────────────────────────────────┐  │
 │                                      │ sessionStore.deleteAllForUser()   │  │
 │                                      │ globalMetrics.incrementCounter(   │  │
 │                                      │   'oidc.logout.processed')        │  │
 │                                      └──────────────────────────────────┘  │
 └────────────────────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

| Method | Path                      | Description                        |
| :----- | :------------------------ | :--------------------------------- |
| GET    | `/api/auth/oidc/logout`   | Front-channel logout (query param) |
| POST   | `/api/auth/oidc/logout`   | Front-channel logout (body)        |
| GET    | `/auth/oidc/logout`       | Front-channel logout (no prefix)   |
| POST   | `/auth/oidc/logout`       | Front-channel logout (no prefix)   |

### Request

**POST** — send the logout token in the JSON body:

```http
POST /api/auth/oidc/logout
Content-Type: application/json

{
  "logout_token": "eyJhbGciOiJSUzI1NiIs..."
}
```

**GET** — send the logout token as a query parameter:

```http
GET /api/auth/oidc/logout?logout_token=eyJhbGciOiJSUzI1NiIs...
```

### Response

**200 OK** — logout processed successfully:

```json
{
  "ok": true,
  "message": "Logged out successfully"
}
```

**400 Bad Request** — token missing, malformed, expired, replayed, or provider not found:

```json
{
  "error": "Bad Request",
  "message": "Logout token replayed"
}
```

---

## Logout Token Requirements

Per the [OpenID Connect Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html)
specification, the logout token MUST satisfy all of the following:

| Claim      | Requirement                                                      |
| :--------- | :--------------------------------------------------------------- |
| `iss`      | Must match a registered OIDC provider's `issuer_url`.            |
| `sub`      | Identifies the user whose sessions should be terminated.         |
| `aud`      | Must include the provider's `client_id`.                         |
| `iat`      | Issued-at timestamp.                                             |
| `exp`      | Expiration — must be within the configured clock skew tolerance. |
| `events`   | Must contain `http://schemas.openid.net/event/backchannel-logout`. |
| `jti`      | Unique token ID — used for **replay protection** (see below).    |
| `alg`      | Must be an asymmetric algorithm (RS256, ES256, PS256, etc.).     |
| `kid`      | Key ID matching a key in the provider's JWKS.                    |

### What is REJECTED:

- Symmetric algorithms (`HS256`, `HS384`, `HS512`)
- The `none` algorithm
- Logout tokens containing a `nonce` claim
- Replayed tokens (same `jti` seen before)

---

## Replay Protection

Logout token replay is prevented using an in-memory set of consumed JWT IDs (`jti`):

1. On first use, the token's `jti` is recorded with its `exp` timestamp.
2. Any subsequent token with the same `jti` is rejected with `"Logout token replayed"`.
3. Expired entries are lazily cleaned up on each new token validation.

**Security note**: The consumed JTI store is per-process, in-memory. In a multi-instance
deployment, a token replayed to a different instance would not be detected. For
horizontal scale-out, replace with a Redis-backed store using `SET NX` with TTL.

---

## Session Termination

When a valid logout token is processed:

1. **All sessions** for the identified user (`sub` claim) are deleted via
   `sessionStore.deleteAllForUser()`.
2. This includes sessions across all roles and all devices — the IdP-initiated
   logout is a complete session termination for the user.

---

## Metrics

| Metric Name               | Type    | Labels          | Description                                   |
| :------------------------ | :------ | :-------------- | :-------------------------------------------- |
| `oidc.logout.processed`   | Counter | `status`        | Incremented on every processed logout request. |

---

## Security Assumptions

1. **Signed Token Required**: Logout tokens MUST be signed with a key published in
   the provider's JWKS endpoint. Unsigned or symmetrically-signed tokens are rejected.

2. **Replay Protection (in-memory)**: Each `jti` is tracked in-process. A replayed
   token is rejected. For multi-instance deployments, use a distributed store.

3. **Provider Lookup by Issuer**: The provider is resolved from the `iss` claim
   in the logout token. Only enabled providers are considered.

4. **Clock Skew Tolerance**: A 5-minute clock skew is allowed for `iat` and `exp`
   validation, matching the ID token verification policy.

5. **No Nonce Allowed**: Logout tokens containing a `nonce` claim are rejected,
   per the OpenID Connect specification's prohibition on nonces in logout tokens.

6. **Fail-Closed Algorithm Policy**: Only asymmetric algorithms are permitted.
   Symmetric algorithms and `none` are blocked explicitly.

---

## Test Coverage

All behaviours documented above are covered in:

- **Adapter-level tests**:
  [`src/auth/oidc/oidcLogout.test.ts`](../src/auth/oidc/oidcLogout.test.ts)
  — Covers token validation, event check, nonce rejection, replay protection,
  and signature verification.

- **Route-level integration tests**:
  [`src/auth/oidc/oidc.test.ts`](../src/auth/oidc/oidc.test.ts)
  — `createOidcRouter OIDC logout` describe block covers POST and GET logout,
  missing token, malformed token, missing issuer, provider not found, replayed
  token rejection, and both `/api/auth/oidc/logout` and `/auth/oidc/logout` paths.

---

## Related Documents

- [`docs/social-login.md`](social-login.md)
- [`docs/oidc-discovery-digest-alert.md`](oidc-discovery-digest-alert.md)
- [`docs/auth-session-hardening.md`](auth-session-hardening.md)
