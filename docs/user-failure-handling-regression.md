# User Repository — Failure Handling Regression Coverage (issue #1027)

Focused regression suite for the explicit failure / empty-result paths in
[`src/db/repositories/userRepository.ts`](../src/db/repositories/userRepository.ts).

- **Implementation under test:** `src/db/repositories/userRepository.ts` (unchanged)
- **New tests:** `src/db/repositories/userRepository.regression.test.ts`
- **Surrounding suite:** `src/db/repositories/userRepository.test.ts`
- **Focused command:** `npm run test:coverage:user-failure`
- **Type of change:** test-only. The public contract is pinned, not modified.

## 1. Why this suite exists

`UserRepository` has three explicit failure exits. Each one is the *only* thing
standing between a lost write and a caller that believes the write succeeded:

| Evidence (pre-change)                       | Branch exercised                                            | Covered by |
| ------------------------------------------- | ----------------------------------------------------------- | ---------- |
| `src/db/repositories/userRepository.ts:129` | `createUser` → `throw new Error('Failed to create user')`    | *"createUser — empty-result failure contract (line 129)"* |
| `src/db/repositories/userRepository.ts:182` | `updateUser` (no fields) → `throw new Error('User not found')` | *"updateUser — no-field \"User not found\" contract (line 182)"* |
| `src/db/repositories/userRepository.ts:201` | `updateUser` (UPDATE) → `throw new Error('Failed to update user')` | *"updateUser — empty-result failure contract (line 201)"* |

Without this suite, a refactor can soften an `if (rows.length === 0) throw` into an
early `return null` / `return result.rows[0]`, and the failure becomes observable
only in production: registration appears to succeed with an undefined user, or a
profile update silently reports success while the row is untouched.

## 2. Contract rules pinned by the suite

All of the following describe **existing** behaviour; the tests exist so that a
change to any of them fails CI and becomes a reviewed decision.

1. **Exact messages are the contract.**
   `'Failed to create user'`, `'User not found'` and `'Failed to update user'` are
   pinned with `toBe` (no substring matching), together with `error.name === 'Error'`.
   Callers and log-based alerting depend on those literals.
2. **Failure class is plain `Error`, not `UniqueConstraintError`.**
   `UniqueConstraintError` is reserved for PostgreSQL `23505`; an empty `RETURNING`
   set must never be mapped onto a 409 conflict response.
3. **The empty-result branches key on `rows.length`, not `rowCount`.**
   A pool/driver reporting `rowCount: 1` with zero rows still throws. Losing a
   write can therefore never be masked by an inconsistent row count.
4. **No fabricated or partial user is ever returned.** Every failure case asserts
   the promise rejects (never resolves) — including an out-of-contract driver
   shape where the first row is `NULL`.
5. **`updateUser({ id })` with no updatable field is a read-only no-op:** exactly
   one `SELECT`, **no** `UPDATE` reaches the database, and the only failure mode is
   the `'User not found'` exit. Explicitly-`undefined` optional fields count as
   "not provided".
6. **`last_oidc_groups: null` is a *provided* value.** It is written as SQL `NULL`
   through a real `UPDATE` — the boundary between "omit the field" (no-op read) and
   "clear the groups" (write).
7. **Failure messages are deterministic and leak nothing**: identical across
   repeated calls, containing no SQL text, no email and no password hash.
8. **`handlePgError` routing is unchanged**: `23505` → `UniqueConstraintError`
   (`field: 'email'`), any other pg error is re-thrown **by identity**
   (`rejects.toBe(pgError)`) so the original stack/code survives.
9. **`updateKycRiskTier` propagates the `updateUser` contract verbatim** — the
   same `'Failed to update user'` / `'User not found'` messages reach its callers.

## 3. Security assumptions and abuse / failure paths

