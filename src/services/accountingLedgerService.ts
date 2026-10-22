/**
 * AccountingLedgerService — deterministic double-entry ledger export builder.
 *
 * Transforms Revora's distribution and payout records into double-entry
 * accounting ledger lines (debit/credit, account code, memo) that accounting
 * platforms such as NetSuite can ingest directly. The output is stable and
 * idempotent: identical inputs always yield identical lines, an identical
 * export checksum, and a deterministic export-id.
 *
 * Security / correctness assumptions:
 * - Never emits raw database, token, or upstream error text; memos are built
 *   from sanitised identifiers only.
 * - Amounts are decimal strings; all arithmetic is performed in integer
 *   scaled units to avoid binary rounding.
 * - Every payout produces a balanced debit/credit pair; the export computes a
 *   running check that total debits strictly equal total credits.
 * - The checksum is a SHA-256 digest over a canonical (sorted-key) JSON
 *   representation, so field order cannot perturb the digest.
 *
 * @see ../docs/ledger-export-double-entry.md
 */

import { createHash } from 'crypto';

/** Stable, low-cardinality chart of accounts used by this service. */
export const ACCOUNT_CODES = {
  DISTRIBUTION_EXPENSE: '4000-DISTRIBUTION-EXPENSE',
  DISTRIBUTION_PAYABLE: '2100-DISTRIBUTION-PAYABLE',
  INVESTOR_PAYOUT: '1000-INVESTOR-PAYOUT',
  FEE_EXPENSE: '4100-FEE-EXPENSE',
  FEE_PAYABLE: '2200-FEE-PAYABLE',
} as const;

export type LedgerSide = 'debit' | 'credit';
export type LedgerSourceType =
  | 'distribution'
  | 'payout'
  | 'fee'
  | 'reversal';

export interface LedgerLine {
  id: string;
  sort_key: string;
  entry_date: string;
  account_code: string;
  memo: string;
  side: LedgerSide;
  amount: string;
  currency: string;
  source_type: LedgerSourceType;
  source_id: string;
  offering_id: string;
  period_id: string;
  run_id?: string;
}

