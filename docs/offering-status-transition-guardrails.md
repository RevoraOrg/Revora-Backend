# Offering Status Transition Guardrails

## Overview

This document describes the offering status transition guardrail system
implemented in `Revora-Backend`. It enforces strict, deterministic rules
about how an offering can move between lifecycle states — preventing illegal
jumps, abuse paths, and inconsistent data.

---

## Status Lifecycle

An offering moves through the following statuses in order:
```
draft → pending_review → approved → published → archived
                       ↘ rejected → draft
```

No other transitions are permitted. Any attempt to skip a step or move
backwards (except rejected → draft) will throw an error.

---

## Allowed Transitions

| From           | To                        |
|----------------|---------------------------|
| draft          | pending_review            |
| pending_review | approved, rejected        |
| approved       | published                 |
| rejected       | draft                     |
| published      | archived                  |
| archived       | _(none — terminal state)_ |

---

## Implementation

**File:** `src/lib/offeringStatusGuard.ts`

### `canTransition(from, to): boolean`
Returns `true` if the transition is allowed, `false` otherwise.
Does not throw — safe to use for conditional checks.

### `enforceTransition(from, to): void`
Throws a descriptive `Error` if:
- Either status is missing or empty
- The `from` status is not a recognised offering status
- The `to` status is not a recognised offering status
- The transition between the two statuses is not allowed

Use this in route handlers where an invalid transition must halt execution.

---

## Security Assumptions

- The route `PATCH /offerings/:id/status` requires authentication via
  the `requireAuth` middleware. Unauthenticated requests receive a `401`.
- Status values are validated against a strict enum (`OfferingStatus`).
  Arbitrary string inputs are rejected at the TypeScript type level and
  at runtime via the guard.
- The allowed transitions map (`ALLOWED_TRANSITIONS`) is the single source
  of truth. It is never mutated at runtime.
- Terminal states (e.g. `archived`) have an empty transitions array,
  making them permanently locked without a code change.

---

## Abuse and Failure Paths

| Scenario                          | Behaviour                          |
|-----------------------------------|------------------------------------|
| Missing `from` or `to`            | Throws `Invalid status input`      |
| Unknown `from` status             | Throws `Unknown current status`    |
| Unknown `to` status               | Throws `Unknown target status`     |
| Same-state transition (e.g draft → draft) | Blocked not in allowed list |
| Skipping a state (e.g draft → published) | Throws `Invalid transition`  |
| Unauthenticated request           | Returns `401 Unauthorized`         |
| Offering not found                | Returns `404 Not found`            |

---

## Test Coverage

**File:** `src/routes/health.test.ts`

| Test                              | What it verifies                        |
|-----------------------------------|-----------------------------------------|
| allows valid transition           | `draft → pending_review` returns true   |
| blocks invalid transition         | `draft → published` returns false       |
| throws on invalid transition      | `enforceTransition` throws on bad path  |
| throws on unknown state           | Unknown `from` status throws            |
| blocks same-state transition      | `draft → draft` returns false           |

---

## Example Usage
```typescript
import { enforceTransition } from '../lib/offeringStatusGuard';

// Inside a route handler:
enforceTransition(offering.status, newStatus);
// If this line does not throw, the transition is safe to apply.
```

---

## Related Files

- `src/lib/offeringStatusGuard.ts` — core guard logic
- `src/index.ts`  route handler for `PATCH /offerings/:id/status`
- `src/routes/health.test.ts` — full test suite