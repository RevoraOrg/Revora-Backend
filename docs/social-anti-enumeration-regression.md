# Social anti-enumeration metrics — failure-handling regression coverage

**Issue:** [#1060](https://github.com/RevoraOrg/Revora-Backend/issues/1060) — regression coverage for
`getSocialAntiEnumerationMetrics` failure handling.
**Relationship to #1027:** this PR is the successor deliverable to the earlier
`fix/1027-user-failure-handling-regression` branch. Issue #1027 targets a different module
(`UserRepository`) and is **not** closed by this PR.
**Change type:** **test-only.** No production source file is modified by this PR — the diff is one new
test file plus one `package.json` script and this document.

| Artifact | Path |
| --- | --- |
| Code under test | `src/middleware/socialAntiEnumerationMiddleware.ts` (unchanged) |
| New regression suite | `src/middleware/socialAntiEnumerationMiddleware.regression.test.ts` (new) |
| Existing suite (untouched) | `src/middleware/socialAntiEnumerationMiddleware.test.ts` |
| Convenience script | `npm run test:coverage:social-anti-enum` |

`git status --short` on this branch lists only the new `*.regression.test.ts` under `src/`, and
`git diff origin/master -- src/middleware/socialAntiEnumerationMiddleware.ts` is empty: the middleware is
pinned, not patched.

---

## 1. Why this suite exists

`socialAntiEnumerationMiddleware` is the only guard that stands between an unauthenticated social
login request and per-subject rate limiting. Its security value rests on three inline guards inside
`extractProviderSub`, each of which returns `null` (the "unidentifiable request" signal) and therefore
decides whether a request is limited **per token subject** or falls back to the looser **per-IP**
bucket:

| # | Guard | Source line | If it silently changes |
| --- | --- | --- | --- |
| G1 | `if (!VALID_PROVIDERS.has(provider as SocialAuthProvider)) return null;` | 90 | Any provider string (including attacker-chosen values) becomes a limiter bucket key |
| G2 | `if (typeof idToken !== 'string') return null;` | 91 | Non-string bodies reach `String.prototype.split` — throws (500) or coerces to a shared bucket |
| G3 | `if (parts.length !== 3) return null;` | 94 | Structure-less strings get parsed as JWTs, so crafted input can forge a subject |

The pre-existing suite asserted the happy path and a few adjacent behaviours, but nothing pinned the
observable contract that the metrics consumers depend on:

```ts
export function getSocialAntiEnumerationMetrics(): { attempts: number; rejections: number }
```

Specifically, before this PR there was no test that would fail if:

1. a rejection on the **per-provider-sub** branch stopped being counted, or stopped advancing only once;
2. a rejection on the **IP-fallback** branch was double-counted (or not counted at all);
3. `next()` route/request signals (`next('route')`, `next('router')`, `next()`) were misread as
   rejections — an easy over-count when the wrapper is refactored;
4. `attempts` drifted away from "one increment per request" (e.g. only counting *identifiable*
   requests), which would silently deflate the enumeration-rate signal that alerting is built on;
5. the metrics snapshot stopped being a fresh, process-wide-shared object (two middleware instances
   with different stores must feed one counter pair);
6. a failed store threw out of the middleware instead of degrading to "attempt counted, no rejection";
7. the guard wiring regressed so that `req.socialProviderSub` leaked to downstream handlers, or the
   429 body started echoing the submitted token/subject/provider.

This suite pins all seven.

---

## 2. Contract pinned by this suite

### 2.1 Extraction contract (`extractProviderSub`)

* **Provider allow-list only.** Only exact, allow-listed provider strings (`google`, `github`) are
  accepted. Case variants (`Google`, `GITHUB`), padded/whitespace variants, `null`, numbers, objects
  and the empty string all return `null`. The gate does **not** case-fold or trim — a soft comparison
  would create duplicate buckets (`google` vs `Google`) and double an attacker's budget.
* **Subject boundaries.** A `sub` that is missing, not a string, or an empty/whitespace-only string
  yields `null`. Strings up to 5000 chars are accepted verbatim (no truncation, no re-encoding),
  including unicode. `__proto__` and duplicate JSON keys produce plain data values — never prototype
  mutation.
* **Payload hostile shapes.** Non-object payloads (`null`, `"string"`, `42`, `[]`) are rejected;
  malformed base64url and invalid JSON are swallowed by the internal `try/catch` and surface as
  `null`, never as a thrown error.
* **Exactly three segments.** A token with a parseable payload is still rejected when it has 2, 4 or
  5 segments, or a trailing dot. (These cases are the payload-valid variants that a loosened
  `parts.length` check would otherwise let through — see mutation M3 in §5.)

### 2.2 Middleware contract

* Every invocation increments `attempts` **exactly once**, whether or not the request was
  identifiable, and whether or not a limiter later rejected it.
* A rejection increments `rejections` exactly once and is attributed to the branch that produced it
  (per-sub or IP fallback).
* `rejections <= attempts` always holds, including after interleaved mixed sequences.
* `next()` is called exactly once per request with the argument it received — `next()`,
  `next(undefined)`, `next(null)`, `next('route')` and `next('router')` are **not** rejections; any
  other non-nullish argument (`Error` instances, arbitrary strings/objects) **is** one. The same
  matrix holds on both branches.
* `req.socialProviderSub` is attached **only** when a subject was extracted, and the 429 response
  reuses the configured generic message without echoing the token, subject or provider.
* A store that throws does not take the request down: the attempt is still counted, no rejection is
  recorded, and the failure propagates to `next(err)` for the upstream error handler.
* Reset helpers affect only the limiter store, never the metrics pair.
* Wiring defaults: `limit = 10`, `windowMs = 900000` (15 min), `ipFallbackLimit = 20`,
  `keyPrefix = 'social-anti-enum:sub' | 'social-anti-enum:ip'`, shared `store` — and an omitted
  options object falls back to those documented defaults.

---

## 3. Test inventory

Eight `describe` blocks, **77 tests** (`109` including the pre-existing suite, which runs in the same
gate):

| Describe block | Starts at | What it pins |
| --- | --- | --- |
| `extractProviderSub — provider gate (line 90)` | `130` | G1: allow-list only, case variants, whitespace/padding, empty & absent `:provider` param, `__proto__`/object providers, no invented fallback key |
| `extractProviderSub — idToken type gate (line 91)` | `179` | G2: `null`/`undefined`, numbers/booleans, objects/arrays, typed arrays, whitespace-only strings |
| `extractProviderSub — structure gate (line 94)` | `229` | G3: 1/2/4/5-segment tokens, trailing dot, unparseable payloads, **payload-valid multi-segment tokens** |
| `extractProviderSub — sub boundaries and hostile payloads` | `301` | `sub` type/size boundaries (5000 chars), unicode, `__proto__` & duplicate keys, `null`/string/number/array payloads (no prototype pollution, no throws) |
| `getSocialAntiEnumerationMetrics — snapshot contract` | `364` | fresh object per call, store-independence, process-wide sharing across instances, `rejections <= attempts` |
| `metrics — accounting when provider/sub extraction fails` | `422` | one `attempts` per request; exactly one `rejections` per rejected request on both branches; mixed-sequence alignment; reset independence; failing store degrades without throwing |
| `extraction failure — routing, rate limiting and leakage` | `549` | unidentifiable requests are limited per IP; `req.socialProviderSub` is never attached; the 429 body leaks no token/sub/provider |
| `middleware wiring — limiter options and next() accounting` | `657` | limiter options & defaults, shared store, `next()` route/request-signal matrix on both branches, default delegation to the real limiter factory |

### 3.1 How the suite stays honest

* **No production change.** The suite observes the module only through its exported surface
  (`extractProviderSub`, `getSocialAntiEnumerationMetrics`, `createSocialAntiEnumerationMiddleware`,
  `createSocialAntiEnumerationMiddlewareWithStore`, the reset helpers).
* **Limiter interception without mocking behaviour away.** `jest.mock('./rateLimit', factory)` is used
  with a factory that **delegates to `jest.requireActual`** by default, so every suite except the
  wiring one exercises the real limiter. Only the wiring suite swaps in a capturing implementation
  (to read the limiter options and to drive `next()` with arbitrary arguments) and restores the
  delegate in `afterEach`. A `jest.spyOn` approach was tried first and abandoned: the spy did not
  reach the call site because the middleware captures the factory at import time.
* **Fresh store per request** (`InMemoryRateLimitStore`) so windows never leak between assertions,
  while the metrics pair is deliberately **process-wide** and asserted as such.
* **Assertions are on observable output**, not internals: `next()` arguments, response status/body,
  headers, and the metrics snapshot.

---

## 4. Gates and evidence

All commands were run from the repo root on the branch tip (`fix/1060-social-anti-enumeration-regression`).

| Gate | Command | Result |
| --- | --- | --- |
| Focused suite **+ coverage thresholds** | `npm run test:coverage:social-anti-enum` | **exit 0** — `Test Suites: 2 passed`, `Tests: 109 passed, 109 total`; file coverage `100 / 100 / 100 / 100` against a `95` threshold |
| Threshold is load-bearing | same command, previous revision (before the payload-valid segment cases) | **exit 1** — `branches 89.18 < 95`, i.e. the gate genuinely fails when coverage drops |
| Lint (new file only) | `npx eslint src/middleware/socialAntiEnumerationMiddleware.regression.test.ts` | **exit 0** — 0 errors, 0 warnings |
| Type-check | `npx tsc --noEmit` | 250 pre-existing errors repo-wide, **0** of them mention the new file (and `tsconfig.json` includes `src/**/*.ts`, so the file really is checked) |
| Repo-wide lint | `npm run lint` | 2257 errors / 8 warnings, **all pre-existing**; the new file appears 0 times in the report |
| Mutation testing | 7 mutants, see §5 | **7 / 7 killed** |
| Pre-existing suite | `npx jest src/middleware/socialAntiEnumerationMiddleware.test.ts` | 32 passed, untouched by this PR |

Coverage table produced by the gate command:

```
File                                | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
All files                           |     100 |      100 |     100 |     100 |
 socialAntiEnumerationMiddleware.ts |     100 |      100 |     100 |     100 |
```

### 4.1 Pre-existing failures elsewhere in the suite (not caused by this PR)

A repo-wide `npx jest --ci --silent` run on the branch tip reports **39 failing suites**, none of them
touched by this PR. Representative causes, quoted from that run:

* `src/routes/health.test.ts` — `dependency graph security › exposes only safe Stellar metadata without
  leaking upstream details`: `expect(response.body.checks[1].details.url).toBeDefined()` receives
  `undefined`.
* `src/services/__tests__/distributionScheduler.test.ts` — `ReferenceError:
  AdvisoryLockNotAvailableError is not defined` (`distributionScheduler.ts:846`).
* `src/services/fxConversionEngine.test.ts` — bucket rounding mismatch (`Expected: "1.25"`).
* `src/routes/compliance.test.ts` — role/403 expectation mismatch.
* The remainder are DB-/Redis-backed integration suites (`src/db/**`, `src/routes/**`,
  `src/__tests__/chaos/**`, `e2e-happy-path`, `openapi*`) that need services this workstation does not
  run.

<details>
<summary>Full list of the 39 pre-existing failing suites</summary>

```
src/__tests__/chaos/horizonBadSeqChaos.test.ts
src/__tests__/chaos/horizonChaos.test.ts
src/__tests__/e2e-happy-path.test.ts
src/__tests__/openapi.test.ts
src/__tests__/openapi-conformance.test.ts
src/__tests__/p99-latency-budgets.test.ts
src/__tests__/stellarRpcFailure.integration.test.ts
src/auth/register/__tests__/roundtrip.test.ts
src/db/migrate.test.ts
src/db/migrations/__tests__/migrationRoundtrip.test.ts
src/db/migrations/__tests__/schemaEvolutionRoundtrip.test.ts
src/db/repositories/balanceSnapshotRepository.test.ts
src/db/repositories/sessionRepository.explain.test.ts
src/lib/__tests__/errors.property.test.ts
src/lib/__tests__/pressureGauge.test.ts
src/middleware/__tests__/rateLimitMiddleware.property.test.ts
src/routes/__tests__/mobileCompanion.test.ts
src/routes/__tests__/notifications.consumer.test.ts
src/routes/admin.test.ts
src/routes/adminWebhooks.test.ts
src/routes/compliance.test.ts
src/routes/health.test.ts
src/routes/investments.test.ts
src/routes/ledgerExportStream.test.ts
src/routes/ledgerRoutes.test.ts
src/routes/notificationPreferences.test.ts
src/routes/notifications.test.ts
src/routes/offeringSync.test.ts
src/routes/revenueRoutes.test.ts
src/routes/startupAuthBruteForce.test.ts
src/routes/webhooks.test.ts
src/services/__tests__/distributionScheduler.test.ts
src/services/__tests__/sanctionsListDiffService.test.ts
src/services/disputeRefundService.test.ts
src/services/fxConversionEngine.test.ts
src/services/offeringSyncService.test.ts
src/services/payoutDriftDetector.test.ts
src/services/sanctionsListDiffService.test.ts
src/services/stellarSubmissionService.simple.test.ts
```

</details>

**Why these cannot be caused by this PR.** `git diff --stat origin/master` for this branch lists only
an added test file, one `package.json` script and this document — **no production module is modified**,
and nothing in the repository imports the added test file. Jest gives every test file its own module
registry, so those suites execute byte-identical code with and without this PR.

**Spot-check (empirical).** A pristine `origin/master` worktree (detached at `2995ef41`, removed
afterwards) was used to run three sampled failing suites
(`src/services/fxConversionEngine.test.ts`, `src/routes/compliance.test.ts`,
`src/services/__tests__/sanctionsListDiffService.test.ts`) side by side with the branch tip:

| Tree | Result |
| --- | --- |
| Branch tip (this PR applied) | `Test Suites: 3 failed, 3 total` / `Tests: 40 failed, 145 passed, 185 total` |
| Pristine `origin/master` (`2995ef41`) | `Test Suites: 3 failed, 3 total` / `Tests: 40 failed, 145 passed, 185 total` |

Identical failure counts on both trees — the failures are pre-existing and unrelated.



---

## 5. Mutation results (do the tests actually bite?)

Seven source mutants were applied in turn to `src/middleware/socialAntiEnumerationMiddleware.ts` and
the regression suite re-run. Every mutant was killed; the file was restored between mutants (verified
with `git diff --stat src/middleware/socialAntiEnumerationMiddleware.ts` → empty).

| ID | Line | Mutation | Outcome | First tests that fail |
| --- | --- | --- | --- | --- |
| M1 | 90 | provider allow-list gate disabled (`if (false)`) | **killed** — 10 failed / 77 | provider gate: unsupported provider, case variants, whitespace/padding, empty provider |
| M2 | 91 | `typeof idToken !== 'string'` gate disabled | **killed** — 6 failed / 77 | type gate: `null`/`undefined`, numeric/boolean, object/array, typed-array tokens |
| M3 | 94 | `parts.length !== 3` loosened to `parts.length === 0` | **killed** — 4 failed / 77 | structure gate: 2-segment, 4-segment, 5-segment, trailing-dot tokens (all with a *parseable* payload) |
| M4 | 202 | attempt counter no longer incremented | **killed** — 22 failed / 77 | snapshot contract (process-wide sharing, `rejections <= attempts`), attempts accounting |
| M5 | 217 | per-sub rejection no longer counted | **killed** — 9 failed / 77 | per-sub rejection accounting, mixed-sequence alignment, `rejections <= attempts` |
| M6 | 58 | snapshot hardcodes `attempts: 0` | **killed** — 22 failed / 77 | snapshot contract, attempts accounting |
| M7 | `ipFallbackLimit` default | `20` → `10` | **killed** — 2 failed / 77 | wiring defaults, omitted-options defaults |

M3 is the reason §2.1 lists the "payload-valid multi-segment" cases explicitly: a plausible loosening of
the segment check survives if the only extra-segment fixtures have an unparseable middle segment (the
JSON parse then returns `null` for the wrong reason). The suite therefore uses fixtures whose segment 2
is a valid `{"sub": …}` payload, so only the real gate can reject them.

---

## 6. Security notes and abuse paths

* **Enumeration oracle.** `attempts` is the numerator alerting uses. It must count *unidentifiable*
  requests too, otherwise a client that strips the provider/`idToken` shape flies under the metric while
  still probing the login endpoint (M4 covers this).
* **Bucket forgery.** G1 is exact-match only: no case folding, no trimming. `Google`, `GITHUB ` and
  `__proto__` never become subjects (prototype keys would otherwise land in a lookup table/keyed store).
* **Token reflection.** The rejection body reuses the configured generic message
  (`Too many requests, please try again later.`). Tests assert the 429 body contains no `sub`, no token,
  no provider.
* **Route/request signals are not rejections.** `next('route')` / `next('router')` mean "try the next
  handler", not "client rejected". Treating them as rejections would inflate alerting and (via
  downstream handlers) mis-attribute rate-limit pressure; the matrix in §2.2 is asserted on **both**
  limiter branches.
