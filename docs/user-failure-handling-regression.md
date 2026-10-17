# User Repository Failure-Handling Regression Suite

## Overview

`src/db/repositories/userRepository.regression.test.ts` pins the three explicit
failure / empty-result exits of `UserRepository`:

| Line | Method | Guard | Pinned error |
| ---- | ------ | ----- | ------------ |
| `userRepository.ts:129` | `createUser` | `result.rows.length === 0` after `INSERT … RETURNING *` | `Error('Failed to create user')` |
| `userRepository.ts:182` | `updateUser` | no updatable fields and `findById` returns `null` | `Error('User not found')` |
| `userRepository.ts:201` | `updateUser` | `result.rows.length === 0` after `UPDATE … RETURNING *` | `Error('Failed to update user')` |

The suite is **test-only**: no production file is modified, so the public
contract (`Promise<User>` / `Promise<User | null>` and the existing error
messages/classes) is preserved exactly. The goal is to make silent behaviour
changes — for example turning an empty `RETURNING` set into a success, returning
a partially populated `User`, or swapping a plain `Error` for a
`UniqueConstraintError` — fail loudly in CI.

## What the suite pins

### `createUser` — empty `RETURNING` set (line 129)

* Exact rejection class (`Error`, not a domain subclass) and exact message.
* The guard is keyed on `rows.length`; a contradictory driver
  `rowCount: 1` still throws.
* The call never resolves with a fabricated or partial user.
* `rows: [null]` rejects with a `TypeError` instead of returning a user.
* The same input produces the same error on every call.
* The message contains no SQL text, email address or password hash.
* Neighbouring success/boundary paths: full row mapping, five positional
  parameters, `startup`/`standard` defaults, `NULL` name, unknown stored tier →
  `standard`, empty-string credentials forwarded as parameters, and hostile
  email payloads bound (never interpolated) into SQL.

### `updateUser` — no fields + missing user (line 182)

* Exact `Error('User not found')` contract when `findById` returns `null`.
* Exactly one `SELECT`, never an `UPDATE`.
* Explicitly-`undefined` optional fields count as “not provided” and take the
  same read-only path; they must not trigger a useless/NULL assignment.
* An empty-string `id` is an ordinary lookup miss (no special-casing).
* Deterministic across repeated calls; never resolves with a user.
* Neighbouring success path: an existing user is returned (mapped) without a
  write, including `NULL` name → `undefined`, unknown tier → `standard` and a
  missing `last_oidc_groups` → `null`.

### `updateUser` — empty `RETURNING` set (line 201)

* Exact `Error('Failed to update user')` contract; never a
  `UniqueConstraintError`.
* Guard is keyed on `rows.length`; a stale `rowCount: 1` still throws.
* Exactly one `UPDATE`, with the id bound last.
* A `23505` driver error stays mapped to `UniqueConstraintError` with
  `field: 'email'`; non-`23505` errors are re-thrown **by identity**.
* The message contains no SQL text, email address or password hash.
* Neighbouring success/boundary paths: every supported field bound in
  declaration order, `last_oidc_groups: null` treated as a *provided* value that
  clears the column, `[]` serialised to `"[]"`, empty-string email forwarded,
  hostile email payloads bound, and full row mapping on success.

### `updateKycRiskTier` — caller-facing delegation

* Delegates to `updateUser` with `kyc_risk_tier = $1` and the id last.
* Propagates the pinned `'Failed to update user'` and
  `UniqueConstraintError` contracts unchanged, so callers cannot accidentally
  observe different failure semantics through the convenience method.

## Security assumptions

1. **Fail closed on a lost write.** A routing/replica surprise, an aborted
   transaction or a dropped connection can yield an empty `RETURNING` set even
   though the statement “ran”. Both guards fail loudly instead of reporting
   success to the caller.
2. **No information disclosure through errors.** The three messages are fixed
   literals. They are asserted not to contain SQL keywords, the caller-supplied
   email or the password hash, so they are safe to log and cannot be used to
   probe statement shape or credential material.
3. **Parameterised SQL only.** Caller values are always bound through `$n`
   placeholders. The suite feeds payloads such as
   `x@y.com'); DROP TABLE users; --` and asserts the payload never appears in
   the generated SQL text.
4. **Conflict ≠ lost write.** `23505` is translated to
   `UniqueConstraintError(field: 'email')`; an empty result stays a plain
   `Error`. Tests assert both directions so a softened guard cannot be masked by
   (or confused with) a duplicate-email race.
