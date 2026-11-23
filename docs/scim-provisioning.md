# SCIM 2.0 Provisioning API

## Overview

Implements [SCIM 2.0 (RFC 7643/7644)](https://datatracker.ietf.org/doc/html/rfc7644) for automated identity provisioning and deprovisioning. Supports **Users** and **Groups** resources with full CRUD, bearer‑token authentication, per‑operation metrics, and persistent soft‑deactivation that blocks login and revokes sessions (#1300).

## Base URL

```
/scim/v2
```

## Authentication

All endpoints require a `Bearer` token sent via the `Authorization` header. The token is configured via the `SCIM_TOKEN` environment variable (at least 16 characters).

`createApp` mounts the router at `/scim/v2` only when `SCIM_TOKEN` is set; otherwise nothing is exposed and `/scim/v2/*` returns 404. Request bodies may be sent as `application/json` or `application/scim+json` (what IdPs normally use).

```http
Authorization: Bearer <scim-token>
```

### Error Response

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"],
  "status": 401,
  "scimType": "authorization",
  "detail": "Missing or malformed Authorization header"
}
```

## Resources

### ServiceProviderConfig

| Method | Path                              | Description                  |
|--------|-----------------------------------|------------------------------|
| GET    | `/scim/v2/ServiceProviderConfig`  | Retrieve service provider configuration |

### Schemas

| Method | Path                      | Description              |
|--------|---------------------------|--------------------------|
| GET    | `/scim/v2/Schemas`        | List all supported schemas |
| GET    | `/scim/v2/Schemas/:id`    | Retrieve a single schema   |

### ResourceTypes

| Method | Path                        | Description                 |
|--------|-----------------------------|-----------------------------|
| GET    | `/scim/v2/ResourceTypes`    | List all supported resource types |

### Users

| Method | Path                    | Description                         |
|--------|-------------------------|-------------------------------------|
| GET    | `/scim/v2/Users`        | Search/list users (`filter`, `startIndex`, `count`) |
| POST   | `/scim/v2/Users`        | Create a user (idempotent — returns existing if `userName` matches) |
| GET    | `/scim/v2/Users/:id`    | Retrieve a single user              |
| PUT    | `/scim/v2/Users/:id`    | Replace a user (used for activation/deactivation) |
| PATCH  | `/scim/v2/Users/:id`    | Partial update a user               |
| DELETE | `/scim/v2/Users/:id`    | Deactivate (soft‑delete) a user     |

#### Filtering

Only `eq` operator is supported on `userName` and `id` fields:

```
GET /scim/v2/Users?filter=userName eq "jane@example.com"
GET /scim/v2/Users?filter=id eq "user-uuid"
```

### Groups

| Method | Path                     | Description              |
|--------|--------------------------|--------------------------|
| GET    | `/scim/v2/Groups`        | Search/list groups       |
| POST   | `/scim/v2/Groups`        | Create a group           |
| GET    | `/scim/v2/Groups/:id`    | Retrieve a single group  |
| PUT    | `/scim/v2/Groups/:id`    | Replace a group          |
| PATCH  | `/scim/v2/Groups/:id`    | Partial update a group   |
| DELETE | `/scim/v2/Groups/:id`    | Delete a group           |

Groups are stored **in‑memory** (no database persistence). A `Map<string, GroupRecord>` keyed by both `displayName` and `id`.

## Deactivation (Soft‑Delete)

Any of these requests deactivates a user:

| Request | Example body |
|---------|--------------|
| `DELETE /scim/v2/Users/:id` | none |
| `PATCH /scim/v2/Users/:id` | `{"Operations":[{"op":"replace","path":"active","value":false}]}` |
| `PATCH` (Azure AD / Entra form) | `{"Operations":[{"op":"Replace","path":"active","value":"False"}]}` |
| `PUT /scim/v2/Users/:id` | `{"userName":"...","active":false}` |

`UserRepository.setActive(id, false)` then, in one transaction, sets `users.is_active = false` and `users.deactivated_at` (kept from the first deactivation if repeated) and sets `revoked_at` on every live session of the user. As a result:

- **Existing access tokens get 401.** `createRequireAuth` rejects revoked sessions immediately instead of waiting for token expiry.
- **Login fails** with the same result as a wrong password, so the response does not reveal that the account exists.
- **Token refresh fails** and revokes the session family.
- **The state persists.** `GET /Users/:id` reads `active` from the database, so restarts and other replicas agree.

Other rules:

- `DELETE` never removes the database row; the audit trail and foreign keys are preserved.
- Deactivating an already inactive user is still written, so a repeated IdP call also revokes any session created in the meantime.
- `active` must be a boolean or the strings `"true"` / `"false"` (any case). Anything else returns `400 invalidValue` before anything is written.
- `PUT` / `PATCH` with `active: true` reactivates the user and clears `deactivated_at`. Revoked sessions are not restored; the user signs in again.

### Concurrency

A token refresh racing a deactivation cannot leave a working session behind. `RefreshTokenRepositoryAdapter.isUserActive` reads the user row `FOR SHARE`, and `setActive` updates the user row before revoking sessions in a separate statement. Either the refresh commits first and its new session is revoked, or it waits and then sees `is_active = false`.

### Schema

Migration `061_add_is_active_to_users.sql` adds `users.is_active BOOLEAN NOT NULL DEFAULT true` and `users.deactivated_at TIMESTAMPTZ`. It is additive and idempotent; existing users stay active.

## Metrics

Each SCIM operation increments a counter metric via `globalMetrics.incrementCounter`:

```
scim_operation_total{operation, resource}
```

Where `operation` is one of `read`, `create`, `replace`, `patch`, `delete` and `resource` is `Users`, `Groups`, `ServiceProviderConfig`, `Schemas`, or `ResourceTypes`.

## Security Assumptions

1. **Token confidentiality** — security relies entirely on `SCIM_TOKEN` being kept secret. Rotate it periodically.
2. **In‑process groups** — user activation state is stored in PostgreSQL, but groups are still held in process memory (follow-up to #1300). A multi‑instance deployment needs a shared store for groups.
3. **No built‑in audit log** — SCIM operations are not written to the `audit_log` table. The existing `AuditLogRepository` can be wired in if needed.
4. **No user deletion** — `DELETE` is always a soft‑deactivation. Hard deletion must be done through the admin API or directly in the database.
5. **Social / OIDC sign‑in** — deactivation revokes all sessions, including social ones, but social and OIDC login do not check `is_active` yet, so a new social sign‑in is not blocked.

## Environment Variables

| Variable     | Required | Default | Description                      |
|-------------|----------|---------|----------------------------------|
| `SCIM_TOKEN` | No       | (empty) | Bearer token for SCIM API auth (min. 16 chars). The API is only mounted when set. |

## Testing

Run SCIM‑specific tests:

```bash
npx jest src/routes/scim.test.ts src/routes/scim.mount.test.ts --coverage
```

The `deprovisioning is persistent and blocks authentication` suite in `scim.test.ts` wires SCIM, `LoginService` and `createRequireAuth` to one shared store and is the regression test for #1300.

Expected coverage: >95% on `src/routes/scim.ts` and `src/middleware/scimAuth.ts`.
