/**
 * AccountingExportFormatter — serializes double-entry ledger lines into
 * CSV or JSON-Lines (JSONL) payloads for downstream accounting systems.
 *
 * Both formats include a trailing checksum row / line so consumers can verify
 * the export was not truncated or tampered with in transit, plus an export-id
 * header line to support replay detection.
 */

import { LedgerLine, LedgerExport } from './accountingLedgerService';

export const LEDGER_CSV_COLUMNS = [
  'id',
  'entry_date',
  'account_code',
  'memo',
  'side',
  'amount',
  'currency',
  'source_type',
  'source_id',
  'offering_id',
  'period_id',
  'run_id',
] as const;

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(values: Array<string | undefined>): string {
  return values.map((v) => csvEscape(v ?? '')).join(',');
}

/**
 * Serialize a full ledger export into CSV text.
 * @param exportObj The ledger export (lines + totals + checksum).
 * @returns CSV text including header, data rows, and a trailing checksum row.
 */
export function ledgerExportToCsv(exportObj: LedgerExport): string {
  const rows: string[] = [];
  rows.push(`# export_id=${exportObj.export_id}`);
  rows.push(toCsvRow(LEDGER_CSV_COLUMNS.slice() as unknown as string[]));

  for (const line of exportObj.lines) {
    rows.push(
      toCsvRow(
        LEDGER_CSV_COLUMNS.map((col) => line[col as keyof LedgerLine] as string),
      ),
    );
  }

  // Trailing checksum row (comment line) for tamper / truncation detection.
  rows.push(`# checksum=${
    exportObj.checksum
  } lines=${exportObj.totals.line_count} balanced=${exportObj.totals.balanced}`);
  rows.push(`# total_debit=${exportObj.totals.total_debit} total_credit=${
    exportObj.totals.total_credit
  }`);

  return rows.join('\n') + '\n';
}

function jsonlEscape(line: LedgerLine): string {
  return JSON.stringify({
    id: line.id,
    entry_date: line.entry_date,
    account_code: line.account_code,
    memo: line.memo,
    side: line.side,
    amount: line.amount,
    currency: line.currency,
    source_type: line.source_type,
    source_id: line.source_id,
    offering_id: line.offering_id,
    period_id: line.period_id,
    run_id: line.run_id,
  });
}

/**
 * Serialize a full ledger export into JSON-Lines text.
 * @param exportObj The ledger export.
 * @returns JSONL text including a manifest line, data lines, and a trailing
 *         checksum line.
 */
export function ledgerExportToJsonl(exportObj: LedgerExport): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ manifest: 'ledger-export', export_id: exportObj.export_id }));

  for (const line of exportObj.lines) {
    lines.push(jsonlEscape(line));
  }

  lines.push(
    JSON.stringify({
      checksum: exportObj.checksum,
      lines: exportObj.totals.line_count,
      balanced: exportObj.totals.balanced,
      total_debit: exportObj.totals.total_debit,
      total_credit: exportObj.totals.total_credit,
    }),
  );

  return lines.join('\n') + '\n';
}

/**
 * Resolve the export format from an HTTP Accept header.
 * Defaults to CSV when no recognised media type is offered.
 * @param accept The value of the `Accept` request header (may be undefined).
 * @returns 'csv' or 'jsonl'.
 */
export function resolveExportFormat(accept: string | undefined): 'csv' | 'jsonl' {
  if (!accept) return 'csv';
  const normalized = accept.toLowerCase();
  if (normalized.includes('json') || normalized.includes('application/x-jsonlines')) {
    return 'jsonl';
  }
  return 'csv';
}