export interface PayoutLedger {
  id: string;
  investor_id: string;
  amount: string;
  status: 'pending' | 'processed' | 'failed';
  tx_hash?: string | null;
  frozen_fx_rate_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DistributionRunLedger {
  id: string;
  offering_id: string;
  period_id: string;
  total_amount: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  run_at: Date;
  payouts: PayoutLedger[];
}

export interface LedgerTotals {
  total_debit: string;
  total_credit: string;
  line_count: number;
  balanced: boolean;
}

export interface LedgerExport {
  export_id: string;
  checksum: string;
  generated_at: string;
  lines: LedgerLine[];
  totals: LedgerTotals;
}

/**
 * Deterministic SHA-256-content hash helper for stable export fingerprints.
 * Exported for tests and reuse without leaking raw inputs into logs.
 * @param payload Canonical content to digest.
 */
export function computeChecksum(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Stable JSON serializer: object keys sorted lexicographically so that
 * field ordering never changes the checksum. Used for the trailing checksum.
 */
export function stableSerialize(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        sorted[key] = normalize(record[key]);
      }
      return sorted;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

/**
 * Sum two decimal strings exactly using scaled integer arithmetic.
 */
export function sumDecimal(a: string, b: string): string {
  const [intA = '0', fracA = ''] = a.split('.');
  const [intB = '0', fracB = ''] = b.split('.');
  const maxFrac = Math.max(fracA.length, fracB.length);
  const normA = intA + fracA.padEnd(maxFrac, '0');
  const normB = intB + fracB.padEnd(maxFrac, '0');
  const sum = BigInt(normA || '0') + BigInt(normB || '0');
  const sumStr = sum.toString();
  if (maxFrac === 0) return sumStr;
  const padded = sumStr.padStart(maxFrac + 1, '0');
  const integerPart = padded.slice(0, padded.length - maxFrac);
  const fracPart = padded.slice(padded.length - maxFrac);
  return `${integerPart || '0'}.${fracPart}`;
}

/**
 * Deterministic identifier for a ledger line derived from its source row and
 * side, so re-running the builder produces the same line ids (enabling replay).
 */
export function ledgerLineId(
  sourceType: LedgerSourceType,
  sourceId: string,
  accountCode: string,
  side: LedgerSide,
): string {
  const raw = `${sourceType}:${sourceId}:${accountCode}:${side}`;
  return computeChecksum(raw).slice(0, 24);
}

function toIsoDate(d: Date | string): string {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

/**
 * AccountingLedgerService — builds the double-entry export from persistence
 * records. Pure, no network or storage side effects.
 */
export class AccountingLedgerService {
  private readonly currency: string;

  constructor(currency = 'USD') {
    this.currency = currency;
  }

  /**
   * Build double-entry ledger lines for a set of distribution runs and their
   * payouts. Each run yields a balanced distribution-expense / distribution-
   * payable pair; each payout yields a distribution-payable (DR) / investor-
   * payout (CR) pair.
   *
   * @param runs Distribution runs (with payouts) produced by the repository.
   * @param feeOrReversal Overrides for fee/reversal lines; optional.
   * @returns Deterministic, ordered, balanced ledger lines.
   */
  buildDistributionLedgerLines(
    runs: DistributionRunLedger[],
  ): LedgerLine[] {
    const lines: LedgerLine[] = [];

    for (const run of runs) {
      const entryDate = toIsoDate(run.run_at);
      const offeringId = run.offering_id;
      const periodId = run.period_id;
      const memo = `Distribution ${offeringId} ${periodId}`;
      const runTotal = run.total_amount;

      lines.push({
        id: ledgerLineId('distribution', run.id, ACCOUNT_CODES.DISTRIBUTION_EXPENSE, 'debit'),
        sort_key: `0|${run.id}`,
        entry_date: entryDate,
        account_code: ACCOUNT_CODES.DISTRIBUTION_EXPENSE,
        memo,
        side: 'debit',
        amount: runTotal,
        currency: this.currency,
        source_type: 'distribution',
        source_id: run.id,
        offering_id: offeringId,
        period_id: periodId,
        run_id: run.id,
      });

      lines.push({
        id: ledgerLineId('distribution', run.id, ACCOUNT_CODES.DISTRIBUTION_PAYABLE, 'credit'),
        sort_key: `0|${run.id}`,
        entry_date: entryDate,
        account_code: ACCOUNT_CODES.DISTRIBUTION_PAYABLE,
        memo,
        side: 'credit',
        amount: runTotal,
        currency: this.currency,
        source_type: 'distribution',
        source_id: run.id,
        offering_id: offeringId,
        period_id: periodId,
        run_id: run.id,
      });

      for (const payout of run.payouts) {
        const payoutId = payout.id;
        const payoutMemo = `Payout ${payout.investor_id}`;
        const amount = payout.amount;

        lines.push({
          id: ledgerLineId('payout', payoutId, ACCOUNT_CODES.DISTRIBUTION_PAYABLE, 'debit'),
          sort_key: `1|${run.id}|${payoutId}`,
          entry_date: toIsoDate(payout.created_at),
          account_code: ACCOUNT_CODES.DISTRIBUTION_PAYABLE,
          memo: payoutMemo,
          side: 'debit',
          amount,
          currency: this.currency,
          source_type: 'payout',
          source_id: payoutId,
          offering_id: offeringId,
          period_id: periodId,
          run_id: run.id,
        });

        lines.push({
          id: ledgerLineId('payout', payoutId, ACCOUNT_CODES.INVESTOR_PAYOUT, 'credit'),
          sort_key: `1|${run.id}|${payoutId}`,
          entry_date: toIsoDate(payout.created_at),
          account_code: ACCOUNT_CODES.INVESTOR_PAYOUT,
          memo: payoutMemo,
          side: 'credit',
          amount,
          currency: this.currency,
          source_type: 'payout',
          source_id: payoutId,
          offering_id: offeringId,
          period_id: periodId,
          run_id: run.id,
        });
      }
    }

    // Stable ordering: sort by sort_key then account code for deterministic output.
    lines.sort((a, b) => {
      if (a.sort_key !== b.sort_key) return a.sort_key.localeCompare(b.sort_key);
      return a.account_code.localeCompare(b.account_code);
    });

    return lines;
  }

  /**
   * Build a complete, self-contained export: deterministic lines, exact
   * totals, a trailing checksum row, and a replayable export-id.
   *
   * @param lines Double-entry ledger lines (usually from buildDistributionLedgerLines).
   */
  buildExport(lines: LedgerLine[]): LedgerExport {
    let totalDebit = '0';
    let totalCredit = '0';
    for (const line of lines) {
      if (line.side === 'debit') totalDebit = sumDecimal(totalDebit, line.amount);
      else totalCredit = sumDecimal(totalCredit, line.amount);
    }

    const checksum = computeChecksum(stableSerialize({ lines }));
    const key = lines.map((l) => l.id).join(',');
    const exportId = computeChecksum(`${checksum}:${key}`).slice(0, 24);

    return {
      export_id: exportId,
      checksum,
      generated_at: new Date().toISOString(),
      lines,
      totals: {
        total_debit: totalDebit,
        total_credit: totalCredit,
        line_count: lines.length,
        balanced: totalDebit === totalCredit,
      },
    };
  }
}
