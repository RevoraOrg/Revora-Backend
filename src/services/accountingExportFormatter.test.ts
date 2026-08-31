import {
  LEDGER_CSV_COLUMNS,
  ledgerExportToCsv,
  ledgerExportToJsonl,
  resolveExportFormat,
} from './accountingExportFormatter';
import { AccountingLedgerService, LedgerExport } from './accountingLedgerService';

function makeExport(): LedgerExport {
  const service = new AccountingLedgerService();
  const run = {
    id: 'run-1',
    offering_id: 'off-1',
    period_id: 'period-1',
    total_amount: '100.00',
    status: 'completed' as const,
    run_at: new Date('2026-07-01T00:00:00Z'),
    payouts: [
      {
        id: 'p-1',
        investor_id: 'inv-1',
        amount: '100.00',
        status: 'processed' as const,
        tx_hash: null,
        frozen_fx_rate_id: null,
        created_at: new Date('2026-07-02T00:00:00Z'),
        updated_at: new Date('2026-07-02T00:00:00Z'),
      },
    ],
  };
  const lines = service.buildDistributionLedgerLines([run]);
  return service.buildExport(lines);
}

describe('accountingExportFormatter', () => {
  describe('ledgerExportToCsv', () => {
    it('includes a header row, data rows, and a trailing checksum row', () => {
      const csv = ledgerExportToCsv(makeExport());
      const rows = csv.trim().split('\n');

      expect(rows[0]).toContain('# export_id=');
      expect(rows[1]).toBe(LEDGER_CSV_COLUMNS.join(','));

      const header = rows[1].split(',');
      expect(header).toEqual([
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
      ]);

      // 1 export_id + 1 header + 4 data lines + 2 checksum lines
      expect(rows.length).toBe(8);
      expect(rows.some((r) => r.startsWith('# checksum='))).toBe(true);
      expect(rows.some((r) => r.startsWith('# total_debit='))).toBe(true);
    });

    it('escapes commas, quotes and newlines in memo fields', () => {
      const service = new AccountingLedgerService();
      const lines = service.buildDistributionLedgerLines([
        {
          id: 'run-1',
          offering_id: 'off,1"x',
          period_id: 'period-1',
          total_amount: '100.00',
          status: 'completed',
          run_at: new Date('2026-07-01T00:00:00Z'),
          payouts: [],
        },
      ]);
      const csv = ledgerExportToCsv(service.buildExport(lines));
      expect(csv).toContain('"');
    });

    it('emits a checksum row matching the export checksum', () => {
      const exportObj = makeExport();
      const csv = ledgerExportToCsv(exportObj);
      expect(csv).toContain(`# checksum=${exportObj.checksum}`);
    });
  });

  describe('ledgerExportToJsonl', () => {
    it('emits a manifest line, data lines, and a trailing checksum line', () => {
      const exportObj = makeExport();
      const jsonl = ledgerExportToJsonl(exportObj).trim().split('\n');

      expect(JSON.parse(jsonl[0])).toEqual({
        manifest: 'ledger-export',
        export_id: exportObj.export_id,
      });

      const dataLines = jsonl.slice(1, -1);
      expect(dataLines).toHaveLength(4);

      const checksumLine = JSON.parse(jsonl[jsonl.length - 1]);
      expect(checksumLine.checksum).toBe(exportObj.checksum);
      expect(checksumLine.balanced).toBe(true);

      // Each data line carries a debit/credit amount and account code.
      for (const raw of dataLines) {
        const line = JSON.parse(raw);
        expect(line.account_code).toBeTruthy();
        expect(['debit', 'credit']).toContain(line.side);
        expect(line.amount).toBeTruthy();
      }
    });

    it('is valid JSON-Lines (one JSON object per line)', () => {
      const jsonl = ledgerExportToJsonl(makeExport()).trim().split('\n');
      for (const line of jsonl) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });
  });

  describe('resolveExportFormat', () => {
    it('defaults to csv for absent or wildcard accept', () => {
      expect(resolveExportFormat(undefined)).toBe('csv');
      expect(resolveExportFormat('*/*')).toBe('csv');
      expect(resolveExportFormat('text/plain')).toBe('csv');
    });

    it('returns jsonl when json is offered', () => {
      expect(resolveExportFormat('application/json')).toBe('jsonl');
      expect(resolveExportFormat('application/x-jsonlines')).toBe('jsonl');
      expect(resolveExportFormat('application/json,text/csv')).toBe('jsonl');
    });
  });
});