* **Failure is soft, not fatal.** A throwing store must not 500 the login route or silently drop the
  attempt: the attempt is counted, no rejection is recorded, and the error is forwarded to `next(err)`.
* **No state bleed.** Resetting the limiter store does not reset the process-wide metrics pair (the
  opposite regression would let an attacker clear the counter), and each request uses a fresh store in
  tests so window boundaries never mask an accounting bug.
* **PII-free instrumentation.** `sub` values are used only to derive a limiter key; the suite asserts
  `req.socialProviderSub` exists only for identifiable requests and that it is never attached to
  unidentifiable ones (a leak would let a downstream handler log/enumerate subjects).

---

## 7. Known limitations and follow-ups

* **Metrics are process-local.** `attempts`/`rejections` live in module state, so multi-replica
  deployments need aggregation at scrape time. The suite pins the in-process contract only.
* **No clock manipulation.** Tests rely on fresh stores/windows rather than `jest.useFakeTimers()`, so
  window *expiry* semantics stay covered by `rateLimit.test.ts` (which exercises the store directly).
* **Repo CI does not run on this branch.** `.github/workflows/ci.yml` and `rbac-policy-diff.yml` filter
  `on.pull_request.branches: ["main"]`, but the default branch is `master`, so the `audit` and
  `alert-mappings` jobs never execute for PRs against `master`. Fixing that workflow filter is a
  separate, repo-scoped change (out of scope for a test-only PR, and it would also need to add a test
  step, which CI currently does not have). The gates in §4 were therefore run locally.
* **Repo-wide lint is red on `origin/master`.** `npm run lint` reports 2257 errors / 8 warnings across
  the existing tree; this PR adds none (the new file does not appear in the report). No file is
  auto-fixed here — that would flood the diff.
* **Relationship to #1027.** The earlier `fix/1027-user-failure-handling-regression` branch was the
  previous deliverable in this workspace; it targets `UserRepository` failure handling, not social
  anti-enumeration, so it is deliberately left untouched here (and #1027 is not closed by this PR).

