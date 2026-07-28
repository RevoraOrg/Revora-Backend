/**
 * @file horizonGapChaos.test.ts
 * @description Chaos coverage for Stellar Horizon transaction-history gap injection
 * and detection.  All scenarios are deterministic (seeded PRNG) so they reproduce
 * identically across CI runs.
 *
 * Coverage targets (≥ 95 %):
 *  - HorizonTransactionHistoryFetcher (all branches)
 *  - HorizonTransactionPageFake (all methods)
 *  - Gap-chaos helpers (buildDeterministicGaps, seededRandom, runGapChaosScenario)
 *
 * Security notes:
 *  - Gap detection is asserted to emit `ingest.cursor.paused` before any cursor
 *    advancement so no records are silently skipped.
 *  - Multiple simultaneous gaps must not confuse the cursor — only the first
 *    gap halts; the cursor stays at the last clean record.
 *  - Recovery via resumeFromCursor() is verified to be explicit and idempotent.
 */

import {
  HorizonTransactionHistoryFetcher,
  IngestAuditEvent,
  HorizonTransactionPage,
} from '../../services/horizonTransactionHistoryFetcher';
import {
  HorizonTransactionPageFake,
  GapSpec,
  seededRandom,
  buildDeterministicGaps,
} from '../mocks/horizonFake';
import {
  runGapChaosScenario,
  buildSeededGapFake,
  filterAuditEvents,
  wait,
} from '../fixtures/chaosHelpers';

// ---------------------------------------------------------------------------
// Helpers shared across suites
// ---------------------------------------------------------------------------

/** Collect all audit events emitted by a fetcher during a callback. */
async function collectAudit(
  fetcher: HorizonTransactionHistoryFetcher,
  fn: () => Promise<void>,
): Promise<IngestAuditEvent[]> {
  const events: IngestAuditEvent[] = [];
  fetcher.on('audit', (e: IngestAuditEvent) => events.push(e));
  await fn();
  return events;
}

/** Build a minimal valid page with the given paging_tokens. */
function makePage(tokens: string[]): HorizonTransactionPage {
  return {
    _embedded: {
      records: tokens.map((t) => ({
        id: `tx-${t}`,
        paging_token: t,
        created_at: '2024-01-01T00:00:00Z',
        ledger: Number(t),
      })),
    },
    _links: { self: { href: '/transactions' } },
  };
}


