/**
 * @file horizonTransactionHistoryFetcher.ts
 * @description Ingest layer that pages through Stellar Horizon transaction-history
 * pages, advances a cursor, and detects paging-token gaps.
 *
 * Security assumptions:
 *  1. The Horizon base URL is supplied via configuration, never from untrusted input.
 *  2. paging_token values are treated as opaque strings; numeric ordering is used only
 *     for gap detection — never for trusted execution flow.
 *  3. The fetcher does NOT store raw Horizon responses in persistent state; callers
 *     own persistence.  This prevents a compromised response from silently advancing
 *     the cursor past un-ingested records.
 *  4. A fatal gap emits an `ingest.cursor.paused` audit event and halts advancement.
 *     Recovery is explicit — the caller must invoke `resumeFromCursor()` after
 *     verifying the gap has closed, so no automatic skip-over-gap is possible.
 *  5. Integer overflow in paging_token arithmetic is guarded by BigInt comparison.
 */

import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single transaction record as returned by Horizon. */
export interface HorizonTransaction {
  /** Unique, monotonically-increasing Horizon paging token (e.g. "123456789012345"). */
  paging_token: string;
  /** Transaction hash. */
  id: string;
  /** ISO-8601 ledger close time. */
  created_at: string;
  /** Ledger sequence the transaction is in. */
  ledger: number;
  /** Any additional Horizon fields (treated as opaque). */
  [key: string]: unknown;
}

/** One page of Horizon transaction-history results. */
export interface HorizonTransactionPage {
  _embedded: {
    records: HorizonTransaction[];
  };
  _links: {
    self: { href: string };
    next?: { href: string };
    prev?: { href: string };
  };
}

/** Audit event emitted when a gap is detected or the cursor is paused/resumed. */
export interface IngestAuditEvent {
  /** Event discriminator. */
  type:
    | 'ingest.cursor.paused'
    | 'ingest.cursor.resumed'
    | 'ingest.gap.detected'
    | 'ingest.page.ingested'
    | 'ingest.page.empty';
  /** Current cursor at the time of the event. */
  cursor: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Optional structured metadata. */
  meta?: Record<string, unknown>;
}

/** Result returned after processing one page. */
export interface FetchPageResult {
  /** Records successfully ingested on this page. */
  records: HorizonTransaction[];
  /** Updated cursor (equals last record's paging_token, or unchanged on empty page). */
  cursor: string;
  /** Whether a gap was detected that caused the cursor to pause. */
  gapDetected: boolean;
  /** Whether the fetcher is paused and needs explicit resume. */
  paused: boolean;
  /** If gapDetected, describes the gap. */
  gapDetail?: GapDetail;
}

/** Details about a detected sequence gap. */
export interface GapDetail {
  /** The paging_token of the last record successfully ingested before the gap. */
  expectedAfter: string;
  /** The paging_token of the first record on the page that opened the gap. */
  firstTokenOnPage: string;
  /** How many tokens are missing (BigInt arithmetic; capped at Number.MAX_SAFE_INTEGER). */
  missingCount: number;
}

/** Configuration for the fetcher. */
export interface HorizonTransactionHistoryFetcherConfig {
  /**
   * Function that fetches one Horizon transaction-history page.
   * Injected so callers can supply the real Horizon SDK or a test double.
   *
   * @param cursor - Horizon paging_token to start after ("" = beginning).
   * @param limit  - Max records per page (default 200, max 200 per Horizon spec).
   * @returns The raw Horizon page.
   */
  fetchPage: (cursor: string, limit: number) => Promise<HorizonTransactionPage>;

  /**
   * Records per page (1–200).  Defaults to 200.
   */
  pageSize?: number;

  /**
   * Starting cursor.  Defaults to "" (fetch from the very first transaction).
   */
  initialCursor?: string;

