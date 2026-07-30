# Stryker Mutation Testing: Payout and Reconciliation Modules

## Overview

This document describes the Stryker mutation testing configuration and results for three payout/reconciliation modules:

- `src/services/distributionEngine.ts` — Batch distribution engine with proration, rounding, and Stellar RPC integration
- `src/services/revenueReconciliationService.ts` — Revenue reconciliation with on-chain drift detection and investor allocation validation
- `src/services/payoutDriftDetector.ts` — Periodic drift detection with on-chain verification, metrics, and alarm management

These modules handle financial payout logic, making mutation testing essential to ensure that test assertions are strong enough to detect subtle bugs in arithmetic, conditional logic, and error handling.

## Configuration

### Files

| File | Purpose |
|------|---------|
| `stryker.config.json` | Main Stryker configuration (appended to existing auth/signature targets) |
| `jest.stryker.config.js` | Dedicated Jest config (appended test patterns for the three modules) |

### Key Settings

| Setting | Value |
|---------|-------|
| **Test Runner** | Jest (custom project) |
| **Coverage Analysis** | Per-test |
| **Concurrency** | 4 workers |
| **Timeout** | 30 seconds per mutant |
| **Thresholds (break)** | 70% overall mutation score |
| **Thresholds (low)** | 75% |
| **Thresholds (high)** | 95% |

## How to Run

### Run Stryker mutation testing on all 6 modules

```bash
npx stryker run --concurrency 4
```

### Run Stryker on payout modules only

```bash
npx stryker run \
  --mutate "src/services/distributionEngine.ts,src/services/revenueReconciliationService.ts,src/services/payoutDriftDetector.ts" \
  --concurrency 4
```

### Run only the targeted unit tests

```bash
npx jest --testPathPatterns='(distributionEngine|revenueReconciliationService|payoutDriftDetector)\\.test\\.ts$'
```

### Run full test suite

```bash
npm test
```

## Current Scores (Last Run: 2026-07-30)

| Module | Mutation Score | Covered Score | Killed | Timeout | Survived | No Coverage | Errors |
|--------|:------------:|:------------:|:------:|:------:|:--------:|:----------:|:------:|
| **All payout modules** | **42.04%** | **52.70%** | **448** | **40** | **415** | **170** | **2** |
| `distributionEngine.ts` | **40.39%** | **62.41%** | **158** | **8** | **100** | **145** | **0** |
| `revenueReconciliationService.ts` | **54.12%** | **54.12%** | **224** | **32** | **217** | **0** | **0** |
| `payoutDriftDetector.ts` | **34.92%** | **40.24%** | **66** | **0** | **98** | **25** | **2** |

### Score Interpretation

- **distributionEngine.ts (40.39%)**: Lowest covered score (62.41%) due to 145 uncovered mutants (35%). Most survivors are StringLiteral mutations on log messages, error context objects, and conditional branches for notification fan-out (which depend on optional repos/pool). The property-based rounding tests are strong but don't cover all edge cases for the notification paths.

- **revenueReconciliationService.ts (54.12%)**: Highest score of the three. Zero no-coverage mutants — every line is covered by at least one test. Surviving mutants are predominantly StringLiteral (log messages, discrepancy fields) and ConditionalExpression (guard clauses, status checks). The 32 timed-out mutants suggest some slow integration-style tests approach the 30s limit.

- **payoutDriftDetector.ts (34.92%)**: Lowest total score. Heavy reliance on MetricsCollector (gauges, counters, histograms) and logger — most surviving mutants are ObjectLiteral on metric labels and logger context. 25 no-coverage mutants from lifecycle methods (`stop()`, `shortLabel()`, etc.) not fully covered. 2 errors from the `onCycle` catch handler when logger is undefined under mutation.

## Surviving Mutant Analysis

### Logging / StringLiteral Mutants (Most Common)

The largest category of surviving mutants across all three modules:

- Logger calls (`this.logger.info(...)`, `this.logger.error(...)`, `this.logger.warn(...)`)
- Error/discrepancy message strings (`message: \`Revenue mismatch...\``, `severity: 'error'`)
- Metric label keys and offering_id values
- Status strings (`'completed'`, `'processing'`, `'pending'`)
- Error context objects (empty `{}` replaces structured log context)