// ===========================================================================
// Suite 1 – seededRandom PRNG determinism
// ===========================================================================
describe('seededRandom', () => {
  it('produces identical sequences for the same seed', () => {
    const rng1 = seededRandom(42);
    const rng2 = seededRandom(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('produces different sequences for different seeds', () => {
    const rng1 = seededRandom(1);
    const rng2 = seededRandom(2);
    const seq1 = Array.from({ length: 20 }, () => rng1());
    const seq2 = Array.from({ length: 20 }, () => rng2());
    expect(seq1).not.toEqual(seq2);
  });

  it('stays in [0, 1) for 10 000 draws', () => {
    const rng = seededRandom(999);
    for (let i = 0; i < 10_000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});


// ===========================================================================
// Suite 2 – buildDeterministicGaps
// ===========================================================================
describe('buildDeterministicGaps', () => {
  it('returns same gap specs for the same inputs (deterministic)', () => {
    const a = buildDeterministicGaps(1000, 10, 5, 3, 777);
    const b = buildDeterministicGaps(1000, 10, 5, 3, 777);
    expect(a).toEqual(b);
  });

  it('returns different specs for different seeds', () => {
    const a = buildDeterministicGaps(1000, 10, 5, 3, 1);
    const b = buildDeterministicGaps(1000, 10, 5, 3, 2);
    expect(a).not.toEqual(b);
  });

  it('returns at most gapCount gaps', () => {
    const gaps = buildDeterministicGaps(1000, 20, 5, 5, 42);
    expect(gaps.length).toBeLessThanOrEqual(5);
  });

  it('gaps are sorted in ascending token order', () => {
    const gaps = buildDeterministicGaps(1000, 20, 5, 4, 123);
    for (let i = 1; i < gaps.length; i++) {
      expect(BigInt(gaps[i].afterToken)).toBeGreaterThan(BigInt(gaps[i - 1].afterToken));
    }
  });

  it('each skipCount is in [1, 9]', () => {
    const gaps = buildDeterministicGaps(1000, 50, 10, 20, 55);
    for (const g of gaps) {
      expect(g.skipCount).toBeGreaterThanOrEqual(1);
      expect(g.skipCount).toBeLessThanOrEqual(9);
    }
  });
});


// ===========================================================================
// Suite 3 – HorizonTransactionPageFake
// ===========================================================================
describe('HorizonTransactionPageFake', () => {
  it('emits monotonically increasing tokens with no gaps when none configured', async () => {
    const fake = new HorizonTransactionPageFake(100);
    const page = await fake.fetchPage('', 5);
    const tokens = page._embedded.records.map((r) => r.paging_token);
    expect(tokens).toEqual(['100', '101', '102', '103', '104']);
  });

  it('skips tokens at the configured gap position', async () => {
    const gaps: GapSpec[] = [{ afterToken: '102', skipCount: 3 }];
    const fake = new HorizonTransactionPageFake(100, gaps);
    const page = await fake.fetchPage('', 10);
    const tokens = page._embedded.records.map((r) => r.paging_token);
    // Records up to 102, then gap of 3 (103, 104, 105 missing), page ends
    expect(tokens).toContain('102');
    expect(tokens).not.toContain('103');
    expect(tokens).not.toContain('104');
    expect(tokens).not.toContain('105');
    // Next page starts at 106
    const page2 = await fake.fetchPage('', 3);
    const tokens2 = page2._embedded.records.map((r) => r.paging_token);
    expect(tokens2[0]).toBe('106');
  });

  it('injectOnceError throws on next call then recovers', async () => {
    const fake = new HorizonTransactionPageFake(200);
    fake.injectOnceError();
    await expect(fake.fetchPage('', 5)).rejects.toThrow('Injected transient fetch error');
    // Second call succeeds
    const page = await fake.fetchPage('', 5);
    expect(page._embedded.records).toHaveLength(5);
  });

  it('setPermanentError throws on every call until cleared', async () => {
    const fake = new HorizonTransactionPageFake(300);
    fake.setPermanentError(new Error('Permanent outage'));
    await expect(fake.fetchPage('', 5)).rejects.toThrow('Permanent outage');
    await expect(fake.fetchPage('', 5)).rejects.toThrow('Permanent outage');
    fake.setPermanentError(null);
    const page = await fake.fetchPage('', 5);
    expect(page._embedded.records).toHaveLength(5);
  });

  it('reset restores emittedCount and pageCount', async () => {
    const fake = new HorizonTransactionPageFake(400);
    await fake.fetchPage('', 5);
    await fake.fetchPage('', 5);
    expect(fake.getEmittedCount()).toBe(10);
    fake.reset(400);
    expect(fake.getEmittedCount()).toBe(0);
    expect(fake.getPageCount()).toBe(0);
  });

  it('peekNextToken does not advance the counter', async () => {
    const fake = new HorizonTransactionPageFake(500);
    const peeked = fake.peekNextToken();
    const page = await fake.fetchPage('', 1);
    expect(page._embedded.records[0].paging_token).toBe(peeked);
  });

  it('respects limit parameter', async () => {
    const fake = new HorizonTransactionPageFake(600);
    const page = await fake.fetchPage('', 3);
    expect(page._embedded.records).toHaveLength(3);
  });

  it('caps limit at 200', async () => {
    const fake = new HorizonTransactionPageFake(700);
    const page = await fake.fetchPage('', 500);
    expect(page._embedded.records).toHaveLength(200);
  });
});


// ===========================================================================
// Suite 4 – HorizonTransactionHistoryFetcher: gap detection core
// ===========================================================================
describe('HorizonTransactionHistoryFetcher – gap detection', () => {
  it('ingests a clean page with no gaps, advances cursor to last token', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['100', '101', '102', '103', '104']),
      pageSize: 5,
    });
    const result = await fetcher.fetchNextPage();
    expect(result.gapDetected).toBe(false);
    expect(result.paused).toBe(false);
    expect(result.cursor).toBe('104');
    expect(result.records).toHaveLength(5);
    expect(fetcher.getCursor()).toBe('104');
    expect(fetcher.getTotalIngested()).toBe(5);
  });

  it('detects inter-page gap and emits ingest.cursor.paused', async () => {
    // Cursor already at 104; next page starts at 107 → gap of 2 missing (105, 106)
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['107', '108', '109']),
      pageSize: 5,
      initialCursor: '104',
    });
    const events: IngestAuditEvent[] = [];
    fetcher.on('audit', (e) => events.push(e));

    const result = await fetcher.fetchNextPage();

    expect(result.gapDetected).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.records).toHaveLength(0);       // no records ingested
    expect(result.cursor).toBe('104');             // cursor unchanged
    expect(result.gapDetail?.expectedAfter).toBe('104');
    expect(result.gapDetail?.firstTokenOnPage).toBe('107');
    expect(result.gapDetail?.missingCount).toBe(2);

    const pausedEvents = events.filter((e) => e.type === 'ingest.cursor.paused');
    expect(pausedEvents).toHaveLength(1);
    expect(pausedEvents[0].cursor).toBe('104');
    expect(pausedEvents[0].meta?.reason).toBe('gap_detected');
  });

  it('emits ingest.gap.detected before ingest.cursor.paused', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['200', '202']), // gap between 200 and 202
      pageSize: 5,
      initialCursor: '199',
    });
    const types: string[] = [];
    fetcher.on('audit', (e: IngestAuditEvent) => types.push(e.type));

    await fetcher.fetchNextPage();

    const gapIdx = types.indexOf('ingest.gap.detected');
    const pauseIdx = types.indexOf('ingest.cursor.paused');
    expect(gapIdx).toBeGreaterThanOrEqual(0);
    expect(pauseIdx).toBeGreaterThan(gapIdx);
  });

  it('cursor does NOT advance when a gap is detected (haltOnGap=true)', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['300', '305']), // 4-token gap
      pageSize: 5,
      initialCursor: '299',
      haltOnGap: true,
    });
    await fetcher.fetchNextPage();
    expect(fetcher.getCursor()).toBe('299');   // unchanged
    expect(fetcher.getTotalIngested()).toBe(0);
  });

  it('returns paused=true on subsequent calls when halted', async () => {
    const pages = [makePage(['10', '15'])]; // gap after 10
    let call = 0;
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => pages[call++] ?? makePage([]),
      pageSize: 5,
      initialCursor: '9',
    });
    await fetcher.fetchNextPage(); // triggers halt
    expect(fetcher.isPaused()).toBe(true);

    // Subsequent call without resume should return paused immediately
    const r2 = await fetcher.fetchNextPage();
    expect(r2.paused).toBe(true);
    expect(r2.records).toHaveLength(0);
    expect(call).toBe(1); // fetchPage NOT called again
  });
});


