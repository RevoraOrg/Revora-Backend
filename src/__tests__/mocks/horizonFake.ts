// Horizon Fake with programmable failure profiles and gap injection
import { EventEmitter } from 'events';
import { HorizonTransactionPage, HorizonTransaction } from '../../services/horizonTransactionHistoryFetcher';

export interface FailureProfile {
  latencyMs?: number;
  dropConnection?: boolean;
  partialReads?: boolean;
  reorgDepth?: number;
  invalidResponses?: boolean;
  errorRate?: number;
}

/**
 * Describes a single gap to inject into a paging-token stream.
 * `afterToken` is the paging_token of the last record *before* the gap.
 * `skipCount` is how many tokens to skip (gap size ≥ 1).
 */
export interface GapSpec {
  /** paging_token of the last normal record before the gap. */
  afterToken: string;
  /** Number of tokens to omit (must be ≥ 1). */
  skipCount: number;
}

/**
 * Deterministic PRNG (mulberry32) seeded with a 32-bit integer.
 * Returns a function that produces uniform floats in [0, 1).
 */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a deterministic list of GapSpecs from a seed.
 * Given the same seed the output is always identical, making chaos
 * scenarios fully reproducible across CI runs.
 *
 * @param baseToken  - Starting paging_token (numeric string) for the sequence.
 * @param totalPages - How many pages the sequence spans.
 * @param pageSize   - Records per page.
 * @param gapCount   - How many gaps to inject.
 * @param seed       - 32-bit integer seed for the PRNG.
 */
export function buildDeterministicGaps(
  baseToken: number,
  totalPages: number,
  pageSize: number,
  gapCount: number,
  seed: number,
): GapSpec[] {
  const rng = seededRandom(seed);
  const totalTokens = totalPages * pageSize;
  const gaps: GapSpec[] = [];
  const usedAfter = new Set<number>();

  for (let i = 0; i < gapCount; i++) {
    let attempts = 0;
    while (attempts < 1000) {
      // Pick a record index that is not the last record (no gap at very end)
      const idx = Math.floor(rng() * (totalTokens - 2));
      const afterTokenNum = baseToken + idx;
      if (!usedAfter.has(afterTokenNum)) {
        usedAfter.add(afterTokenNum);
        const skipCount = 1 + Math.floor(rng() * 9); // 1–9 skipped tokens
        gaps.push({ afterToken: String(afterTokenNum), skipCount });
        break;
      }
      attempts++;
    }
  }

  // Sort so gaps are applied in token order
  gaps.sort((a, b) => Number(BigInt(a.afterToken) - BigInt(b.afterToken)));
  return gaps;
}

export interface RequestLog {
  endpoint: string;
  timestamp: number;
  success: boolean;
  latency: number;
}

// ---------------------------------------------------------------------------
// HorizonTransactionPageFake
// ---------------------------------------------------------------------------

/**
 * A deterministic fake that implements the `fetchPage` callback expected by
 * `HorizonTransactionHistoryFetcher`.
 *
 * It generates a sequential paging-token stream and can have GapSpecs injected
 * at construction time so that specific token positions are skipped.  The same
 * seed always produces the same page sequence, making tests reproducible.
 */
export class HorizonTransactionPageFake {
  /** Next paging_token to emit (BigInt for precision). */
  private nextToken: bigint;
  /** Pre-sorted gap specs indexed by the afterToken that triggers the skip. */
  private readonly gapMap: Map<string, number>;
  /** Total records emitted across all fetchPage calls. */
  private emittedCount = 0;
  /** Pages returned. */
  private pageCount = 0;
  /** Whether to inject a fetch error on the next call. */
  private injectErrorOnce = false;
  /** If non-null, an error to throw on every call (until cleared). */
  private permanentError: Error | null = null;

  constructor(
    startToken: number | bigint = 1000,
    gaps: GapSpec[] = [],
  ) {
    this.nextToken = BigInt(startToken);
    this.gapMap = new Map(gaps.map((g) => [g.afterToken, g.skipCount]));
  }

  /**
   * Implements `HorizonTransactionHistoryFetcherConfig.fetchPage`.
   * Ignores `cursor` parameter — the fake owns its own sequential counter.
   */
  async fetchPage(cursor: string, limit: number): Promise<HorizonTransactionPage> {
    if (this.permanentError) throw this.permanentError;
    if (this.injectErrorOnce) {
      this.injectErrorOnce = false;
      throw new Error('Injected transient fetch error');
    }

    const pageSize = Math.min(limit, 200);
    const records: HorizonTransaction[] = [];

    for (let i = 0; i < pageSize; i++) {
      const tokenStr = String(this.nextToken);
      records.push({
        id: `tx-${tokenStr}`,
        paging_token: tokenStr,
        created_at: new Date().toISOString(),
        ledger: Number(this.nextToken % 1000000n),
      });

      // Check if a gap should follow this token
      if (this.gapMap.has(tokenStr)) {
        const skip = this.gapMap.get(tokenStr)!;
        // Advance past the skipped tokens (they will never appear in any page)
        this.nextToken += BigInt(skip) + 1n;
        break; // end the page here so the gap appears at the page boundary
      } else {
        this.nextToken += 1n;
      }
    }

    this.emittedCount += records.length;
    this.pageCount++;

    const selfCursor = records.length > 0 ? records[records.length - 1].paging_token : cursor;
    return {
      _embedded: { records },
      _links: {
        self: { href: `/transactions?cursor=${selfCursor}&limit=${pageSize}&order=asc` },
        next: { href: `/transactions?cursor=${selfCursor}&limit=${pageSize}&order=asc` },
      },
    };
  }

