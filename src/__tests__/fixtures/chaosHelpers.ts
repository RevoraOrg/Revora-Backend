// Helper functions for chaos testing
import { HorizonFake, FailureProfile, GapSpec, HorizonTransactionPageFake, buildDeterministicGaps } from '../mocks/horizonFake';
import {
  HorizonTransactionHistoryFetcher,
  IngestAuditEvent,
  FetchPageResult,
} from '../../services/horizonTransactionHistoryFetcher';

export interface TestResult {
  success: boolean;
  errors: Error[];
  requestCount: number;
  latency: number;
  cursor?: string;
}

export async function runChaosScenario(
  horizonFake: HorizonFake,
  profile: FailureProfile,
  operations: number,
  timeout: number = 30000
): Promise<TestResult> {
  const errors: Error[] = [];
  const startTime = Date.now();
  
  horizonFake.setFailureProfile(profile);

  try {
    // Simulate operations
    const promises = [];
    for (let i = 0; i < operations; i++) {
      promises.push(
        horizonFake.simulateRequest('/ledgers')
          .catch(error => {
            errors.push(error);
            return null;
          })
      );
    }

    await Promise.allSettled(promises);
    
    // Check if operations completed within timeout
    const elapsed = Date.now() - startTime;
    if (elapsed > timeout) {
      throw new Error(`Operations exceeded timeout of ${timeout}ms`);
    }

    return {
      success: errors.length === 0,
      errors,
      requestCount: horizonFake.getRequestCount(),
      latency: elapsed,
      cursor: horizonFake.getCurrentCursor()
    };
  } catch (error) {
    return {
      success: false,
      errors: [...errors, error as Error],
      requestCount: horizonFake.getRequestCount(),
      latency: Date.now() - startTime
    };
  }
}

export function createSequentialProfile(duration: number): FailureProfile[] {
  const profiles: FailureProfile[] = [];
  
  // Create sequence of failure profiles
  const stages = [
    { latencyMs: 100, duration: 0.2 },
    { latencyMs: 1000, duration: 0.3 },
    { latencyMs: 5000, duration: 0.2 },
    { latencyMs: 100, duration: 0.3 }
  ];

  for (const stage of stages) {
    profiles.push({
      latencyMs: stage.latencyMs
    });
  }

  return profiles;
}

export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Gap chaos helpers
// ---------------------------------------------------------------------------

/** Collected audit events and final state from a gap-chaos run. */
export interface GapChaosRunResult {
  auditEvents: IngestAuditEvent[];
  pageResults: FetchPageResult[];
  /** Whether the fetcher ended up paused. */
  finallyPaused: boolean;
  /** Final cursor value. */
  finalCursor: string;
  /** Total records ingested before any halt. */
  totalIngested: number;
  /** Total pages fetched. */
  totalPages: number;
  /** Elapsed milliseconds. */
  elapsedMs: number;
}

/**
 * Runs a gap-chaos scenario using a `HorizonTransactionPageFake` wired into
 * a `HorizonTransactionHistoryFetcher`.
 *
 * Pumps up to `maxPages` pages (or until paused/empty).
 * Returns all audit events and page results for assertion.
 *
 * @param pageFake     - Pre-configured fake with gap specs.
 * @param maxPages     - Upper bound on pages to fetch.
 * @param haltOnGap    - Passed through to the fetcher (default true).
 * @param initialCursor - Starting cursor for the fetcher.
 */
export async function runGapChaosScenario(
  pageFake: HorizonTransactionPageFake,
  maxPages: number,
  haltOnGap: boolean = true,
  initialCursor: string = '',
): Promise<GapChaosRunResult> {
  const auditEvents: IngestAuditEvent[] = [];
  const pageResults: FetchPageResult[] = [];
  const start = Date.now();

  const fetcher = new HorizonTransactionHistoryFetcher({
    fetchPage: (cursor, limit) => pageFake.fetchPage(cursor, limit),
    pageSize: 5,
    initialCursor,
    haltOnGap,
  });

  fetcher.on('audit', (event: IngestAuditEvent) => {
    auditEvents.push(event);
  });

  for (let i = 0; i < maxPages; i++) {
    const result = await fetcher.fetchNextPage();
    pageResults.push(result);

    // Stop driving if paused or no more records
    if (result.paused) break;
    if (result.records.length === 0 && !result.gapDetected) break;
  }

  return {
    auditEvents,
    pageResults,
    finallyPaused: fetcher.isPaused(),
    finalCursor: fetcher.getCursor(),
    totalIngested: fetcher.getTotalIngested(),
    totalPages: fetcher.getTotalPagesFetched(),
    elapsedMs: Date.now() - start,
  };
}

/**
 * Builds a `HorizonTransactionPageFake` with deterministic gaps seeded by
 * `seed`.  Returns both the fake and the gap specs so tests can make
 * assertions about exactly which gaps were injected.
 */
export function buildSeededGapFake(opts: {
  seed: number;
  baseToken?: number;
  totalPages?: number;
  pageSize?: number;
  gapCount?: number;
}): { pageFake: HorizonTransactionPageFake; gaps: GapSpec[] } {
  const baseToken = opts.baseToken ?? 1000;
  const totalPages = opts.totalPages ?? 10;
  const pageSize = opts.pageSize ?? 5;
  const gapCount = opts.gapCount ?? 1;

  const gaps = buildDeterministicGaps(baseToken, totalPages, pageSize, gapCount, opts.seed);
  const pageFake = new HorizonTransactionPageFake(baseToken, gaps);
  return { pageFake, gaps };
}

/**
 * Extracts only audit events matching the given type from a run result.
 */
export function filterAuditEvents(
  result: GapChaosRunResult,
  type: IngestAuditEvent['type'],
): IngestAuditEvent[] {
  return result.auditEvents.filter((e) => e.type === type);
}