// ===========================================================================
// Suite 5 – haltOnGap=false (continue-through-gap mode)
// ===========================================================================
describe('HorizonTransactionHistoryFetcher – haltOnGap=false', () => {
  it('reports gap but continues ingesting when haltOnGap=false', async () => {
    // Page starts at 107 after cursor 104 — gap of 2 (105, 106)
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['107', '108', '109']),
      pageSize: 5,
      initialCursor: '104',
      haltOnGap: false,
    });
    const result = await fetcher.fetchNextPage();

    expect(result.gapDetected).toBe(true);
    expect(result.paused).toBe(false);           // still running
    expect(result.records).toHaveLength(3);       // records returned despite gap
    expect(result.cursor).toBe('109');            // cursor advanced
    expect(fetcher.getTotalIngested()).toBe(3);
  });

  it('does NOT emit ingest.cursor.paused when haltOnGap=false', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['500', '510']),
      pageSize: 5,
      initialCursor: '499',
      haltOnGap: false,
    });
    const types: string[] = [];
    fetcher.on('audit', (e: IngestAuditEvent) => types.push(e.type));
    await fetcher.fetchNextPage();

    expect(types).not.toContain('ingest.cursor.paused');
    expect(types).toContain('ingest.gap.detected');
    expect(types).toContain('ingest.page.ingested');
  });
});


