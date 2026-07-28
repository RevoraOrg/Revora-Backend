# Horizon Transaction-History Gap Injection and Detection

**Issue:** #518 — Stellar Horizon chaos: transaction-history gap injection and detection  
**Branch:** `test/horizon-history-gap-chaos`

---

## Overview

The Stellar Horizon `/transactions` endpoint paginates results via opaque
`paging_token` values.  In production, a Horizon node that misses a ledger close
can return pages that silently skip records — e.g., tokens `1000, 1001, 1003`
(token `1002` is missing).  An ingest layer that does not detect this will advance
its cursor past the gap and permanently lose those transactions.

This document describes:

1. The production ingest layer (`HorizonTransactionHistoryFetcher`)
2. The chaos harness (`HorizonTransactionPageFake`, `buildDeterministicGaps`)
3. The test suite (`horizonGapChaos.test.ts`)
4. Security assumptions and abuse paths

---

## Architecture

```
HorizonTransactionHistoryFetcher
│
├── fetchPage callback (injected — real SDK or test double)
├── Gap detection (BigInt paging-token arithmetic)
├── Cursor state (last clean paging_token)
├── Paused flag (set on fatal gap)
└── EventEmitter → 'audit' channel
        ├── ingest.page.ingested
        ├── ingest.page.empty
        ├── ingest.gap.detected
        ├── ingest.cursor.paused   ← fatal alert
        └── ingest.cursor.resumed
```

---

## Files Changed

| Path | Purpose |
|------|---------|
| `src/services/horizonTransactionHistoryFetcher.ts` | Production ingest service |
| `src/services/__tests__/chaos/horizonGapChaos.test.ts` | Chaos test suite (11 describe blocks, 40+ tests) |
| `src/__tests__/mocks/horizonFake.ts` | Extended with `HorizonTransactionPageFake`, `GapSpec`, `seededRandom`, `buildDeterministicGaps` |
| `src/__tests__/fixtures/chaosHelpers.ts` | Extended with `runGapChaosScenario`, `buildSeededGapFake`, `filterAuditEvents` |
| `run-chaos-tests.sh` | Added `gap` scenario entry |
| `docs/horizon-history-gap-chaos.md` | This document |

---

## Running the Tests

```bash
# Gap-injection scenario only (fast, deterministic)
./run-chaos-tests.sh gap

# All chaos tests
./run-chaos-tests.sh chaos

# Full suite with coverage
npm test -- --coverage
```

---

## HorizonTransactionHistoryFetcher

### Constructor

```typescript
new HorizonTransactionHistoryFetcher({
  fetchPage: (cursor: string, limit: number) => Promise<HorizonTransactionPage>,
  pageSize?: number,       // 1–200, default 200
  initialCursor?: string,  // default "" (start from beginning)
  haltOnGap?: boolean,     // default true — safe mode
})
```

### Gap detection algorithm

Paging tokens are monotonically increasing 64-bit integers.  After each page:

1. Compare `firstRecord.paging_token` to current `cursor`.
2. Parse both as `BigInt` (guarding against precision loss on large tokens).
3. If `firstToken > cursor + 1`, a gap exists — tokens between them are missing.
4. Scan within the page for intra-page gaps (same logic, consecutive records).
5. Return `GapDetail` on the first gap found.

Backward movement (`firstToken ≤ cursor`) is treated as a ledger reorg and is
**not** flagged as a gap — the page passes through.

### Halt and resume

When `haltOnGap: true` (default):

- Cursor is **not** advanced.
- `ingest.gap.detected` is emitted first, then `ingest.cursor.paused`.
- All subsequent `fetchNextPage()` calls return `{ paused: true }` without
  calling the upstream `fetchPage` callback — the upstream is isolated.
- Recovery is explicit: the operator calls `resumeFromCursor(token)` to
  acknowledge the gap and restart from a verified position.

When `haltOnGap: false`:

- Gap is reported via `ingest.gap.detected` only.
- Cursor advances to the last token on the page.
- Useful for monitoring-only setups that accept eventual completeness.

---

## Chaos Harness

### `HorizonTransactionPageFake`

A deterministic fake that:

- Generates sequential paging tokens starting from a configurable base.
- Accepts `GapSpec[]` — each spec names a token after which N tokens are skipped.
- Supports one-shot and permanent error injection for resilience testing.

