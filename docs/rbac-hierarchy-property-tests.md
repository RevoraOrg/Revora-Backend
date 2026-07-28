# RBAC Role-Hierarchy Property Tests

**Schema version:** 1  
**Forbidden capability list version:** 1  
**Test file:** `src/security/rbac.property.test.ts`  
**Framework:** [fast-check](https://fast-check.dev/) v4.7.0  

---

## Overview

Role-based access control (RBAC) hierarchies are a frequent source of regressions
during refactors: an engineer adds a new permission, updates one role's flat list,
but forgets that two other roles inherit from it. Unit tests only catch the cases
the author thought to write. Property-based tests catch the cases no one thought to
write, by asserting *structural invariants* that must hold for any possible
configuration or role.

This document describes the six invariant groups tested, the versioned forbidden
capability list, the role hierarchy definition, and how to evolve the tests safely.

---

## Role Hierarchy

```
admin
  └─ verifier
       ├─ issuer
       └─ investor
```

`admin` ⊇ `verifier` ⊇ `{issuer, investor}`

`issuer` and `investor` share `verifier` as a common ancestor — a **diamond
inheritance** pattern. The deduplication invariant (Property 3) specifically
guards against a capability appearing twice when the diamond collapses.

The hierarchy is expressed in code as `ROLE_HIERARCHY: Record<UserRole, UserRole[]>`
and is exported from `rbac.property.test.ts` so CI scripts and the audit gate can
compare it against the production config.

---

## Versioned Forbidden Capability List

Schema version: **1** (set `RBAC_SCHEMA_VERSION` when updating).

| Capability | Reason |
|---|---|
| `vault:delete` | Destructive — hard-deletes are prohibited at runtime |
| `audit:purge` | Audit immutability must be preserved; purging is a separate operational procedure |
| `admin:impersonate` | Privilege-escalation vector; requires out-of-band approval |
| `system:bootstrap` | One-time setup only; must never be a runtime grant |

### Updating the list

1. Bump `RBAC_SCHEMA_VERSION` in `rbac.property.test.ts`.
2. Add the new forbidden capability to `FORBIDDEN_CAPABILITIES_V1`.
3. If an existing capability must be **removed** from the forbidden list (i.e., you
   want to allow it), treat it as a security review item: file a PR that explains
   why, gets sign-off from two engineers, and updates the schema version.

---

## The Six Invariant Groups

### Property 1 — Hierarchy superset invariant

> For every ancestor role A of role D, every capability in A's permission set
> must also appear in D's **effective** capability set.

Tested against:
- The production `DEFAULT_SECURITY_CONFIG` (100 runs).
- Arbitrary generated configs (200 runs).
- Specific pairs: admin ⊇ all others, verifier ⊇ issuer/investor.

**Refactor risk this catches:** A developer renames `milestone:validate` in the
`verifier` list but forgets to rename it in the `admin` list (or vice versa), breaking
the superset relationship.

### Property 2 — Forbidden capabilities are never granted

> No role, under any config, may hold a capability from the forbidden list.

Tested via:
- Production config scan (100 runs).
- Arbitrary clean configs that never inject forbidden caps (200 runs).
- **Inverse test**: a deliberately poisoned config (forbidden cap injected into a
  random role) is correctly *detected* by the invariant helper (200 runs). This
  verifies the check itself works.

**Refactor risk this catches:** A developer adds `audit:purge` to the admin permission
list to aid debugging, not realising it is on the forbidden list.

### Property 3 — Diamond-inheritance deduplication

> Effective capability sets must contain no duplicate entries, even when multiple
> inheritance paths converge on the same ancestor.

Tested via:
- Production config (100 runs).
- Arbitrary configs (200 runs).
- Idempotency: calling `resolveEffectiveCapabilities` twice returns the same set
  (200 runs).

**Refactor risk this catches:** A naive `concat` of ancestor capability arrays
without deduplication causes `milestone:view` to appear twice in admin's effective
set, silently corrupting permission comparison logic downstream.

### Property 4 — Middleware authorization mirrors the static capability map

> For every role R and every capability C:
> - If C ∈ effective(R) → `createAuthorizationMiddleware` must call `next()`.
> - If C ∉ effective(R) → middleware must respond HTTP 403.

Tested with 200 runs across all role × permission combinations.

**Refactor risk this catches:** A copy-paste error in the middleware makes it use
`config.enabledPermissions[role]` directly (no inheritance) while the docs say
"roles inherit from ancestors". The property test fails on any role whose inherited
capability is not in its own flat list.

### Property 5 — Unknown roles receive zero capabilities

> A role string not present in the config must yield an empty effective capability
> set and trigger a 403 from the middleware.

The arbitrary generates safe alphanumeric strings prefixed with `unknown_`,
excluding JavaScript built-in property names (`constructor`, `valueOf`, etc.) that
would cause prototype-chain lookups in code without `Object.hasOwn` guards.

`resolveEffectiveCapabilities` itself uses `Object.hasOwn` for all map accesses and
is therefore safe against prototype-pollution inputs.

**Refactor risk this catches:** Adding a new role to the codebase without adding it
to `ROLE_HIERARCHY` leaves it with inherited prototype-chain data instead of an
empty set.

### Property 6 — Self-contained inheritance completeness (transitivity)

> The effective capability set of a role must be transitively complete: every
> capability of every **transitive** ancestor (not just direct parents) must appear.

Also tests that every role's effective set is a **subset** of its direct parent's
effective set (when configs are generated arbitrarily), ensuring the partial order
is consistent in both directions.

**Refactor risk this catches:** `resolveEffectiveCapabilities` only walking one
level of the hierarchy (direct ancestors) rather than the full transitive closure.

---

## Helpers Exported for CI / Audit Gate

| Export | Purpose |
|---|---|
| `RBAC_SCHEMA_VERSION` | Monotone integer; used by the audit gate to detect schema drift |
| `FORBIDDEN_CAPABILITIES_V1` | Readonly array; imported by the audit gate for runtime enforcement |
| `ROLE_HIERARCHY` | DAG as `Record<UserRole, UserRole[]>`; compared against DB role rows |
| `ALL_ROLES` | Canonical ordered list of valid `UserRole` values |
| `resolveEffectiveCapabilities(role, config)` | Pure function; use it to compute effective grants outside of middleware context |

---

## Running the Tests

```bash
# Just the property tests
npx jest --testPathPatterns='src/security/rbac.property.test.ts'

# All RBAC tests (unit + property + policy serialiser)
npx jest --testPathPatterns='src/security/rbac'

# Full suite with coverage
npm test
```

Expected output:

```
RBAC — Property 1: Hierarchy superset invariant
  ✓ every ancestor capability is present in the descendant effective set (production config)
  ✓ every ancestor capability is present in the descendant effective set (arbitrary configs)
  ✓ admin effective set is a superset of every other role (production config)
  ✓ verifier effective set is a superset of issuer and investor (production config)
RBAC — Property 2: Forbidden capabilities are never granted
  ✓ no role in DEFAULT_SECURITY_CONFIG holds a forbidden capability
  ✓ no role in arbitrary configs holds a forbidden capability (own grants)
  ✓ a config poisoned with a forbidden capability is detected by the invariant
RBAC — Property 3: Diamond-inheritance deduplication
  ✓ effective capability sets contain no duplicate entries (production config)
  ✓ effective capability sets contain no duplicate entries (arbitrary configs)
  ✓ resolveEffectiveCapabilities is idempotent — calling twice returns same set
RBAC — Property 4: Middleware authorization mirrors capability map
  ✓ middleware grants access iff capability is in effective set (production config)
RBAC — Property 5: Unknown roles receive zero capabilities
  ✓ a role not present in the config yields an empty effective capability set
  ✓ middleware returns 403 for unknown/anonymous roles
RBAC — Property 6: Self-contained inheritance completeness
  ✓ resolveEffectiveCapabilities is transitively complete (production config)
  ✓ every role has a capability set that is a subset of its direct parent's effective set

Tests: 15 passed, 15 total
```

---

## Security Assumptions

1. `ROLE_HIERARCHY` is treated as authoritative. If the DB or a runtime config
   diverges from it, the audit gate (not these tests) is responsible for detecting
   that divergence.
2. The forbidden capability list is a **deny-list addendum**, not the sole source of
   truth for what is allowed. Capabilities must appear in `DEFAULT_SECURITY_CONFIG`
   to be granted; the forbidden list only adds an extra layer of protection.
3. These tests run in CI on every PR that touches `src/security/`. A failing
   property test is treated as a **security regression**, not a test maintenance
   issue.
4. fast-check's reproducible seeds mean a counterexample that fails in CI can be
   replayed locally: add `{ seed: <seed from failure output> }` to the failing
   `fc.assert` call.

---

## Extending the Test Suite

When you add a new `UserRole`:

1. Add the role to `UserRole` in `src/security/types.ts`.
2. Add the role to `ALL_ROLES` and `ROLE_HIERARCHY` in `rbac.property.test.ts`.
3. Add the role to `DEFAULT_SECURITY_CONFIG.enabledPermissions`.
4. If the new role inherits from others, add it as a value in `ROLE_HIERARCHY` for
   the appropriate parent roles.
5. Run the full RBAC test suite to verify all invariants hold.

When you add a new `Permission`:

1. Add it to the `Permission` union in `src/security/types.ts`.
2. Add it to `ALL_PERMISSIONS` in `rbac.property.test.ts`.
3. Assign it to the appropriate roles in `DEFAULT_SECURITY_CONFIG`.
4. If the permission must never be granted at runtime, add it to
   `FORBIDDEN_CAPABILITIES_V1` and bump `RBAC_SCHEMA_VERSION`.
