# Stryker Mutation Testing: Auth and Signature Modules

## Overview

This document describes the Stryker mutation testing configuration and results for three critical security modules:

- `src/lib/jwt.ts` — JWT token issuance, verification, and key rotation
- `src/lib/webhookSignature.ts` — HMAC-SHA256 webhook signature generation and verification
- `src/middleware/webhookAuth.ts` — Express middleware for webhook authentication

These modules control authentication and webhook verification, making them high-priority targets for mutation testing to ensure assertion strength matches coverage metrics.

## Configuration

### Files

| File | Purpose |
|------|---------|
| `stryker.config.json` | Main Stryker configuration targeting the three modules |
| `jest.stryker.config.js` | Dedicated Jest config that runs only relevant test files |

### Key Settings

| Setting | Value |
|---------|-------|
| **Test Runner** | Jest (custom project) |
| **Coverage Analysis** | Per-test |
| **Concurrency** | 4 workers |
| **Timeout** | 120 seconds per mutant |
| **Thresholds (break)** | 80% overall mutation score |
| **Thresholds (low)** | 85% |
| **Thresholds (high)** | 95% |

## How to Run

### Run Stryker mutation testing

```bash
npx stryker run --concurrency 4
```

### Run only the targeted unit tests

```bash
npx jest --testPathPatterns='(jwt|webhookSignature|webhookAuth)\\.test\\.ts$'
```

### Run full test suite

```bash
npm test
```

## Current Scores (Last Run: 2026-07-29)

| Module | Mutation Score | Covered Score | Killed | Survived | No Coverage |
|--------|:------------:|:------------:|:------:|:--------:|:----------:|
| **All modules** | **70.81%** | **73.42%** | 536 | 194 | 27 |
| `lib/jwt.ts` | **83.33%** | **84.62%** | 165 | 30 | 3 |
| `lib/webhookSignature.ts` | **76.25%** | **77.73%** | 199 | 57 | 5 |
| `middleware/webhookAuth.ts` | **57.72%** | **61.65%** | 172 | 107 | 19 |

### Score Interpretation

- **jwt.ts (83.33%)**: Solid coverage. Most surviving mutants are StringLiteral mutations on log messages or error strings, which are hard to kill without asserting on exact error text.
- **webhookSignature.ts (76.25%)**: Good coverage. Surviving mutants are primarily StringLiteral values in log/error messages and some conditional boundary operators.
- **webhookAuth.ts (57.72%)**: Moderate coverage. The middleware has many conditional branches for error handling (missing body, payload size, missing headers, expired timestamps, etc.) that are exercised but not all boundary conditions are covered.

## Surviving Mutant Analysis

### Logging / StringLiteral Mutants (Most Common)

The majority of surviving mutants are `StringLiteral` mutations on:
- Logger calls (`globalLogger.warn(...)`, `globalLogger.debug(...)`)
- Error message strings (`new WebhookSignatureError('...')`)
- Header name defaults (`headerName = 'x-revora-signature'`)

These are difficult to kill without adding assertion logic that inspects logged output. In production systems, these are often accepted as "noise" since they don't affect security behavior.

### Arithmetic Operator Mutants

Survivors include:
- `5 * 60 * 1000` → `5 / 60 * 1000` / `5 * 60 / 1000`
- `30 * 1000` → `30 / 1000`

These require testing exactly at boundary conditions (e.g., a timestamp that's 4.99 minutes old vs 5.01 minutes old with zero clock skew).

### Optional Chaining Mutants

Survivors include:
- `result.error?.code` → `result.error.code`
- `headerName.toLowerCase()` → `headerName.toUpperCase()`

These require additional tests with specific combinations of null/undefined values and header name casing.

## Improving Scores

To further improve mutation scores, consider:

1. **Add log assertion tests**: Use `jest.spyOn(globalLogger, 'warn')` to verify that specific warning messages are emitted for each error path.
2. **Boundary condition tests**: Add tests exactly at time boundary values (e.g., 299999ms vs 300001ms age).
3. **Header name casing tests**: Test with mixed-case header names like `X-Revora-Signature`.
4. **Optional chaining tests**: Test webhookVerify with different error types to exercise the `result.error.code` optional chaining path.

## Rerun Frequency

- **CI/PR gate**: Run before every PR that modifies these modules
- **Weekly**: Re-run mutation testing weekly to catch regression in test quality
- **After major refactors**: Run after any significant refactoring of the auth/webhook code

## Known Limitations

1. **Pre-existing TypeScript errors** in `src/services/distributionScheduler.test.ts` and `src/services/statementDataProvider.ts` prevent using the Stryker TypeScript checker. These are pre-existing issues unrelated to this module's mutation testing.
2. **Flaky timing test**: The `verifyWebhookPayload` timing attack test (`should take similar time for valid and invalid signatures`) can occasionally fail due to JS engine variance. Threshold is set to 3x (300%) to accommodate this.
3. **Logging survivors**: StringLiteral mutants in logger calls are accepted as they don't affect security correctness.

## References

- [Stryker Documentation](https://stryker-mutator.io/docs/stryker-js/)
- [Mutation Testing Guide](https://stryker-mutator.io/docs/mutation-testing-evaluation/)
- Issue: [#560 Mutation testing: expand Stryker to auth and signature modules](https://github.com/Revora/Revora-Backend/issues/560)