| Assumption or abuse path | Expected behaviour | Test |
| ------------------------ | ------------------ | ---- |
| A write is lost (routing, replica, aborted transaction) and `RETURNING` is empty | the call fails loudly; nothing is reported as created/updated | *"never resolves with a partial or fabricated user"*, *"throws a plain Error with the exact message …"* |
| A driver/mocker reports an inconsistent `rowCount` | `rows.length` wins; the failure still surfaces | *"is keyed on rows.length, not rowCount …"* (create and update) |
| A duplicate-email race is mistaken for an empty-result failure (or vice versa) | `23505` → `UniqueConstraintError(field: 'email')`; empty result → plain `Error` | *"does not raise UniqueConstraintError for an empty insert result"*, *"keeps UniqueConstraintError as the class for pg 23505"* |
| Attacker probes error messages for SQL/statement details or credentials | messages are fixed literals; no SQL, email or hash is echoed | *"does not leak SQL text, the email or the password hash …"* (create and update) |
| Attacker injects SQL through `email` (quotes / statement fragments) | values stay bound parameters; host SQL is never string-interpolated | *"binds hostile email content as a parameter …"*, *"binds a quote-laden email as a parameter …"* |
| Caller clears OIDC groups by passing `null` | SQL `NULL` is written (documented write path, not silently ignored) | *"treats last_oidc_groups: null as a provided value …"* |
| Operator "fixes" a missing user by retrying `updateUser({ id })` | deterministic `'User not found'`, no write side effect | *"issues exactly one SELECT and never an UPDATE"* |
| Empty-string `id` / `email` reaches the repository | no crash and no special case: a lookup miss yields `'User not found'`; an empty email is bound and the empty `RETURNING` set yields `'Failed to update user'` | *"treats an empty-string id as a normal lookup miss"*, *"binds an empty-string email instead of rejecting it at this layer"* |

### Known, deliberately pinned behaviour (follow-up candidates)

These are **not** changed by this PR; they are pinned so that any future change is
explicit and reviewable:

- **Out-of-contract driver row (`rows: [null]`) throws a `TypeError`.**
  The suite asserts only that the call *rejects*; it deliberately does not pin the
  error type, because the security-relevant property is "never return a user",
  not the exact mapping failure.
- **The repository performs no validation or normalisation.** An empty-string
  email is bound to SQL as-is — normalisation is the caller's job
  (`RegisterService`, `scim.ts`, `oidcRoute.ts`). Moving validation here would be a
  behaviour change for every caller.
- **`updatePasswordHash` reports success for an unknown id** (`rowCount: 0` is a
  no-op). Pinned by the existing suite, not by this one; the
  `changePassword` flow resolves existence before calling it.

## 4. How to run

```bash
# focused regression suite only
npx jest src/db/repositories/userRepository.regression.test.ts --coverage=false

# focused suite + the 95% coverage gate on the touched file
npm run test:coverage:user-failure

# repository suite + direct consumers
npx jest src/db/repositories/userRepository.regression.test.ts \
         src/db/repositories/userRepository.test.ts \
         src/services/__tests__/kycRiskTierService.test.ts \
         src/auth/register/registerService.test.ts \
         src/services/startupAuthService.test.ts \
         src/routes/scim.test.ts --coverage=false
```

## 5. Evidence — results observed on this branch

| Gate | Command | Result |
| ---- | ------- | ------ |
| Focused regression suite | `npx jest src/db/repositories/userRepository.regression.test.ts --coverage=false` | **43 passed / 0 failed** (1 suite, ~2 s, exits cleanly) |
| Coverage gate on the touched file | `npm run test:coverage:user-failure` | **72 passed / 0 failed**; `userRepository.ts` at **100% statements / branches / functions / lines** vs the 95% gate (see §7) |
| Repository suite + direct consumers | the six-suite command in §4 | **157 passed / 0 failed** (6 suites) |
| ESLint (new file) | `npx eslint src/db/repositories/userRepository.regression.test.ts` | exit 0, no errors or warnings |
| ESLint (whole repo) | `npm run lint` | 2257 errors / 8 warnings — **all pre-existing**, the new file contributes none (`grep userRepository.regression` on the output returns nothing) |
| TypeScript | `npx tsc --noEmit` | **250 error lines**, the same count as the pre-change baseline (`origin/master`); no diagnostic mentions either changed file |
| Alert mappings | `npm run validate:alert-mappings` | `OK: All 22 known alerts have mapping entries.` |
| Dependency gate | `npm run audit:ci` | fails **identically with and without this change** (see below) |
| Mutation check | see §7 | **4 / 4 mutants killed** |

