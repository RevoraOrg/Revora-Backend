# Horizon Transaction-History Gap Injection and Detection

**Issue:** [#706](https://github.com/RevoraOrg/Revora-Backend/issues/706) — Stellar Horizon chaos: transaction-history gap injection and detection  
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
├── fetchPage callback (injected — real SDK, createHorizonHttpFetchPage, or test double)
├── Gap detection (BigInt paging-token arithmetic)
├── Cursor state (last clean paging_token)
├── Paused flag (set on fatal gap)
└── EventEmitter → 'audit' channel
        ├── ingest.page.ingested
        ├── ingest.page.empty
        ├── ingest.gap.detected
        ├── ingest.cursor.paused   ← fatal alert (severity=fatal, alarm=horizon_history_gap)
        └── ingest.cursor.resumed
```

---

## Files

| Path | Purpose |
|------|---------|
| `src/services/horizonTransactionHistoryFetcher.ts` | Production ingest service + `createHorizonHttpFetchPage` |
| `src/__tests__/chaos/horizonGapChaos.test.ts` | Chaos test suite (deterministic per seed) |
| `src/__tests__/mocks/horizonFake.ts` | `HorizonTransactionPageFake`, `GapSpec`, `seededRandom`, `buildDeterministicGaps` |
| `src/__tests__/fixtures/chaosHelpers.ts` | `runGapChaosScenario`, `buildSeededGapFake`, `filterAuditEvents` |
| `run-chaos-tests.sh` | `gap` scenario entry |
| `docs/horizon-history-gap-chaos.md` | This document |

---

## Running the Tests

```bash
# Gap-injection scenario only (fast, deterministic)
./run-chaos-tests.sh gap

# Equivalent:
npx jest --testPathPattern="horizonGapChaos" --runInBand --forceExit

# All chaos tests
./run-chaos-tests.sh chaos
```

---

## Acceptance criteria

| Criterion | Behaviour |
|-----------|-----------|
| Gap injection is deterministic per seed | `seededRandom` / `buildDeterministicGaps` |
| Gap detection emits `ingest.cursor.paused` | Fatal alert; cursor does **not** advance |
| No silent skip of records | Halt returns empty `records` for the gapped page |
| Recovery when gaps close | Explicit `resumeFromCursor()` then clean pages |
| Multiple simultaneous gaps | Only the **first** gap halts; cursor stays at last clean token |

---

## Wiring to Horizon

```typescript
import {
  HorizonTransactionHistoryFetcher,
  createHorizonHttpFetchPage,
} from './services/horizonTransactionHistoryFetcher';

const fetcher = new HorizonTransactionHistoryFetcher({
  fetchPage: createHorizonHttpFetchPage(process.env.STELLAR_HORIZON_URL!),
});

fetcher.on('audit', (event) => {
  if (event.type === 'ingest.cursor.paused') {
    // page ops — severity is 'fatal'
  }
});
```

---

## Security assumptions

1. Horizon base URL comes from trusted config, never request input.
2. `paging_token` values are opaque; numeric ordering is for gap detection only.
3. Recovery is **explicit** — no automatic skip-over-gap.
4. BigInt arithmetic guards overflow on large tokens.

---

## Related

- `src/lib/stellarRpcClient.ts` — Stellar RPC client (submission / horizon health)
- Chaos siblings: `horizonChaos.test.ts`, `horizonBadSeqChaos.test.ts`
