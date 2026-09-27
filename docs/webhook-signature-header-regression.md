# Webhook Signature Header — Regression Coverage (issue #1051)

Focused regression suite for the `WEBHOOK_SIGNATURE_HEADER` failure and
empty-result paths in [`src/lib/webhookSignature.ts`](../src/lib/webhookSignature.ts).

- **Implementation under test:** `src/lib/webhookSignature.ts` (unchanged)
- **New tests:** `src/lib/webhookSignature.regression.test.ts`
- **Surrounding suite:** `src/lib/webhookSignature.test.ts`
- **Type of change:** test-only. The public contract is pinned, not modified.

## 1. Why this suite exists

Header extraction and expiry parsing both have explicit "no result" exits
(`return undefined`). Without a regression suite, a refactor can silently turn a
"missing signature" into a "verification failed", or make a malformed rotation
deadline behave differently — both are behaviour changes that webhook receivers
would observe only in production.

| Evidence (pre-change)                 | Branch exercised                                        | Covered by |
| ------------------------------------- | ------------------------------------------------------- | ---------- |
| `src/lib/webhookSignature.ts:156`     | `extractSignatureFromHeaders` → `undefined` (no match)  | *"extractSignatureFromHeaders — empty-result path"* |
| `src/lib/webhookSignature.ts:214`     | `parseExpiryTimestamp` → `undefined` (unset/empty)      | *"returns undefined for unset expiry values"* |
| `src/lib/webhookSignature.ts:218`     | `parseExpiryTimestamp` → `undefined` (invalid `Date`)   | *"returns undefined for an invalid Date instance"* |
| `src/lib/webhookSignature.ts:221`     | `parseExpiryTimestamp` → `undefined` (numeric `NaN`)    | *"returns undefined for a numeric NaN expiry"* |
| `src/lib/webhookSignature.ts:234`     | `parseExpiryTimestamp` → `undefined` (foreign type)     | *"returns undefined for out-of-contract runtime types"* |
| `src/lib/webhookSignature.ts:470-481` | `verifyWebhook` → `MISSING_SIGNATURE` error contract    | *"verifyWebhook — missing WEBHOOK_SIGNATURE_HEADER failure contract"* |

## 2. Contract rules pinned by the suite

All of the following describe **existing** behaviour; the tests exist so a change
to any of them fails CI and becomes a reviewed decision.

1. **Wire header name is `x-revora-signature` and lower-case.** The same
   constant is used for outbound signing (`src/services/webhookService.ts`) and
   inbound extraction, and extraction performs an exact (case-sensitive) map
   lookup. Renaming or re-casing it would break every receiver at once.
2. **"Header not found" is `undefined`.** It is returned for: no candidate
   headers, candidates present but `undefined`/`null`, empty arrays, and
   non-string values. A **mixed-case key** in the map is an intentional miss —
   Node/Express lower-case inbound header names before they reach the helper.
3. **An empty string is returned verbatim.** The helper only guarantees "a
   string was found"; `verifyWebhook` and the `webhookAuth` middleware are the
   layers that convert a falsy value into `MISSING_SIGNATURE`.
4. **`MISSING_SIGNATURE` is deterministic and non-leaking.** Empty headers, empty
   arrays, empty strings, unusable first-array entries and absent custom header
   names all produce `code: 'MISSING_SIGNATURE'` with the message
   `Missing signature header: <headerName>`; no key material is included.
5. **Failure ordering is fixed:** oversized payload (line 458) → missing
   signature (line 473) → unusable key material (line 490) → timestamp/replay
   window (line 513). The suite asserts the two orderings a caller can observe:
   `INVALID_FORMAT` (payload) beats `MISSING_SIGNATURE`, and
   `MISSING_SIGNATURE` beats the timestamp error.
6. **`parseExpiryTimestamp` "unset" is `undefined`**: `undefined`, `null`, `''`,
   whitespace-only, invalid `Date`, numeric `NaN`, unparseable date strings and
   out-of-contract runtime types (boolean/object/array/function).
7. **`0` is a valid deadline, not "unset".** `parseExpiryTimestamp(0)` and
   `'0'` return `0` — an already-elapsed epoch deadline.