  /** Schedule a one-shot transient error on the next `fetchPage` call. */
  injectOnceError(): void {
    this.injectErrorOnce = true;
  }

  /** Set a permanent error that will be thrown on every `fetchPage` call. */
  setPermanentError(err: Error | null): void {
    this.permanentError = err;
  }

  /** Returns total records emitted. */
  getEmittedCount(): number {
    return this.emittedCount;
  }

  /** Returns total pages returned. */
  getPageCount(): number {
    return this.pageCount;
  }

  /** Peek at the next token that will be emitted (without advancing). */
  peekNextToken(): string {
    return String(this.nextToken);
  }

  /** Reset the fake to its initial state for a given start token. */
  reset(startToken: number | bigint = 1000): void {
    this.nextToken = BigInt(startToken);
    this.emittedCount = 0;
    this.pageCount = 0;
    this.injectErrorOnce = false;
    this.permanentError = null;
  }
}

// ---------------------------------------------------------------------------
// HorizonFake (original, extended)
// ---------------------------------------------------------------------------

export class HorizonFake extends EventEmitter {
  private failureProfile: FailureProfile = {};
  private requestCount = 0;
  private ledgerSequence = 1000;
  private requestLogs: RequestLog[] = [];
  private currentCursor: string = '0';

  setFailureProfile(profile: FailureProfile) {
    this.failureProfile = profile;
    this.emit('profileChanged', profile);
  }

  getFailureProfile(): FailureProfile {
    return this.failureProfile;
  }

  async simulateRequest(endpoint: string): Promise<any> {
    const startTime = Date.now();
    this.requestCount++;
    let success = true;
    let response: any;

    try {
      // Simulate latency
      if (this.failureProfile.latencyMs) {
        await new Promise(resolve => setTimeout(resolve, this.failureProfile.latencyMs));
      }

      // Simulate random errors
      if (this.failureProfile.errorRate && Math.random() < this.failureProfile.errorRate) {
        throw new Error('Random simulated error');
      }

      // Simulate dropped connection
      if (this.failureProfile.dropConnection && this.requestCount % 2 === 0) {
        throw new Error('Connection dropped mid-stream');
      }

      // Simulate partial reads
      if (this.failureProfile.partialReads) {
        response = this.generatePartialResponse(endpoint);
      }
      // Simulate reorgs
      else if (this.failureProfile.reorgDepth) {
        response = this.generateReorgResponse(this.failureProfile.reorgDepth);
      } else {
        response = this.generateNormalResponse(endpoint);
      }

      success = true;
    } catch (error) {
      success = false;
      throw error;
    } finally {
      this.requestLogs.push({
        endpoint,
        timestamp: startTime,
        success,
        latency: Date.now() - startTime
      });
    }

    return response;
  }

  private generateNormalResponse(endpoint: string): any {
    const sequence = this.ledgerSequence++;
    this.currentCursor = String(sequence);
    
    return {
      _links: { 
        self: { href: endpoint },
        next: { href: `${endpoint}?cursor=${sequence}` }
      },
      ledger: sequence,
      cursor: this.currentCursor,
      records: Array.from({ length: 5 }, (_, i) => ({
        id: `event_${sequence}_${i}`,
        type: 'transaction',
        paging_token: `${sequence}-${i}`,
        created_at: new Date().toISOString()
      }))
    };
  }

  private generatePartialResponse(endpoint: string): any {
    const sequence = this.ledgerSequence++;
    
    // Return incomplete response - missing some fields
    return {
      _links: { 
        self: { href: endpoint }
        // Missing 'next' link
      },
      // Missing ledger field
      records: Array.from({ length: 3 }, (_, i) => ({
        id: `event_${sequence}_${i}`,
        // Missing type and other fields
      }))
    };
  }

  private generateReorgResponse(depth: number): any {
    // Simulate a reorg by rolling back the ledger
    const newSequence = Math.max(1, this.ledgerSequence - depth);
    this.ledgerSequence = newSequence;
    this.currentCursor = String(newSequence);
    
    return {
      _links: { 
        self: { href: '/ledgers' },
        next: { href: `/ledgers?cursor=${newSequence}` }
      },
      ledger: newSequence,
      cursor: this.currentCursor,
      reorg: true,
      reorgDepth: depth,
      records: Array.from({ length: 3 }, (_, i) => ({
        id: `reorg_event_${newSequence}_${i}`,
        type: 'transaction',
        paging_token: `${newSequence}-${i}`,
        created_at: new Date().toISOString()
      }))
    };
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  getRequestLogs(): RequestLog[] {
    return this.requestLogs;
  }

  getCurrentCursor(): string {
    return this.currentCursor;
  }

  getLedgerSequence(): number {
    return this.ledgerSequence;
  }

  reset() {
    this.requestCount = 0;
    this.failureProfile = {};
    this.requestLogs = [];
    this.ledgerSequence = 1000;
    this.currentCursor = '0';
    this.emit('reset');
  }
}