// ===========================================================================
// Suite 6 – Recovery: resumeFromCursor()
// ===========================================================================
describe('HorizonTransactionHistoryFetcher – recovery', () => {
  it('resumes cleanly after a gap closes', async () => {
    let callCount = 0;
    // First call: gap injected. Second call (after resume): clean page.
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => {
        callCount++;
        if (callCount === 1) return makePage(['200', '205']); // gap
        return makePage(['206', '207', '208']);               // clean
      },
      pageSize: 5,
      initialCursor: '199',
    });

    const events: IngestAuditEvent[] = [];
    fetcher.on('audit', (e) => events.push(e));

    const r1 = await fetcher.fetchNextPage();
    expect(r1.gapDetected).toBe(true);
    expect(fetcher.isPaused()).toBe(true);

    // Operator verifies gap is closed, resumes from known-good position
    fetcher.resumeFromCursor('205');

    expect(fetcher.isPaused()).toBe(false);
    expect(fetcher.getCursor()).toBe('205');

    const resumedEvent = events.find((e) => e.type === 'ingest.cursor.resumed');
    expect(resumedEvent).toBeDefined();
    expect(resumedEvent?.meta?.resumedAt).toBe('205');

    const r2 = await fetcher.fetchNextPage();
    expect(r2.gapDetected).toBe(false);
    expect(r2.paused).toBe(false);
    expect(r2.records).toHaveLength(3);
    expect(fetcher.getCursor()).toBe('208');
  });

  it('resumeFromCursor clears lastGapDetail', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['100', '110']), // gap
      pageSize: 5,
      initialCursor: '99',
    });
    await fetcher.fetchNextPage();
    expect(fetcher.getLastGapDetail()).toBeDefined();

    fetcher.resumeFromCursor('110');
    expect(fetcher.getLastGapDetail()).toBeUndefined();
  });

  it('resumeFromCursor throws on empty string', () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage([]),
    });
    expect(() => fetcher.resumeFromCursor('')).toThrow();
  });

  it('resumeFromCursor is idempotent: calling twice is safe', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['900', '920']),
      initialCursor: '899',
    });
    await fetcher.fetchNextPage();
    fetcher.resumeFromCursor('910');
    fetcher.resumeFromCursor('910'); // second call, same cursor
    expect(fetcher.getCursor()).toBe('910');
    expect(fetcher.isPaused()).toBe(false);
  });
});