8. **Seconds/milliseconds cut-off is `1e11`, inclusive on the ms side.**
   `1e11 - 1` → `(1e11 - 1) * 1000`; `1e11` → `1e11`. The numeric-string branch
   is anchored (`^\d+$`), so `'1700000000.5'` and `'1700000000seconds'` are
   `undefined` rather than silently truncated.

## 3. Security assumptions and abuse/failure paths

| Assumption / abuse path | Expected behaviour | Test |
| ----------------------- | ------------------ | ---- |
| Attacker strips the signature header | `MISSING_SIGNATURE`, request rejected, no key material echoed | *"emits MISSING_SIGNATURE for empty headers"*, *"does not leak the shared secret in the failure payload"* |
| Attacker sends duplicate/empty header values (header smuggling) | only the **first** array entry is used; an unusable first entry yields `MISSING_SIGNATURE` and a later duplicate never rescues it | *"emits MISSING_SIGNATURE when the first array entry is unset"* |
| Attacker relies on "no header" meaning "skip verification" | never — the branch returns an explicit error, never `valid: true` | *"emits MISSING_SIGNATURE for empty headers"* |
| Attacker floods a huge body hoping the signature check is skipped | the payload-size check runs first and is authoritative (`INVALID_FORMAT`) | *"reports the oversized payload before the missing signature"* |
| Attacker omits the timestamp to dodge replay protection | the signature check still runs first; a missing signature is reported as `MISSING_SIGNATURE` | *"reports the missing signature before the missing timestamp"* |
| Mis-wired caller builds a header map with mixed-case keys | deterministic `undefined` → `MISSING_SIGNATURE` (fail closed) | *"returns undefined for a mixed-case header key"* |
| Signature string of equal character length but different UTF-8 byte length | constant-time comparison failure is swallowed → `false` (no unhandled `RangeError`) | *"fails closed for a same-length signature with multi-byte characters"* |

### Known, deliberately pinned behaviour (follow-up candidates)

These are **not** changed by this PR; they are pinned so any future change is
explicit and reviewable:

- **Unparseable `nextSecretExpiry` fails open.** `parseExpiryTimestamp('not-a-date')`
  → `undefined` → `isExpired === false` → the rotated (`nextSecret`) key keeps
  verifying signatures indefinitely. Operators must remove a retired secret from
  configuration explicitly instead of relying on a malformed expiry to retire it.
- **Non-finite numbers are not treated as "unset".** `isNaN(Infinity) === false`,
  so `parseExpiryTimestamp(Infinity)` returns `Infinity`, i.e. a never-expiring
  deadline in the dual-key flow.
- **Negative numeric deadlines are scaled by 1000** because they take the
  epoch-seconds branch; they remain far in the past, so the practical effect is
  unchanged.
- **`signOutboundPayload` / the outbound overlap window** is exercised only for
  its neighbouring normal path; the outbox dispatcher owns end-to-end delivery
  coverage.

## 4. Exercised cases and results

Runtime: Node `20.x`, Jest via `ts-jest` (`jest.config.js`), run from the repo
root. Every number below is a measured result, not an estimate.

| # | Command | Result |
| - | ------- | ------ |
| 1 | `npx jest src/lib/webhookSignature.regression.test.ts` | **50/50 passed** (1 suite) — the new focused suite |
| 2 | `npm run test:coverage:webhook-signature` (new script: new suite + `src/lib/webhookSignature.test.ts` + `outboxHmacRotationService.test.ts`) | **190/190 passed** (3 suites); `src/lib/webhookSignature.ts` coverage: **100% statements, 97.29% branches, 100% functions, 100% lines** (partially covered branch lines: 458, 500, 515) |
| 3 | `npx jest src/lib/webhookSignature.test.ts src/lib/webhookSignature.regression.test.ts src/middleware/webhookAuth.test.ts src/services/webhookService.test.ts src/services/__tests__/outboxDispatcher.test.ts src/services/__tests__/outboxHmacRotationService.test.ts --coverage=false` | **334/334 passed** (6 suites) — the full "surrounding suite" of every module that consumes the header constant |
| 4 | `npx eslint src/lib/webhookSignature.regression.test.ts` | **0 problems** (repository-wide `npm run lint` still reports its pre-existing backlog; the new file adds none) |
| 5 | `npx tsc --noEmit` | **250 errors before and after** this change (identical set); **none** in `src/lib/webhookSignature.ts` or the new test file |
| 6 | `npm run validate:alert-mappings` | `OK: All 22 known alerts have mapping entries.` |
| 7 | `npm run audit:ci` | Fails **identically with and without** this change (pre-existing advisories: `express`, `qs` moderate; `stellar-sdk`, `toml` high) |
| 8 | `npx jest src/routes/health.test.ts` on pristine `master` | **1 failed, 73 passed** at `src/routes/health.test.ts:1126` (*"dependency graph security › exposes only safe Stellar metadata without leaking upstream details"*) — pre-existing and unrelated; reproduced with every branch change stashed |

