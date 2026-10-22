# OFAC Dual-Control Review Queue

Implements issue #679: a review queue for OFAC false-positive hits that requires
two independent compliance officers to clear a flagged investor.

---

## Background

OFAC screening occasionally flags legitimate investors on name collisions (e.g. a
common name that happens to appear on the SDN list).  Before this feature, those
cases paused silently with no structured workflow.

The review queue surfaces these hits in the admin UI and enforces a dual-control
clearance process: two compliance officers must independently record a rationale
before the investor is allowed to proceed.  Every state transition is written to
the immutable security audit log.

---

## Data model

**Table**: `ofac_reviews` (migration `018_create_ofac_reviews.sql`)

| Column | Type | Notes |
|---|---|---|
| `id` | `VARCHAR(255) PK` | |
| `alert_id` | `VARCHAR(255) FK → aml_alerts` | |
| `case_id` | `VARCHAR(255) FK → aml_cases` | optional |
| `investor_id` | `VARCHAR(255)` | |
| `matched_name` | `VARCHAR(255)` | OFAC SDN entry name |
| `list_entry_id` | `VARCHAR(255)` | optional SDN entry id |
| `status` | `VARCHAR(40)` | see workflow below |
| `created_by` | `VARCHAR(255)` | compliance officer who opened the review |
| `first_approver_id` | `VARCHAR(255)` | first officer |
| `first_approval_rationale` | `TEXT` | |
| `first_approved_at` | `TIMESTAMPTZ` | |
| `second_approver_id` | `VARCHAR(255)` | second officer |
| `second_approval_rationale` | `TEXT` | |
| `second_approved_at` | `TIMESTAMPTZ` | |
| `clearance_rationale` | `TEXT NOT NULL` | combined audit narrative |
| `cleared_at` | `TIMESTAMPTZ` | |
| `expires_at` | `TIMESTAMPTZ NOT NULL` | default: now + 24 h |
| `updated_at` | `TIMESTAMPTZ NOT NULL` | |

**Database-enforced constraints** (cannot be bypassed at the application layer):

- `ofac_review_creator_not_first_approver` — `first_approver_id <> created_by`
- `ofac_review_creator_not_second_approver` — `second_approver_id <> created_by`
- `ofac_review_dual_control` — `first_approver_id <> second_approver_id`

---

## Workflow

```
                  POST /aml/ofac-reviews
                         │
                         ▼
              ┌─────────────────────────┐
              │  pending_first_approval  │ ◄──── expired pending_second reset here
              └─────────┬───────────────┘
                        │  first officer approves
                        │  (must not be creator)
                        ▼
            ┌───────────────────────────┐
            │  pending_second_approval  │
            └──────────┬────────────────┘
                       │  second officer approves
                       │  (must not be creator or first approver)
                       ▼
                 ┌───────────┐
                 │  cleared  │
                 └───────────┘
```

**Expiry reset**: if a `pending_second_approval` review reaches its `expires_at`
timestamp without a second approval, the next call to `GET /aml/ofac-reviews` (or
the next approval attempt) resets it to `pending_first_approval` and clears the
first-approval fields.  This prevents the dual-control window from being gamed by
a single officer who waits indefinitely.

---

## API

All endpoints require an authenticated compliance officer (`role` must be one of
`admin`, `compliance`, `compliance_officer`).  Mutation endpoints additionally
require a valid CSRF token (`x-csrf-token` header must match the `csrfToken`
cookie value).

### GET /aml/ofac-reviews

Returns the active queue: all rows with status
`pending_first_approval` or `pending_second_approval`, ordered by `created_at`
ascending.  Expired `pending_second_approval` rows are reset before the list
is returned.

**Auth**: compliance role required.

**Response 200**:
```json
{
  "success": true,
  "data": [
    {
      "id": "ofac_review_1753878000000_abc123",
      "alert_id": "alert_001",
      "investor_id": "inv_001",
      "matched_name": "Ahmad Al-Rashid",
      "status": "pending_first_approval",
      "created_by": "officer_1",
      "created_at": "2026-07-30T12:00:00.000Z",
      "expires_at": "2026-07-31T12:00:00.000Z",
      "updated_at": "2026-07-30T12:00:00.000Z"
    }
  ]
}
```

---

### POST /aml/ofac-reviews

Open a new false-positive review case.

**Auth**: compliance role + CSRF token.