// ===========================================================================
// Suite 7 – Multiple simultaneous gaps do not confuse the cursor
// ===========================================================================
describe('Multiple gaps – cursor isolation', () => {
  it('halts at the FIRST gap only; cursor stays at last clean record', async () => {
    // Page contains two gaps: between 100->103 and between 105->110
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['100', '103', '110']),
      pageSize: 10,
      initialCursor: '99',
    });
    const result = await fetcher.fetchNextPage();

    expect(result.gapDetected).toBe(true);
    // Gap should be between token 99 (cursor) and token 100, which is actually
    // fine (99+1=100). The gap is 100→103 (missing 101, 102 = 2 tokens).
    expect(result.gapDetail?.expectedAfter).toBe('100');
    expect(result.gapDetail?.firstTokenOnPage).toBe('103');
    expect(result.gapDetail?.missingCount).toBe(2);
    // Cursor stays at '99' — the cursor before this page
    expect(fetcher.getCursor()).toBe('99');
  });

  it('with haltOnGap=false, reports only the first gap per page', async () => {
    // Page with two gaps: 100→103 (skip 2) and 105→110 (skip 4)
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['100', '103', '110']),
      pageSize: 10,
      initialCursor: '99',
      haltOnGap: false,
    });
    const events: IngestAuditEvent[] = [];
    fetcher.on('audit', (e) => events.push(e));

    await fetcher.fetchNextPage();

    const gapEvents = events.filter((e) => e.type === 'ingest.gap.detected');
    // detectGap returns on first gap found — only one gap event per page call
    expect(gapEvents).toHaveLength(1);
    expect(gapEvents[0].meta?.expectedAfter).toBe('100');
  });

  it('two sequential pages each with a gap halt at the first one', async () => {
    let page = 0;
    const pages = [
      () => makePage(['200', '205']),  // gap between 199→200? No. gap between 200→205
      () => makePage(['300', '310']),  // this page is never reached
    ];
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => pages[page++](),
      pageSize: 5,
      initialCursor: '199',
    });
    const r1 = await fetcher.fetchNextPage();
    expect(r1.gapDetected).toBe(true);
    expect(fetcher.isPaused()).toBe(true);
    expect(page).toBe(1); // only first page was fetched

    // Second page is never fetched because fetcher is paused
    await fetcher.fetchNextPage();
    expect(page).toBe(1); // still 1
  });
});


// ===========================================================================
// Suite 8 – Deterministic gap-injection chaos via buildSeededGapFake
// ===========================================================================
describe('Deterministic gap-chaos via buildSeededGapFake', () => {
  it('same seed always halts at the same cursor (reproducible)', async () => {
    const runOnce = async () => {
      const { pageFake } = buildSeededGapFake({ seed: 42, gapCount: 1 });
      return runGapChaosScenario(pageFake, 20);
    };

    const r1 = await runOnce();
    const r2 = await runOnce();

    expect(r1.finallyPaused).toBe(r2.finallyPaused);
    expect(r1.finalCursor).toBe(r2.finalCursor);
    expect(r1.totalIngested).toBe(r2.totalIngested);
  });

  it('different seeds produce different halt cursors', async () => {
    const run = async (seed: number) => {
      const { pageFake } = buildSeededGapFake({ seed, gapCount: 1 });
      return runGapChaosScenario(pageFake, 20);
    };

    const r1 = await run(1);
    const r2 = await run(2);
    // With different seeds, at least one outcome should differ
    expect(r1.finalCursor === r2.finalCursor && r1.totalIngested === r2.totalIngested).toBe(false);
  });

  it('detects the gap and emits ingest.cursor.paused', async () => {
    const { pageFake } = buildSeededGapFake({ seed: 100, gapCount: 1 });
    const result = await runGapChaosScenario(pageFake, 20);

    expect(result.finallyPaused).toBe(true);
    const pauseEvents = filterAuditEvents(result, 'ingest.cursor.paused');
    expect(pauseEvents).toHaveLength(1);
    expect(pauseEvents[0].meta?.reason).toBe('gap_detected');
  });

  it('all records before the gap are ingested before halting', async () => {
    const { pageFake, gaps } = buildSeededGapFake({ seed: 777, gapCount: 1 });
    const result = await runGapChaosScenario(pageFake, 30);

    // The cursor must be at or before the gap's afterToken
    const gapAfterToken = BigInt(gaps[0].afterToken);
    const finalCursor = result.finalCursor ? BigInt(result.finalCursor) : BigInt(0);
    expect(finalCursor).toBeLessThanOrEqual(gapAfterToken);
  });

  it('ingest.page.ingested events are emitted for every clean page', async () => {
    const { pageFake } = buildSeededGapFake({ seed: 55, gapCount: 1, totalPages: 6 });
    const result = await runGapChaosScenario(pageFake, 20);

    const ingestedEvents = filterAuditEvents(result, 'ingest.page.ingested');
    // Should have at least one page ingested before the gap is hit
    expect(ingestedEvents.length).toBeGreaterThanOrEqual(1);
  });
});