### Per-evidence-line results

| Evidence line | Case | Observed value |
| ------------- | ---- | -------------- |
| `:156` | `extractSignatureFromHeaders` with no header / unset / `[]` / non-string / `null` / mixed-case key | `undefined` in every case |
| `:156` | neighbouring normal path: candidate priority, every supported header name, empty string | first non-empty candidate; `''` returned verbatim |
| `:214` | `parseExpiryTimestamp(undefined \| null \| '')` | `undefined` |
| `:218` | `new Date('not-a-date')` | `undefined` |
| `:221` | numeric `NaN` | `undefined` |
| `:234` | `true \| {} \| [] \| () => {}`, whitespace-only and unparseable strings | `undefined` |
| `:221` + dual-key flow | next-key verification with unparseable / `NaN` expiry | next-key signature accepted (pinned fail-open); a passed deadline flips `nextKeyExpired` to `true` |
| missing-signature exit | empty/unset/empty-array/empty-string/custom-name-absent headers, oversized payload, missing timestamp, falsy payload | deterministic `MISSING_SIGNATURE` (or `INVALID_FORMAT` first), no secret in the payload |
| signature-container boundaries | non-string first array entry, non-string value, equal-length multi-byte value | `false` (fail closed, no thrown `RangeError`) |

## 5. Residual risk and follow-ups

1. **Repository-wide gates are already red on `master`.** `npm run build`
   (250 `tsc` errors), `npm run lint` (2257 pre-existing errors) and
   `npm run audit:ci` (4 advisory classes) all fail without this change; this PR
   is test-only and neither introduces nor repairs them. CI (`ci.yml`) runs only
   `npm ci` + `audit:ci` + `validate:alert-mappings`, so its `audit` job is red
   on the base revision for reasons outside this change's scope.
2. **`src/routes/health.test.ts:1126` is failing on `master`** (verified with all
   branch changes stashed). It is unrelated to the header contract, but it means
   a repository-wide `npm test` is not green today; it is deliberately left
   untouched to keep this change reviewable.
3. **Fail-open on an unparseable `nextSecretExpiry` remains** (pinned, not
   fixed). A rotation owner who writes `nextSecretExpiry: 'soon'` keeps the
   outgoing key valid forever. A fail-closed variant (`undefined` ⇒ treat as
   expired) would be a deliberate breaking change and needs a migration note.
4. **`Infinity` / negative numeric deadlines**: `Infinity` means "never expires",
   and negatives are multiplied by 1000 (seconds branch) before being discarded
   as "long past". Both are pinned so a future hardening PR has a red test to
   update rather than a silent semantic shift.
5. **Constant-time comparison guard.** `crypto.timingSafeEqual` throws
   `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` for equal-length strings with different
   UTF-8 byte lengths; the existing defensive `catch` converts that to `false`.
   The new test fails if the catch is ever removed, so the behaviour cannot
   regress silently — but the mismatch is only defended in-process.
6. **Header-name case sensitivity.** Extraction relies on Node/Express
   lower-casing inbound header names. Any future path that hands the helper a
   map built elsewhere (proxy, bridge service, raw `node:http` server) must
   lower-case keys itself or the lookup misses — fail closed, yet operationally
   silent.
7. **No live HTTP-level assertion.** The suite pins the library contract;
   end-to-end delivery and key-overlap behaviour stay with the outbox dispatcher
   and webhook service suites, which are included in the "surrounding suite" run
   above but do not assert the wire header byte-for-byte.
8. **Coverage is measured on three suites, not the whole repository.** The
   reported 97.29% branch figure is for `src/lib/webhookSignature.ts` only,
   collected via `--collectCoverageFrom`; the global thresholds in
   `jest.config.js` are unchanged.

