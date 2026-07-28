# SCIM 2.0 Provisioning API

## Overview

Implements [SCIM 2.0 (RFC 7643/7644)](https://datatracker.ietf.org/doc/html/rfc7644) for automated identity provisioning and deprovisioning. Supports **Users** and **Groups** resources with full CRUD, bearer‑token authentication, per‑operation metrics, and soft‑deactivation (suspension) via in‑memory state tracking.

## Base URL

```
/scim/v2
```

## Authentication

All endpoints require a `Bearer` token sent via the `Authorization` header. The token is configured via the `SCIM_TOKEN` environment variable.

```http
Authorization: Bearer <scim-token>
```

If `SCIM_TOKEN` is empty or unset, authentication will reject all requests (no default).

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

- `DELETE /Users/:id` does **not** remove the database row. It adds the user's ID to an in‑memory `suspendedUsers` Set.
- All subsequent `GET` responses for that user return `"active": false`.
- `PUT` with `"active": true` or `PATCH` setting `active: true` removes the user from the Set.
- The database row is never deleted — audit trail is preserved.

## Metrics

Each SCIM operation increments a counter metric via `globalMetrics.incrementCounter`:

```
scim_operation_total{operation, resource}
```

Where `operation` is one of `read`, `create`, `replace`, `patch`, `delete` and `resource` is `Users`, `Groups`, `ServiceProviderConfig`, `Schemas`, or `ResourceTypes`.

## Security Assumptions

1. **Token confidentiality** — security relies entirely on `SCIM_TOKEN` being kept secret. Rotate it periodically.
2. **In‑process state** — suspended user state and groups are held in‑process memory. A multi‑instance deployment requires a shared store (e.g. Redis) for consistency.
3. **No built‑in audit log** — SCIM operations are not written to the `audit_log` table. The existing `AuditLogRepository` can be wired in if needed.
4. **No user deletion** — `DELETE` is always a soft‑deactivation. Hard deletion must be done through the admin API or directly in the database.

## Environment Variables

| Variable     | Required | Default | Description                      |
|-------------|----------|---------|----------------------------------|
| `SCIM_TOKEN` | No       | (empty) | Bearer token for SCIM API auth   |

## Testing

Run SCIM‑specific tests:

```bash
npx jest src/routes/scim.test.ts --coverage
```

Expected coverage: >95% on `src/routes/scim.ts` and `src/middleware/scimAuth.ts`.