5. **Error identity is preserved.** Non-`23505` driver errors are re-thrown by
   reference. Wrapping or message rewriting would break upstream retry/alerting
   classification.
6. **Repository layer is not a validator.** Empty strings, unknown stored tiers
   and `NULL` groups are forwarded/normalised as documented; callers
   (`RegisterService`, `scim.ts`, `oidcRoute.ts`) own input validation and
   normalisation.

## Abuse and failure-path coverage

| Scenario | Expected observable behaviour | Covered by |
| -------- | ----------------------------- | ---------- |
| `INSERT` reports no returned row | `Error('Failed to create user')`, no `User` | `createUser` guard block |
| Driver reports `rowCount: 1` with no rows | Still rejects (guard uses `rows.length`) | `createUser` / `updateUser` guard blocks |
| Driver returns `rows: [null]` | `TypeError`, never a fabricated user | `createUser` guard block |
| No fields supplied, user absent | `Error('User not found')`, one `SELECT`, zero `UPDATE` | `updateUser` (line 182) block |
| `UPDATE` matches no row | `Error('Failed to update user')`, no partial user | `updateUser` (line 201) block |
| Duplicate email (`23505`) on update | `UniqueConstraintError`, `field: 'email'` | `updateUser` (line 201) block |
| Non-`23505` driver failure | Same error object re-thrown | `updateUser` (line 201) block |
| Hostile email payload | Bound as a parameter, absent from SQL text | `createUser` / `updateUser` success blocks |
| Unknown stored KYC tier | Normalised to `standard` | mapping blocks |
| Stored `NULL` name / missing groups | `undefined` / `null` respectively | mapping blocks |

## Deliberately pinned (not changed)

These are current behaviours the suite documents rather than “fixes”; changing
them would be a separate compatibility decision:

* The repository performs no validation or normalisation of email/password
  inputs.
* `rows: [null]` throws a `TypeError` from `mapUser` (only “never returns a
  user” is asserted, not the message).
* `updatePasswordHash` resolves successfully for an unknown id (no
  `RETURNING` guard).

## How to run

Focused suite:

```bash
npx jest src/db/repositories/userRepository.regression.test.ts --coverage=false
```

Focused suite with the 95 % coverage gate applied to `userRepository.ts`
(the existing contract suite is included so the untouched read methods are
counted too):

```bash
npm run test:coverage:user-failure
```

Surrounding suite (existing repository contract + direct consumers):

```bash
npx jest --coverage=false \
  src/db/repositories/userRepository.test.ts \
  src/db/repositories/userRepository.regression.test.ts \
  src/services/kycRiskTierService.test.ts \
  src/auth/register/registerService.test.ts \
  src/auth/startup/startupAuthService.test.ts
```

Lint and type-check:

```bash
npx eslint src/db/repositories/userRepository.regression.test.ts
npx tsc --noEmit
```

> `npx tsc --noEmit` is compared against the repository baseline: this suite is
> test-only and introduces no new diagnostics. Use
> `npx tsc --noEmit 2>&1 | wc -l` before/after if the baseline is in question.

## Expected evidence

```
npx jest src/db/repositories/userRepository.regression.test.ts --coverage=false
✓ 41/41 passed (1 suite)

npm run test:coverage:user-failure
✓ 70/70 passed (2 suites)
✓ userRepository.ts: 100% statements / 100% branches / 100% functions / 100% lines
  (gate: 95% — every failure exit is provably executed)

npx jest --coverage=false \
  src/db/repositories/userRepository.test.ts \
  src/db/repositories/userRepository.regression.test.ts \
  src/services/__tests__/kycRiskTierService.test.ts \
  src/auth/register/registerService.test.ts \
  src/services/startupAuthService.test.ts
✓ 101/101 passed (5 suites)

npx eslint src/db/repositories/userRepository.regression.test.ts
✓ exit 0

npx tsc --noEmit
➖ 30 diagnostics, all pre-existing; zero reference the new regression file
```

## CI note

The upstream `CI Gate` workflow (`.github/workflows/ci.yml`) is wired to the
`main` branch while the repository default branch is `master`, and it currently
runs only `audit:ci` and `validate:alert-mappings` — neither executes Jest, so
this suite cannot gate merges through that workflow as-is. `check-postmortem`
does run on pull requests and passes. Adding a Jest job (and pointing the
workflow at the default branch) is a repository-wide CI change and is
deliberately **out of scope** for this test-only PR; it should be raised
separately with the maintainers.