These are difficult to kill without adding assertion logic that inspects logged output or verifies exact error message content. In production, StringLiteral mutants in log messages don't affect correctness.

### Conditional / Equality Operator Mutants

Survivors include:

- Boundary comparisons: `>`→`>=`, `<`→`<=`, `!==`→`===`
- Short-circuit: `&&`→`||`, `||`→`&&`
- Boolean negation: `!this.pool`→`this.pool`, `!condition`→`condition`
- Some boundary conditions lack edge-case tests (e.g., drift threshold exact hours, tolerance boundaries)

### Blocks and Method Expression Mutants

- Empty-block survivors on `catch` handlers (tests don't assert on catch behavior)
- `filter`→identity, `map`→undefined — survive when the test uses the same result as non-mutated code
- Whole-method removal survives on `shortLabel()`, `emitAggregatedMetrics()`, `isValidDistributionStatus()` — these private helpers have indirect coverage but no direct assertion

### Arithmetic Operator Mutants

- `+`→`-` in `totalMissing += count` survives — tests check exact totals but some use zero-Drift data
- `/`→`*` in `oldestAgeHours = (Date.now() - created) / 3600000` survives — only exercised through non-zero drift paths
- `+`→`-` in Date arithmetic for duration calculation — all tests check `toHaveBeenCalled` but not the exact value

### No-Coverage Mutants (distributionEngine.ts: 145, payoutDriftDetector.ts: 25)

Uncovered code includes:

- `fanOutNotifications()`: skipped when repos/pool are null; test setups don't provide all dependencies
- `stop()` lifecycle method: only tested for interval clearing, not for the full cleanup path
- `shortLabel()`: edge case when split produces empty parts (nullish coalescing alternate)
- Constructor option fallbacks for `options.intervalMs`, `options.driftThresholdHours`

## Improving Scores

To further improve mutation scores, consider:

1. **Add log assertion tests**: Use `jest.spyOn(logger, 'info')` to verify log messages for each code path, especially in error handling and lifecycle methods.
2. **Metric assertion tests**: Assert exact metric labels and values for `MetricsCollector.incrementCounter`, `setGauge`, and `recordHistogram`.
3. **Boundary condition tests**: Add tests exactly at boundary values (drift threshold hours, tolerance 0.01, exactly > 0.01, etc.).
4. **Full dependency injection**: Tests for `fanOutNotifications` and `emitAggregatedMetrics` with all optional dependencies provided.
5. **Catch-block assertions**: Verify that error handlers produce expected side-effects (discrepancies pushed, metrics recorded, errors logged).
6. **Lifecycle coverage**: Add tests for `stop()` with metrics cleanup, `start()` with timer edge cases, and `shortLabel()` with unusual offering IDs.

## Rerun Frequency

- **CI/PR gate**: Run before every PR that modifies these modules
- **Weekly**: Re-run mutation testing weekly to catch regression in test quality
- **After major refactors**: Run after any significant refactoring of the payout/reconciliation code

## Known Limitations

1. **Pre-existing TypeScript errors** in `src/services/distributionScheduler.test.ts` and `src/services/statementDataProvider.ts` prevent using the Stryker TypeScript checker.
2. **Flaky property-based test**: `distributionEngine` property-based rounding tests (`every payout >= 0 for any balances and revenue`) can fail on certain fast-check counterexamples (6 investors × 3 balance × 0.04 revenue). This is a pre-existing edge case unrelated to mutation testing.
3. **Flaky clock-skew test**: `webhookAuth` timestamp boundary test (`should reject timestamp 1ms beyond clock skew boundary`) is timing-sensitive in sandbox environments. Mitigated by using `jest.useFakeTimers()`.
4. **Logging survivors**: StringLiteral mutants in logger/metric calls are accepted as they don't affect financial correctness.
5. **Stryker child process crashes**: Mutations that cause `this.logger` to be `undefined` in `payoutDriftDetector.start()` can crash child processes. These are logged as errors and recorded in the report.

## References

- [Stryker Documentation](https://stryker-mutator.io/docs/stryker-js/)
- [Mutation Testing Guide](https://stryker-mutator.io/docs/mutation-testing-evaluation/)
- Issue: [#561 Mutation testing: expand Stryker to payout and reconciliation modules](https://github.com/Revora/Revora-Backend/issues/561)