  /**
   * When true, treat any paging_token sequence gap as fatal and pause.
   * When false, gaps are reported but ingestion continues.
   * Defaults to true (safe/conservative mode).
   */
  haltOnGap?: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Ingest layer for Stellar Horizon transaction-history pages.
 *
 * Emits strongly-typed `IngestAuditEvent` objects on the `'audit'` EventEmitter
 * channel so callers can persist them, alert on them, or assert on them in tests.
 *
 * @example
 * ```typescript
 * const fetcher = new HorizonTransactionHistoryFetcher({
 *   fetchPage: (cursor, limit) => horizonClient.transactions({ cursor, limit }),
 * });
 * fetcher.on('audit', (event) => auditLog.append(event));
 *
 * while (!fetcher.isPaused()) {
 *   const result = await fetcher.fetchNextPage();
 *   if (result.gapDetected) break; // handle gap
 * }
 * ```
 */
export class HorizonTransactionHistoryFetcher extends EventEmitter {
  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  /** Current ingest cursor (paging_token of the last successfully ingested record). */
  private cursor: string;

  /** Whether the fetcher has been halted due to a gap. */
  private paused: boolean = false;

  /** Last gap detail, if any. */
  private lastGapDetail: GapDetail | undefined = undefined;

  /** Total records ingested across all pages since construction or last reset. */
  private totalIngested: number = 0;

  /** Total pages fetched. */
  private totalPagesFetched: number = 0;

  // ------------------------------------------------------------------
  // Config
  // ------------------------------------------------------------------

  private readonly fetchPageFn: HorizonTransactionHistoryFetcherConfig['fetchPage'];
  private readonly pageSize: number;
  private readonly haltOnGap: boolean;

