# Issue #979 — RefreshService Failure-Path Regression Validation

> Included in this PR because the CI integration token cannot edit the PR
> description on the upstream repository (403). Reviewers: this documents the
> exercised cases and results for the regression coverage added to
> `src/auth/refresh/refreshService.test.ts`.
>
> Review location: PR #1194 (`feature/backend-011-rate-limiter-tier-policies` → `master`).

## Scope

Exercises the three explicit `return null` contracts in
`src/auth/refresh/refreshService.ts` (evidence lines **67 / 77 / 97**),
asserting observable value, log, and transaction-boundary behavior.
The existing public contract is preserved — **no production code changed**.

## Exercised cases

| Branch | Test | Asserts |
| :-- | :-- | :-- |
| Line 67 — token verification throws | `returns null and logs the rejection reason when verifyRefreshToken throws` | null return; exact warn payload `{ error: 'jwt malformed' }`; transaction never opened; repo untouched |
| Line 67 boundary | `returns null for empty and whitespace-only tokens` | `''` and `'   '` hit the same null contract without opening a transaction |
| Line 77 — in-flight duplicate | `returns null for a duplicate refresh while one is in flight` | null + exact `Concurrent refresh already in flight` payload; no revocation/writes by the loser; winner still completes rotation; lock released (next attempt reaches the transaction) |
| Line 97 — session row missing | `returns null with a not-found warning when the locked session row is missing` | null + exact `Session not found during refresh` payload; transaction opened (unlike line 67); no revocation/consume/create; in-flight lock released |
| Line 97 falsy boundary | `treats an undefined session row the same as a missing one` | falsy `undefined` row takes the identical null path as explicit `null` |

Neighboring normal paths are asserted inside the same tests: successful
rotation of the winning caller (line 77) and lock release enabling subsequent
transactions (lines 77 / 97).

## Results

- Focused file: `refreshService.test.ts` — **20/20 passed**
- Surrounding suites (`src/auth/refresh`) — **33/33 passed**;
  `refreshService.ts` at **100% statements / branches / functions / lines**
  (project gate ≥95%)
- PR suites (`health.test.ts`, `rateLimit.test.ts`,
  `startupAuthRateTierPolicy.test.ts`) — **132/132 passed**
- Lint (`eslint src/auth/refresh/refreshService.test.ts`) — **clean**
  (pre-existing `as any` casts in the file were removed; logger typed as `Logger`)
- Typecheck (`tsc --noEmit`) — **no errors in changed files**

## Determinism / error observability

- Failure behavior is deterministic: all inputs (expired, missing, revoked,
  consumed, duplicate, invalid) map to an explicit `null` return with a fixed
  log message and payload shape.
- Log assertions pin the exact message string and payload, so a regression
  that changes the error contract (message, coercion via `String(error)`, or
  silent swallow) fails the suite.
- No wall-clock dependence: expiry boundaries use fixed `Date` values
  (`NOW_FUTURE` / `NOW_PAST`); concurrency uses explicit promise gates.

## Re-validation (2026-09-28, branch tip `b5c2a558`)

- Focused file rerun — **20/20 passed** (`npx jest
  src/auth/refresh/refreshService.test.ts --runInBand`)
- Surrounding suite rerun — **33/33 passed** (`npx jest src/auth/refresh --runInBand`,
  4 suites)
- Coverage rerun with the ≥95% gate enforced on `refreshService.ts` — **100%
  statements / branches / functions / lines**, threshold met
- Typecheck (`npx tsc --noEmit`) — **0 errors in `src/auth/refresh/**`**;
  247 pre-existing errors elsewhere in the repo (unrelated modules, see the
  `isolatedModules` / `diagnostics.warnOnly` note in `jest.config.js`)
- Lint (`npx eslint` on `refreshService.ts` + `refreshService.test.ts`) — **clean**
- Known unrelated failure: `src/auth/register/__tests__/roundtrip.test.ts`
  (error-message wording) — pre-existing on `master`, untouched by this branch
- Contract checks (`npm run pact:verify`) — **13/13 passed**
- PR-description edits via `gh pr edit 1194` return `GraphQL: Resource not
  accessible by integration (updatePullRequest)`; PR comments likewise fail
  with `addComment` 403, so the token's PR write surface is read-only and
  this document is the canonical record for review. The exercised-case table
  above is ready to paste into the PR description by a maintainer.