```typescript
const fake = new HorizonTransactionPageFake(1000, [
  { afterToken: '1004', skipCount: 3 },  // tokens 1005, 1006, 1007 will be missing
]);
```

### `buildDeterministicGaps(baseToken, totalPages, pageSize, gapCount, seed)`

Generates reproducible `GapSpec[]` using the mulberry32 PRNG.  The same seed
always produces the same gap positions, making chaos scenarios stable across CI.

```typescript
const gaps = buildDeterministicGaps(1000, 10, 5, 2, /* seed */ 42);
// Always the same two gap positions for seed 42
```

### `runGapChaosScenario(pageFake, maxPages, haltOnGap, initialCursor)`

Drives a `HorizonTransactionHistoryFetcher` until it pauses (gap detected) or
exhausts all pages.  Returns all audit events and page results for assertion.

---

## Test Suite Coverage

| Suite | What is tested |
|-------|----------------|
| `seededRandom` | PRNG determinism, range, different seeds |
| `buildDeterministicGaps` | Reproducibility, ordering, skip range |
| `HorizonTransactionPageFake` | Token sequence, gap skipping, error injection, reset |
| `HorizonTransactionHistoryFetcher – gap detection` | Clean pages, inter-page gaps, event ordering, cursor isolation |
| `haltOnGap=false` | Continue-through-gap mode, event suppression |
| `Recovery: resumeFromCursor()` | Resume after close, lastGapDetail cleared, idempotency, invalid input |
| `Multiple gaps – cursor isolation` | First gap halts; second gap never reached; haltOnGap=false reports once |
| `Deterministic chaos via buildSeededGapFake` | Same seed, different seeds, pause assertion, cursor bounds |
| `Gap recovery – gap closes` | Fresh fetcher from resume cursor, no spurious events |
| `Edge cases` | Empty page, single record, reorg tokens, non-numeric tokens, reset, large gap |
| `Multi-seed sweep` | 12 seeds; each must pause, emit one paused event, cursor within bounds |

---

## Security Assumptions

1. **No auto-skip.** The fetcher never silently skips gaps; `haltOnGap: true` is
   the default.  An operator action (`resumeFromCursor`) is required for
   recovery, creating an explicit audit trail.

2. **Cursor immutability on gap.** The cursor is only written when records are
   actually ingested.  A gap page does not move the cursor, preventing phantom
   advancement.

3. **Upstream isolation on pause.** When paused, the fetcher does not call the
   upstream `fetchPage` callback — preventing repeated requests to a potentially
   malicious or unstable upstream.

4. **BigInt precision.** Gap arithmetic uses `BigInt` throughout.  JavaScript's
   53-bit `Number` would silently lose precision on tokens > 2^53, which could
   cause a real gap to appear as "no gap".  `BigInt` eliminates this attack
   surface.

5. **No raw upstream data in audit events.** Audit events carry structured
   metadata (token strings, counts) — not raw HTTP responses.  This prevents
   server-controlled strings from polluting the audit log.

6. **Deterministic test seeds.** All chaos scenarios are seeded so CI runs are
   reproducible.  Non-deterministic randomness would allow flaky passes that
   hide real gaps.

---

## Abuse and Failure Paths Validated

| Path | Test |
|------|------|
| Gap of 1 missing token | Suite 4 — inter-page gap, `missingCount: 2` (105,106) |
| Gap of 9 tokens (max skip) | `buildDeterministicGaps` edge, Suite 2 |
| Gap spanning >MAX_SAFE_INTEGER tokens | Suite 10 — very large gap clamped |
| Gap on very first page (no prior cursor) | Suite 10 — single record, no gap |
| Gap mid-page (intra-page) | Suite 7 — first gap detected within records |
| Two gaps on one page | Suite 7 — only first gap surfaces |
| Paused fetcher called again | Suite 4 — upstream not re-invoked |
| Upstream throws 503 | Suite 10 — error propagates correctly |
| Backward-moving token (reorg) | Suite 10 — not treated as a gap |
| Non-numeric token | Suite 10 — no crash, gap check skipped |
| 12-seed chaos sweep | Suite 11 — regression guard across seeds |
