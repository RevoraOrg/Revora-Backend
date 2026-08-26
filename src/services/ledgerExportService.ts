import { createHash } from 'crypto';
import { signCursor, verifyCursor, CursorPayload } from '../lib/pagination';

export interface LedgerEntry {
  id: string;
  gl_account: string;
  entry_date: string;
  description: string;
  debit_amount: string;
  credit_amount: string;
  currency: string;
  recorded_at: string;
  entry_type: string;
}

export interface TotalsRow {
  total_debit: string;
  total_credit: string;
  entry_count: number;
}

export interface LedgerExportResponse {
  entries: LedgerEntry[];
  totals: TotalsRow;
  next_cursor?: string;
  has_more: boolean;
  /** SHA-256 hash of the deterministic export (only present in snapshot mode) */
  content_sha256?: string;
}

export interface SnapshotExportOptions {
  /** Enable snapshot mode for byte-for-byte reproducible exports */
  snapshot?: boolean;
  /** Optional snapshot cutoff timestamp - entries after this time are excluded */
  cutoff_at?: string;
}

export interface LedgerExportRepository {
  findByGlAccount(
    glAccount: string,
    limit: number,
    afterId?: string,
    options?: SnapshotExportOptions,
  ): Promise<{ entries: LedgerEntry[]; total: number; hasMore: boolean }>;
}

function sumDecimal(a: string, b: string): string {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const intA = partsA[0];
  const fracA = partsA[1] ?? '';
  const intB = partsB[0];
  const fracB = partsB[1] ?? '';
  const maxFracLen = Math.max(fracA.length, fracB.length);
  const normA = intA + fracA.padEnd(maxFracLen, '0');
  const normB = intB + fracB.padEnd(maxFracLen, '0');
  const sum = BigInt(normA) + BigInt(normB);
  const sumStr = sum.toString();
  const pad = maxFracLen > 0 ? maxFracLen : 0;
  if (pad === 0) return sumStr;
  const padded = sumStr.padStart(pad + 1, '0');
  const ip = padded.slice(0, padded.length - pad);
  const fp = padded.slice(padded.length - pad);
  return `${ip || '0'}.${fp}`;
}

function computeTotals(entries: LedgerEntry[]): TotalsRow {
  let totalDebit = '0';
  let totalCredit = '0';
  for (const entry of entries) {
    totalDebit = sumDecimal(totalDebit, entry.debit_amount);
    totalCredit = sumDecimal(totalCredit, entry.credit_amount);
  }
  return {
    total_debit: totalDebit,
    total_credit: totalCredit,
    entry_count: entries.length,
  };
}

/**
 * Compute SHA-256 hash of deterministic export content.
 * Deterministic ordering: entries sorted by (entry_date ASC, id ASC).
 * Format: one JSON object per line (JSONL), no trailing newline in hash input.
 *
 * @param entries The ledger entries to hash
 * @returns SHA-256 hash as hex string
 */
export function computeExportHash(entries: LedgerEntry[]): string {
  // Deterministic sort: by entry_date first, then by id for tie-breaking
  const sorted = [...entries].sort((a, b) => {
    const dateCompare = a.entry_date.localeCompare(b.entry_date);
    if (dateCompare !== 0) return dateCompare;
    return a.id.localeCompare(b.id);
  });

  const lines = sorted.map((entry) => JSON.stringify(entry));
  const canonical = lines.join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Validate snapshot cutoff timestamp format (ISO 8601).
 * Returns true if valid, false otherwise.
 */
export function isValidCutoffTimestamp(cutoff: string): boolean {
  if (!cutoff || cutoff.trim().length === 0) return false;
  const date = new Date(cutoff);
  return !isNaN(date.getTime());
}

export class LedgerExportService {
  constructor(private readonly repo: LedgerExportRepository) {}

  async byGlAccount(
    glAccount: string,
    limit: number,
    cursor?: string,
    options?: SnapshotExportOptions,
  ): Promise<LedgerExportResponse> {
    let afterId: string | undefined;
    if (cursor) {
      const payload = verifyCursor(cursor, glAccount);
      if (!payload) {
        throw Object.assign(new Error('Invalid or tampered cursor'), { statusCode: 400, code: 'INVALID_CURSOR' });
      }
      afterId = payload.id;
    }

    // Build snapshot options with validation
    const snapshotOptions: SnapshotExportOptions = {};
    if (options?.snapshot) {
      snapshotOptions.snapshot = true;
      if (options.cutoff_at) {
        if (!isValidCutoffTimestamp(options.cutoff_at)) {
          throw Object.assign(new Error('Invalid cutoff_at timestamp format'), {
            statusCode: 400,
            code: 'INVALID_CUTOFF',
          });
        }
        snapshotOptions.cutoff_at = options.cutoff_at;
      }
    }

    const { entries, total, hasMore } = await this.repo.findByGlAccount(glAccount, limit, afterId, snapshotOptions);
    const totals = computeTotals(entries);

    let next_cursor: string | undefined;
    if (hasMore && entries.length > 0) {
      const lastEntry = entries[entries.length - 1];
      const payload: CursorPayload = {
        id: lastEntry.id,
        gl: glAccount,
        t: Date.now(),
      };
      next_cursor = signCursor(payload);
    }

    const response: LedgerExportResponse = {
      entries,
      totals,
      next_cursor,
      has_more: hasMore,
    };

    // In snapshot mode, compute and include the SHA-256 hash
    if (snapshotOptions.snapshot && entries.length > 0) {
      response.content_sha256 = computeExportHash(entries);
    }

    return response;
  }
}

export class InMemoryLedgerRepository implements LedgerExportRepository {
  private entries: LedgerEntry[] = [];

  constructor(seed?: LedgerEntry[]) {
    if (seed) {
      this.entries = [...seed];
    }
  }

  addEntries(entries: LedgerEntry[]): void {
    this.entries.push(...entries);
  }

  async findByGlAccount(
    glAccount: string,
    limit: number,
    afterId?: string,
    options?: SnapshotExportOptions,
  ): Promise<{ entries: LedgerEntry[]; total: number; hasMore: boolean }> {
    let filtered = this.entries
      .filter((e) => e.gl_account === glAccount);

    // In snapshot mode, filter out entries after cutoff
    if (options?.snapshot && options.cutoff_at) {
      const cutoffDate = new Date(options.cutoff_at).toISOString();
      filtered = filtered.filter((e) => {
        const recordedAt = new Date(e.recorded_at).toISOString();
        return recordedAt <= cutoffDate;
      });
    }

    // In snapshot mode, use deterministic sort (entry_date ASC, id ASC)
    if (options?.snapshot) {
      filtered = filtered.sort((a, b) => {
        const dateCompare = a.entry_date.localeCompare(b.entry_date);
        if (dateCompare !== 0) return dateCompare;
        return a.id.localeCompare(b.id);
      });
    } else {
      filtered = filtered.sort((a, b) => a.id.localeCompare(b.id));
    }

    const afterIndex = afterId
      ? filtered.findIndex((e) => e.id === afterId) + 1
      : 0;

    const sliced = filtered.slice(afterIndex, afterIndex + limit);
    const hasMore = filtered.length > afterIndex + limit;
    return { entries: sliced, total: filtered.length, hasMore };
  }
}