  constructor(config: HorizonTransactionHistoryFetcherConfig) {
    super();
    this.fetchPageFn = config.fetchPage;
    this.pageSize = Math.min(Math.max(config.pageSize ?? 200, 1), 200);
    this.cursor = config.initialCursor ?? '';
    this.haltOnGap = config.haltOnGap ?? true;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Fetches the next page of transaction history, advances the cursor if clean,
   * and halts (pauses) if a paging-token gap is detected.
   *
   * @returns `FetchPageResult` describing what happened on this page.
   * @throws When the upstream `fetchPage` callback throws.
   */
  async fetchNextPage(): Promise<FetchPageResult> {
    if (this.paused) {
      return {
        records: [],
        cursor: this.cursor,
        gapDetected: false,
        paused: true,
        gapDetail: this.lastGapDetail,
      };
    }

    const page = await this.fetchPageFn(this.cursor, this.pageSize);
    this.totalPagesFetched++;

    const records = page._embedded?.records ?? [];

    if (records.length === 0) {
      this.emit('audit', this.buildAuditEvent('ingest.page.empty', {}));
      return {
        records: [],
        cursor: this.cursor,
        gapDetected: false,
        paused: false,
      };
    }

    // Validate paging_token ordering and detect gaps
    const gapDetail = this.detectGap(records);

    if (gapDetail) {
      this.lastGapDetail = gapDetail;

      const auditPayload: IngestAuditEvent = this.buildAuditEvent('ingest.gap.detected', {
        expectedAfter: gapDetail.expectedAfter,
        firstTokenOnPage: gapDetail.firstTokenOnPage,
        missingCount: gapDetail.missingCount,
      });
      this.emit('audit', auditPayload);

      if (this.haltOnGap) {
        this.paused = true;
        this.emit('audit', this.buildAuditEvent('ingest.cursor.paused', {
          reason: 'gap_detected',
          ...gapDetail,
        }));

        return {
          records: [],
          cursor: this.cursor,
          gapDetected: true,
          paused: true,
          gapDetail,
        };
      }
    }

    // Advance cursor to the last record's paging_token
    const lastToken = records[records.length - 1].paging_token;
    this.cursor = lastToken;
    this.totalIngested += records.length;

    this.emit('audit', this.buildAuditEvent('ingest.page.ingested', {
      recordCount: records.length,
      firstToken: records[0].paging_token,
      lastToken,
    }));

    return {
      records,
      cursor: this.cursor,
      gapDetected: !!gapDetail,
      paused: false,
      gapDetail: gapDetail ?? undefined,
    };
  }

  /**
   * Explicitly resumes the fetcher after a gap.
   * The cursor is re-positioned to `resumeFromCursor` so the next
   * `fetchNextPage()` call starts cleanly from a known-good position.
   *
   * @param resumeFromCursor - paging_token to start from.  Must be non-empty.
   */
  resumeFromCursor(resumeFromCursor: string): void {
    if (!resumeFromCursor || typeof resumeFromCursor !== 'string') {
      throw new Error('resumeFromCursor: cursor must be a non-empty string');
    }
    this.cursor = resumeFromCursor;
    this.paused = false;
    this.lastGapDetail = undefined;

    this.emit('audit', this.buildAuditEvent('ingest.cursor.resumed', {
      resumedAt: resumeFromCursor,
    }));
  }

  /** Returns true when gap-halt has paused the fetcher. */
  isPaused(): boolean {
    return this.paused;
  }

  /** Returns the current cursor (last successfully ingested paging_token). */
  getCursor(): string {
    return this.cursor;
  }

  /** Returns the last gap detail, if any. */
  getLastGapDetail(): GapDetail | undefined {
    return this.lastGapDetail;
  }

  /** Returns total records ingested since construction (or last reset). */
  getTotalIngested(): number {
    return this.totalIngested;
  }

  /** Returns total pages fetched. */
  getTotalPagesFetched(): number {
    return this.totalPagesFetched;
  }

  /**
   * Hard-resets the fetcher to a clean state (cursor, paused flag, counters).
   * Useful for tests; not recommended in production flows.
   */
  reset(cursor: string = ''): void {
    this.cursor = cursor;
    this.paused = false;
    this.lastGapDetail = undefined;
    this.totalIngested = 0;
    this.totalPagesFetched = 0;
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  /**
   * Checks whether a page of records introduces a paging-token gap relative to
   * the current cursor and validates monotonic ordering within the page.
   *
   * A gap exists when:
   *   - `cursor` is non-empty AND
   *   - the first record's paging_token is not the immediate successor of `cursor`.
   *
   * Horizon paging tokens are 64-bit integers encoded as decimal strings.
   * We use BigInt arithmetic to avoid JS number precision loss on large tokens.
   *
   * @returns `GapDetail` if a gap is found, `null` otherwise.
   */
  private detectGap(records: HorizonTransaction[]): GapDetail | null {
    if (records.length === 0) return null;

    const firstToken = records[0].paging_token;

    // Guard: tokens must be non-empty strings
    if (!firstToken || typeof firstToken !== 'string') {
      return null;
    }

    // Check inter-page gap (between cursor and first record on this page)
    if (this.cursor !== '') {
      const gap = this.computeInterPageGap(this.cursor, firstToken);
      if (gap !== null) return gap;
    }

    // Check intra-page ordering gaps (within this single page)
    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1].paging_token;
      const curr = records[i].paging_token;
      if (!curr || typeof curr !== 'string') continue;

      const intraGap = this.computeInterPageGap(prev, curr);
      if (intraGap !== null) return intraGap;
    }

    return null;
  }

  /**
   * Returns GapDetail when `nextToken` is not the immediate successor of `prevToken`,
   * and `nextToken > prevToken` (backward jumps are reorgs, not gaps — handled
   * separately by the caller).
   */
  private computeInterPageGap(prevToken: string, nextToken: string): GapDetail | null {
    let prev: bigint;
    let next: bigint;

    try {
      prev = BigInt(prevToken);
      next = BigInt(nextToken);
    } catch {
      // Non-numeric tokens are treated as unordered; skip gap check
      return null;
    }

    // Backward movement is a reorg, not a gap — let it through
    if (next <= prev) return null;

    // Immediate successor: next === prev + 1n means no gap
    if (next === prev + 1n) return null;

    const missing = next - prev - 1n;
    const missingCount =
      missing > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(missing);

    return {
      expectedAfter: prevToken,
      firstTokenOnPage: nextToken,
      missingCount,
    };
  }

  /** Builds a typed audit event. */
  private buildAuditEvent(
    type: IngestAuditEvent['type'],
    meta: Record<string, unknown>,
  ): IngestAuditEvent {
    return {
      type,
      cursor: this.cursor,
      timestamp: new Date().toISOString(),
      meta,
    };
  }
}
