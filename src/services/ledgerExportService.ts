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
}

export interface LedgerExportRepository {
  findByGlAccount(
    glAccount: string,
    limit: number,
    afterId?: string,
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

export class LedgerExportService {
  constructor(private readonly repo: LedgerExportRepository) {}

  async byGlAccount(
    glAccount: string,
    limit: number,
    cursor?: string,
  ): Promise<LedgerExportResponse> {
    let afterId: string | undefined;
    if (cursor) {
      const payload = verifyCursor(cursor, glAccount);
      if (!payload) {
        throw Object.assign(new Error('Invalid or tampered cursor'), { statusCode: 400, code: 'INVALID_CURSOR' });
      }
      afterId = payload.id;
    }

    const { entries, total, hasMore } = await this.repo.findByGlAccount(glAccount, limit, afterId);
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

    return {
      entries,
      totals,
      next_cursor,
      has_more: hasMore,
    };
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
  ): Promise<{ entries: LedgerEntry[]; total: number; hasMore: boolean }> {
    const filtered = this.entries
      .filter((e) => e.gl_account === glAccount)
      .sort((a, b) => a.id.localeCompare(b.id));

    const afterIndex = afterId
      ? filtered.findIndex((e) => e.id === afterId) + 1
      : 0;

    const sliced = filtered.slice(afterIndex, afterIndex + limit);
    const hasMore = filtered.length > afterIndex + limit;
    return { entries: sliced, total: filtered.length, hasMore };
  }
}