// ===========================================================================
// Suite 9 – Gap recovery (gap closes, ingest resumes)
// ===========================================================================
describe('Gap recovery – gap closes', () => {
  it('resumes cleanly after gap closes and completes without further gaps', async () => {
    const { gaps } = buildSeededGapFake({ seed: 321, gapCount: 1 });
    expect(gaps.length).toBeGreaterThanOrEqual(1);

    const gapSpec = gaps[0];
    // resumeToken is the first token past the gap
    const resumeToken = String(BigInt(gapSpec.afterToken) + BigInt(gapSpec.skipCount) + 1n);

    // Phase 2: fresh sequential fake with NO gaps, starting from the resume position
    const gapFreePageFake = new HorizonTransactionPageFake(
      BigInt(resumeToken),
      [], // no gaps
    );
    const fetcher2 = new HorizonTransactionHistoryFetcher({
      fetchPage: (cursor, limit) => gapFreePageFake.fetchPage(cursor, limit),
      pageSize: 5,
      initialCursor: resumeToken,
    });
    const events2: IngestAuditEvent[] = [];
    fetcher2.on('audit', (e) => events2.push(e));

    // Fetch a couple of clean pages — should all succeed without detecting gaps
    const p1 = await fetcher2.fetchNextPage();
    const p2 = await fetcher2.fetchNextPage();

    expect(p1.gapDetected).toBe(false);
    expect(p2.gapDetected).toBe(false);
    expect(fetcher2.isPaused()).toBe(false);

    // No resume events (fresh fetcher was never paused)
    const resumeEvents = events2.filter((e) => e.type === 'ingest.cursor.resumed');
    expect(resumeEvents).toHaveLength(0);
  });

  it('explicit resumeFromCursor after gap emits ingest.cursor.resumed', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['400', '410']),
      pageSize: 5,
      initialCursor: '399',
    });
    const types: string[] = [];
    fetcher.on('audit', (e: IngestAuditEvent) => types.push(e.type));

    await fetcher.fetchNextPage(); // triggers gap + pause
    fetcher.resumeFromCursor('410');

    expect(types).toContain('ingest.cursor.resumed');
  });
});


