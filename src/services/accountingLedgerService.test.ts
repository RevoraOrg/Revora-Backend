import {
  AccountingLedgerService,
  ACCOUNT_CODES,
  computeChecksum,
  stableSerialize,
  sumDecimal,
  ledgerLineId,
  DistributionRunLedger,
} from './accountingLedgerService';

function makeRun(overrides: Partial<DistributionRunLedger> = {}, payoutCount = 1): DistributionRunLedger {
  const id = overrides.id ?? 'run-1';
  const payouts = Array.from({ length: payoutCount }, (_, i) => ({
    id: `${id}-p${i}`,
    investor_id: `inv-${i}`,
    amount: '50.00',
    status: 'processed' as const,
    tx_hash: null,
    frozen_fx_rate_id: null,
    created_at: new Date('2026-07-02T00:00:00Z'),
    updated_at: new Date('2026-07-02T00:00:00Z'),
  }));
  return {
    id,
    offering_id: 'off-1',
    period_id: 'period-1',
    total_amount: '100.00',
    status: 'completed',
    run_at: new Date('2026-07-01T00:00:00Z'),
    payouts,
    ...overrides,
  } as DistributionRunLedger;
}

describe('AccountingLedgerService', () => {
  const service = new AccountingLedgerService();

  describe('buildDistributionLedgerLines', () => {
    it('produces balanced double-entry lines for a distribution with payouts', () => {
      const run = makeRun({}, 2);
      const lines = service.buildDistributionLedgerLines([run]);

      // Each run contributes 2 lines, each payout contributes 2 lines.
      expect(lines).toHaveLength(2 + 4);

      const debits = lines.filter((l) => l.side === 'debit');
      const credits = lines.filter((l) => l.side === 'credit');

      const debitSum = debits.reduce((s, l) => sumDecimal(s, l.amount), '0');
      const creditSum = credits.reduce((s, l) => sumDecimal(s, l.amount), '0');
      expect(debitSum).toBe(creditSum);
    });

    it('assigns the expected account codes for distribution and payout lines', () => {
      const run = makeRun();
      const lines = service.buildDistributionLedgerLines([run]);

      const distributionDebit = lines.find(
        (l) => l.source_type === 'distribution' && l.side === 'debit',
      );
      const distributionCredit = lines.find(
        (l) => l.source_type === 'distribution' && l.side === 'credit',
      );
      expect(distributionDebit?.account_code).toBe(ACCOUNT_CODES.DISTRIBUTION_EXPENSE);
      expect(distributionCredit?.account_code).toBe(ACCOUNT_CODES.DISTRIBUTION_PAYABLE);

      const payoutDebit = lines.find(
        (l) => l.source_type === 'payout' && l.side === 'debit',
      );
      const payoutCredit = lines.find(
        (l) => l.source_type === 'payout' && l.side === 'credit',
      );
      expect(payoutDebit?.account_code).toBe(ACCOUNT_CODES.DISTRIBUTION_PAYABLE);
      expect(payoutCredit?.account_code).toBe(ACCOUNT_CODES.INVESTOR_PAYOUT);
    });

    it('is deterministic: identical input yields identical ids and order', () => {
      const run = makeRun();
      const a = service.buildDistributionLedgerLines([run]);
      const b = service.buildDistributionLedgerLines([run]);
      expect(a.map((l) => l.id)).toEqual(b.map((l) => l.id));
      expect(a.map((l) => l.memo)).toEqual(b.map((l) => l.memo));
    });

    it('handles an empty input set', () => {
      const lines = service.buildDistributionLedgerLines([]);
      expect(lines).toHaveLength(0);
    });

    it('handles a distribution with no payouts (still a balanced pair)', () => {
      const run = makeRun({ payouts: [] });
      const lines = service.buildDistributionLedgerLines([run]);
      expect(lines).toHaveLength(2);
      expect(lines.filter((l) => l.side === 'debit')).toHaveLength(1);
      expect(lines.filter((l) => l.side === 'credit')).toHaveLength(1);
    });

    it('supports multiple periods and offerings in one export', () => {
      const run1 = makeRun({ id: 'run-1', offering_id: 'off-1', period_id: 'period-1' });
      const run2 = makeRun({ id: 'run-2', offering_id: 'off-2', period_id: 'period-2' });
      const lines = service.buildDistributionLedgerLines([run1, run2]);
      const offeringIds = new Set(lines.map((l) => l.offering_id));
      expect(offeringIds).toEqual(new Set(['off-1', 'off-2']));
    });

    it('accepts string entry dates for backward-compatible row shapes', () => {
      const stringRun = makeRun({ run_at: '2026-07-01T00:00:00Z' as unknown as Date });
      const lines = service.buildDistributionLedgerLines([stringRun]);
      expect(lines[0].entry_date).toBe('2026-07-01T00:00:00Z');
    });
  });

  describe('buildExport', () => {
    it('returns export_id, checksum, and balanced totals', () => {
      const run = makeRun({}, 2);
      const lines = service.buildDistributionLedgerLines([run]);
      const exportObj = service.buildExport(lines);

      expect(exportObj.export_id).toBeTruthy();
      expect(exportObj.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(exportObj.totals.balanced).toBe(true);
      expect(exportObj.totals.total_debit).toBe(exportObj.totals.total_credit);
      expect(exportObj.totals.line_count).toBe(lines.length);
    });

    it('is idempotent: same lines yield same export_id and checksum', () => {
      const run = makeRun();
      const lines = service.buildDistributionLedgerLines([run]);
      const a = service.buildExport(lines);
      const b = service.buildExport(service.buildDistributionLedgerLines([run]));
      expect(a.export_id).toBe(b.export_id);
      expect(a.checksum).toBe(b.checksum);
    });
  });
});

describe('accounting helpers', () => {
  describe('computeChecksum', () => {
    it('produces a stable sha256 hex digest', () => {
      expect(computeChecksum('hello')).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      );
    });
  });

  describe('stableSerialize', () => {
    it('sorts object keys so field order does not change output', () => {
      const a = stableSerialize({ b: 1, a: 2, c: 3 });
      const b = stableSerialize({ c: 3, b: 1, a: 2 });
      expect(a).toBe(b);
    });
  });

  describe('sumDecimal', () => {
    it('adds decimal strings exactly', () => {
      expect(sumDecimal('1000.00', '12.34')).toBe('1012.34');
      expect(sumDecimal('0.01', '0.02')).toBe('0.03');
      expect(sumDecimal('5', '7')).toBe('12');
      expect(sumDecimal('999.99', '0.01')).toBe('1000.00');
    });
  });

  describe('ledgerLineId', () => {
    it('is deterministic for identical inputs and distinct for different sides', () => {
      const id1 = ledgerLineId('payout', 'p-1', ACCOUNT_CODES.INVESTOR_PAYOUT, 'credit');
      const id2 = ledgerLineId('payout', 'p-1', ACCOUNT_CODES.INVESTOR_PAYOUT, 'credit');
      const idDebit = ledgerLineId('payout', 'p-1', ACCOUNT_CODES.DISTRIBUTION_PAYABLE, 'debit');
      expect(id1).toBe(id2);
      expect(id1).not.toBe(idDebit);
      expect(id1).toHaveLength(24);
    });
  });
});