**Request body**:
```json
{
  "alert_id": "alert_001",
  "investor_id": "inv_001",
  "matched_name": "Ahmad Al-Rashid",
  "rationale": "DOB and passport do not match the SDN entry. KYC documents verified.",
  "case_id": "case_001",
  "list_entry_id": "SDN-12345",
  "expires_at": "2026-07-31T12:00:00.000Z"
}
```

| Field | Required | Constraints |
|---|---|---|
| `alert_id` | yes | non-empty string |
| `investor_id` | yes | non-empty string |
| `matched_name` | yes | 1–255 chars |
| `rationale` | yes | 10–4000 chars |
| `case_id` | no | optional |
| `list_entry_id` | no | 1–255 chars if provided |
| `expires_at` | no | ISO-8601 datetime; defaults to now + 24 h |

**Response 201**: created review object.

**Response 400**: Zod validation failure — `details` array contains per-field errors.

---

### POST /aml/ofac-reviews/:reviewId/approve

Record an approval on an existing review.

**Auth**: compliance role + CSRF token.

**Request body**:
```json
{
  "rationale": "Address, date of birth, and nationality do not match the SDN entry."
}
```

| Field | Required | Constraints |
|---|---|---|
| `rationale` | yes | 10–4000 chars |

**Response 200**: updated review object with new status.

**Response 400**: Zod validation failure.

**Response 404**: review not found.

**Response 409**: business rule violation (one of):
- Creator attempting self-approval: `"Review creator cannot approve their own OFAC clearance"`
- Same officer approving twice: `"Same compliance officer cannot approve an OFAC review twice"`
- Already cleared: `"OFAC review <id> is already cleared"`
- Empty rationale: `"OFAC clearance rationale is required"`

---

## Security assumptions

1. **RBAC**: the `requireReviewQueueRole` middleware rejects unauthenticated
   requests (401) and requests from non-compliance roles (403).  Allowed roles:
   `admin`, `compliance`, `compliance_officer`.

2. **CSRF**: mutation endpoints (`POST /aml/ofac-reviews`,
   `POST /aml/ofac-reviews/:id/approve`) require a `x-csrf-token` header that
   matches the `csrfToken` cookie.  This prevents cross-site request forgery from
   compromised user sessions.

3. **Database constraints**: `ofac_reviews` carries three `CHECK` constraints that
   enforce dual-control at the storage layer independently of the application.
   An attacker who bypasses the API cannot self-clear by directly issuing SQL.

4. **Row-level locking**: `OFACReviewRepository.approve()` uses
   `SELECT … FOR UPDATE` inside a transaction to prevent concurrent approvals from
   racing to clear the same review.

5. **Immutable audit trail**: every state transition (`ofac_review_created`,
   `ofac_review_first_approved`, `ofac_review_cleared`) is written to the
   `SecurityAuditRepository` which persists to the tamper-evident `audit_logs`
   hash chain (see `docs/audit-log-hash-chain.md`).

6. **Expiry enforcement**: a `pending_second_approval` review that has not been
   cleared before `expires_at` is reset to `pending_first_approval` on the next
   queue fetch or approval attempt.  This eliminates the attack surface of a
   single officer who grants themselves a permanent first-approval window.

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| Creator approves own review | 409 `creator cannot approve` |
| Same officer approves twice | 409 `cannot approve an OFAC review twice` |
| Approval on already-cleared review | 409 `already cleared` |
| Approval on non-existent review | 404 `not found` |
| Expired `pending_second_approval` — `findQueue` called | Row reset to `pending_first_approval` before list returned |
| Expired `pending_second_approval` — `approve` called | Row reset first, then new approval recorded as first approval |
| Missing CSRF token | 403 `Valid CSRF token required` |
| Non-compliance role | 403 `Compliance role required` |
| No authentication headers | 401 `Authentication required` |

---

## Related files

| File | Purpose |
|---|---|
| `src/db/migrations/018_create_ofac_reviews.sql` | Table DDL and indexes |
| `src/aml/types.ts` | `OFACReview`, `OFACReviewStatus`, `CreateOFACReviewInput` |
| `src/aml/ofacReviewRepository.ts` | Database layer with locking and expiry reset |
| `src/aml/amlService.ts` | `createOFACReview`, `getOFACReviewQueue`, `approveOFACReview` with audit logging |
| `src/routes/amlRoutes.ts` | HTTP endpoints with RBAC and CSRF guards |
| `src/aml/ofacReviewRepository.test.ts` | Repository-level unit tests |
| `src/routes/amlRoutes.test.ts` | Route-level integration tests for OFAC endpoints |