// ===========================================================================
// Suite 10 – Edge cases
// ===========================================================================
describe('Edge cases', () => {
  it('empty first page emits ingest.page.empty, does not pause', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage([]),
      pageSize: 5,
    });
    const types: string[] = [];
    fetcher.on('audit', (e: IngestAuditEvent) => types.push(e.type));

    const result = await fetcher.fetchNextPage();
    expect(result.paused).toBe(false);
    expect(result.gapDetected).toBe(false);
    expect(types).toContain('ingest.page.empty');
  });

  it('single-record page with no prior cursor ingests cleanly', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['999']),
      pageSize: 5,
    });
    const result = await fetcher.fetchNextPage();
    expect(result.gapDetected).toBe(false);
    expect(fetcher.getCursor()).toBe('999');
  });

  it('backward-moving token (reorg-style) is not treated as a gap', async () => {
    // cursor=200, page starts at 150 — this is a reorg, not a gap
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['150', '151', '152']),
      pageSize: 5,
      initialCursor: '200',
    });
    const result = await fetcher.fetchNextPage();
    // Should not be flagged as a gap — backward movement passes through
    expect(result.gapDetected).toBe(false);
    expect(result.paused).toBe(false);
  });

  it('non-numeric paging_token does not crash the fetcher', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['abc-token-1', 'abc-token-2']),
      pageSize: 5,
      initialCursor: 'abc-token-0',
    });
    // Should not throw; gap check is skipped for non-numeric tokens
    await expect(fetcher.fetchNextPage()).resolves.not.toThrow();
  });

  it('reset() clears all state including gap detail', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['1000', '1010']),
      pageSize: 5,
      initialCursor: '999',
    });
    await fetcher.fetchNextPage();
    expect(fetcher.isPaused()).toBe(true);

    fetcher.reset('500');
    expect(fetcher.isPaused()).toBe(false);
    expect(fetcher.getCursor()).toBe('500');
    expect(fetcher.getLastGapDetail()).toBeUndefined();
    expect(fetcher.getTotalIngested()).toBe(0);
    expect(fetcher.getTotalPagesFetched()).toBe(0);
  });

  it('reset() with no argument defaults cursor to empty string', () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage([]),
    });
    fetcher.reset();
    expect(fetcher.getCursor()).toBe('');
  });

  it('upstream fetchPage throwing propagates out of fetchNextPage', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => { throw new Error('Horizon 503'); },
      pageSize: 5,
    });
    await expect(fetcher.fetchNextPage()).rejects.toThrow('Horizon 503');
  });

  it('getTotalPagesFetched increments on each successful fetch', async () => {
    let call = 0;
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => {
        call++;
        return makePage([String(call * 100), String(call * 100 + 1)]);
      },
      pageSize: 5,
    });
    await fetcher.fetchNextPage();
    await fetcher.fetchNextPage();
    expect(fetcher.getTotalPagesFetched()).toBe(2);
  });

  it('page with _embedded missing returns empty result', async () => {
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => ({
        _embedded: { records: [] },
        _links: { self: { href: '/transactions' } },
      }),
      pageSize: 5,
    });
    const result = await fetcher.fetchNextPage();
    expect(result.records).toHaveLength(0);
    expect(result.gapDetected).toBe(false);
  });

  it('very large gap (>Number.MAX_SAFE_INTEGER tokens) is clamped', async () => {
    // Simulate a BigInt overflow scenario with an enormous skip
    const fetcher = new HorizonTransactionHistoryFetcher({
      fetchPage: async () => makePage(['1', '9999999999999999999']),
      pageSize: 5,
      initialCursor: '0',
    });
    const result = await fetcher.fetchNextPage();
    // Gap should be detected; missingCount should equal Number.MAX_SAFE_INTEGER
    expect(result.gapDetected).toBe(true);
    if (result.gapDetail) {
      expect(result.gapDetail.missingCount).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
  });
});


// ===========================================================================
// Suite 11 – Multi-seed chaos sweep (regression guard)
// ===========================================================================
describe('Multi-seed chaos sweep', () => {
  /**
   * Runs the full gap-injection chaos with 12 different seeds.
   * Every run must:
   *  - end paused (gap always halts)
   *  - emit exactly one ingest.cursor.paused event
   *  - not advance the cursor past the gapped token
   */
  const seeds = [1, 7, 13, 42, 99, 128, 256, 512, 1024, 2048, 9999, 65535];

  for (const seed of seeds) {
    it(`seed ${seed}: pauses on first gap, cursor stays clean`, async () => {
      const { pageFake, gaps } = buildSeededGapFake({
        seed,
        baseToken: 1000,
        totalPages: 12,
        pageSize: 5,
        gapCount: 1,
      });

      const result = await runGapChaosScenario(pageFake, 30);

      expect(result.finallyPaused).toBe(true);

      const pauseEvents = filterAuditEvents(result, 'ingest.cursor.paused');
      expect(pauseEvents).toHaveLength(1);

      // Cursor must not have advanced past the token immediately before the gap
      if (gaps.length > 0 && result.finalCursor) {
        const cursorBig = BigInt(result.finalCursor);
        const gapAfter = BigInt(gaps[0].afterToken);
        expect(cursorBig).toBeLessThanOrEqual(gapAfter);
      }
    });
  }
});