### Full-repository suite

`npx jest --ci --coverage=false` is **not usable as a gate on this branch's base**:
44 suites report `FAIL` (inherited from `origin/master`, see the stashed-baseline
comparison below) and the run then stalls without printing a summary — the last
output is an Express access log (`GET /api/v1/overview`, 38 ms) from a suite whose
HTTP server never tears down. It was stopped after 15+ minutes. This suite is not
implicated: the new spec runs in ~2 s, exits cleanly, and leaves no open handles
(`npx jest <new spec>` returns to the prompt without `--forceExit`).

The paragraph is kept deliberately blunt so nobody reads the green focused gates as
"the whole repo is green".

To separate pre-existing failures from this change, four failing suites were run
twice — once on the branch, once with this branch's changes stashed:

```text
== WITH CHANGES ==                      == BASELINE (changes stashed) ==
Test Suites: 2 failed, 2 passed, 4 total    Test Suites: 2 failed, 2 passed, 4 total
Tests:       18 failed, 263 passed          Tests:       18 failed, 263 passed
```

(`src/lib/decimal.test.ts`, `src/lib/metrics.test.ts`,
`src/services/__tests__/sanctionsListDiffService.test.ts`,
`src/services/fxConversionEngine.test.ts`.) Identical numbers confirm the failures
are inherited, not introduced. The same applies to `npm run audit:ci`: it reads
`package-lock.json`, which this change does not touch (`git status` lists only
`package.json`, the new spec and this document), and its output
(`@stellar/stellar-sdk`, `express`, `qs`, `stellar-sdk`, `toml`, plus the `zod`
outdated-gate false positive) reproduces unchanged with or without the diff.


## 6. What "fixed" means for #1027

The issue reports a *failure-handling regression*: the empty-result guards in
`UserRepository` were suspected of having been softened (returning `null` /
`undefined`, or keying off `rowCount`) so that a lost write silently reads as
success. The check performed here is therefore **behavioural, not cosmetic**:

1. **The guards are present and effective on `master` itself** — the tree was not
   edited. Every case in §3 runs against the shipped implementation and passes,
   including the inconsistent-`rowCount` cases that a softened guard would fail.
2. **The guards are load-bearing** — removing or weakening any one of the three
   exits makes the suite fail (§7). If the regression had still been present, the
   suite would have failed on an unmodified tree instead.
3. **Nothing else regressed** — repository suite, direct consumers, lint and the
   type-check baseline are unchanged, and the identical pre-existing failure counts
   in §5 show no collateral damage.

## 7. Mutation evidence (proof the suite bites)

Each mutant was applied to `userRepository.ts` in a scratch checkout, the focused
suite was run, and the file was restored with `git checkout --`:

| Mutant | Guard removed | Focused suite result | Tests that caught it |
| ------ | ------------- | -------------------- | -------------------- |
| M1 | line 129 `throw` → `return null` | **6 failed** / 37 passed | all six `createUser — empty-result failure contract (line 129)` cases |
| M2 | line 182 `throw` → `return undefined` | **7 failed** / 36 passed | the six `updateUser — no-field "User not found" contract (line 182)` cases plus *"updateKycRiskTier … propagates the exact \"User not found\" error …"* |
| M3 | line 201 keys on `rowCount` instead of `rows.length` | **1 failed** / 42 passed | *"is keyed on rows.length, not rowCount (inconsistent driver rowCount still throws)"* |
| M4 | line 129 message drift (`'create failed'`) | **2 failed** / 41 passed | *"throws a plain Error with the exact message \"Failed to create user\""*, *"never resolves with a partial or fabricated user"* |

`git status` after the run shows no modification to `src/db/repositories/`-tracked
sources — the mutants were never committed.

### Coverage of the failure exits

`npm run test:coverage:user-failure` reports the file at 100% on all four metrics
(the 95% global gate applies on top of that), so every `throw`/`return` in
`userRepository.ts` — including all three failure exits — is executed by the suite.

