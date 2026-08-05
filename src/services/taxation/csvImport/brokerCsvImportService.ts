/**
 * Broker CSV Cost-Basis Import Service
 *
 * Establishes opening cost basis for investor lots migrated from an external
 * broker. Behavior guarantees:
 *  - Schema-validated: every row is checked against the resolved broker preset;
 *    any structural or value error rejects the whole file (no partial import).
 *  - Transactional per file: all accepted rows are written inside a single
 *    withTransaction call, so a mid-file failure rolls the file back.
 *  - Duplicate-safe: rows duplicated within the file, or matching an existing
 *    lot from a prior import, are skipped with a recorded note.
 *  - Observable: emits the tax.import.rows counter with the accepted row count.
 *
 * Security assumptions:
 *  - investor_id / offering_id are asserted by upstream auth before this runs.
 *  - Lot rows are immutable once written (enforced at the repository layer).
 *
 * @module services/taxation/csvImport/brokerCsvImportService
 */

import { Pool, PoolClient } from 'pg';
import { InvestmentLotRepository } from '../../../db/repositories/investmentLotRepository';
import { withTransaction } from '../../../db/transaction';
import { globalMetrics } from '../../../lib/metrics';
import { Errors } from '../../../lib/errors';
import { CreateInvestmentLotInput } from '../types';
import { BrokerMappingPreset, resolvePreset } from './brokerMappingPresets';
import {
  BrokerCsvImportInput,
  BrokerCsvImportResult,
  ParsedBrokerRow,
  RowError,
  SkippedRow,
} from './csvImportTypes';

/** Window (ms) around a row's acquired_at used to match existing lots. */
const DUPLICATE_MATCH_WINDOW_MS = 1000; // 1 second, same-instant tolerance

export class BrokerCsvImportService {
  constructor(
    private lotRepo: InvestmentLotRepository,
    private db: Pool,
  ) {}

  /**
   * Import one broker CSV file for one investor + offering.
   * @throws AppError (validation) if the file is structurally invalid or any
   *         row fails schema validation. On any throw, nothing is written.
   */
  async importFile(input: BrokerCsvImportInput): Promise<BrokerCsvImportResult> {
    if (!input.csv || input.csv.trim() === '') {
      throw Errors.validationError('CSV file is empty');
    }

    const preset = resolvePreset(input.broker);
    const rows = this.parseAndValidate(input.csv, preset);

    // De-duplicate within the file first (deterministic: keep the first).
    const seen = new Set<string>();
    const skippedRows: SkippedRow[] = [];
    const candidates: ParsedBrokerRow[] = [];

    for (const row of rows) {
      const key = this.rowKey(row);
      if (seen.has(key)) {
        skippedRows.push({
          sourceLine: row.sourceLine,
          reason: 'duplicate_in_file',
          note: `Row ${row.sourceLine} duplicates an earlier row in the same file; skipped.`,
        });
        continue;
      }
      seen.add(key);
      candidates.push(row);
    }

    const jurisdiction = input.jurisdiction;

    // All DB work happens inside one transaction => transactional per file.
    const importedCount = await withTransaction(this.db, async (client) => {
      let written = 0;

      for (const row of candidates) {
        const existingDuplicate = await this.matchesExistingLot(client, input, row);
        if (existingDuplicate) {
          skippedRows.push({
            sourceLine: row.sourceLine,
            reason: 'duplicate_existing_lot',
            note: `Row ${row.sourceLine} matches an existing lot from a prior import; skipped.`,
          });
          continue;
        }

        const lotInput: CreateInvestmentLotInput = {
          investor_id: input.investor_id,
          offering_id: input.offering_id,
          investment_id: input.investment_id,
          asset: row.asset,
          quantity: row.quantity,
          cost_basis_per_unit: row.cost_basis_per_unit,
          cost_currency: row.cost_currency,
          acquired_at: row.acquired_at,
          jurisdiction,
        };

        await this.lotRepo.createWithClient(client, lotInput);
        written += 1;
      }

      return written;
    });

    // Emit only after a durable commit (we are past withTransaction here).
    globalMetrics.incrementCounter(
      'tax.import.rows',
      { broker: preset.label, offering_id: input.offering_id },
      importedCount,
    );

    return {
      investor_id: input.investor_id,
      offering_id: input.offering_id,
      broker: preset.label,
      importedCount,
      skippedRows,
      totalRows: rows.length,
    };
  }

  /**
   * Parse CSV text into validated canonical rows using the broker preset.
   * Throws on the first structural problem or invalid row value.
   */
  private parseAndValidate(csv: string, preset: BrokerMappingPreset): ParsedBrokerRow[] {
    const lines = this.splitLines(csv);
    if (lines.length < 2) {
      throw Errors.validationError('CSV must contain a header row and at least one data row');
    }

    const header = this.parseLine(lines[0]).map((h) => h.trim());
    const index = this.buildColumnIndex(header, preset);

    const errors: RowError[] = [];
    const parsed: ParsedBrokerRow[] = [];

    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i];
      if (raw.trim() === '') continue; // tolerate trailing blank lines
      const sourceLine = i + 1; // 1-based, header is line 1

      const cells = this.parseLine(raw);
      const row = this.validateRow(cells, index, preset, sourceLine, errors);
      if (row) parsed.push(row);
    }

    if (errors.length > 0) {
      const detail = errors.map((e) => `line ${e.sourceLine}: ${e.message}`).join('; ');
      throw Errors.validationError(`CSV validation failed: ${detail}`);
    }

    if (parsed.length === 0) {
      throw Errors.validationError('CSV contained no valid data rows');
    }

    return parsed;
  }

  /** Map preset column names to positions in the actual header. */
  private buildColumnIndex(
    header: string[],
    preset: BrokerMappingPreset,
  ): Record<keyof BrokerMappingPreset['columns'], number> {
    const lookup = new Map<string, number>();
    header.forEach((name, i) => lookup.set(name.toLowerCase(), i));

    const find = (colName: string | undefined): number => {
      if (!colName) return -1;
      const at = lookup.get(colName.toLowerCase());
      return at === undefined ? -1 : at;
    };

    const idx = {
      asset: find(preset.columns.asset),
      quantity: find(preset.columns.quantity),
      costBasisPerUnit: find(preset.columns.costBasisPerUnit),
      acquiredAt: find(preset.columns.acquiredAt),
      currency: find(preset.columns.currency),
    };

    const missing: string[] = [];
    if (idx.asset < 0) missing.push(preset.columns.asset);
    if (idx.quantity < 0) missing.push(preset.columns.quantity);
    if (idx.costBasisPerUnit < 0) missing.push(preset.columns.costBasisPerUnit);
    if (idx.acquiredAt < 0) missing.push(preset.columns.acquiredAt);

    if (missing.length > 0) {
      throw Errors.validationError(
        `CSV is missing required columns for ${preset.label}: ${missing.join(', ')}`,
      );
    }

    return idx;
  }

  /** Validate one row's cells; push to errors and return null on failure. */
  private validateRow(
    cells: string[],
    index: Record<string, number>,
    preset: BrokerMappingPreset,
    sourceLine: number,
    errors: RowError[],
  ): ParsedBrokerRow | null {
    const cell = (at: number): string => (at >= 0 && at < cells.length ? cells[at].trim() : '');

    const asset = cell(index.asset);
    if (asset === '') {
      errors.push({ sourceLine, message: 'asset is required' });
      return null;
    }

    const quantity = Number(cell(index.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push({ sourceLine, message: 'quantity must be a positive number' });
      return null;
    }

    const costBasis = Number(cell(index.costBasisPerUnit));
    if (!Number.isFinite(costBasis) || costBasis < 0) {
      errors.push({ sourceLine, message: 'cost_basis_per_unit must be zero or greater' });
      return null;
    }

    const rawDate = cell(index.acquiredAt);
    const acquiredAt = new Date(rawDate);
    if (rawDate === '' || Number.isNaN(acquiredAt.getTime())) {
      errors.push({ sourceLine, message: 'acquired_at is not a valid date' });
      return null;
    }

    const currency =
      index.currency >= 0 && cell(index.currency) !== ''
        ? cell(index.currency).toUpperCase()
        : preset.defaultCurrency;

    return {
      asset,
      quantity,
      cost_basis_per_unit: costBasis,
      acquired_at: acquiredAt,
      cost_currency: currency,
      sourceLine,
    };
  }

  /** Stable key for within-file duplicate detection. */
  private rowKey(row: ParsedBrokerRow): string {
    return [
      row.asset.toLowerCase(),
      row.quantity,
      row.cost_basis_per_unit,
      row.acquired_at.getTime(),
      row.cost_currency,
    ].join('|');
  }

  /** True if a matching lot already exists from a prior import. */
  private async matchesExistingLot(
    client: PoolClient,
    input: BrokerCsvImportInput,
    row: ParsedBrokerRow,
  ): Promise<boolean> {
    const start = new Date(row.acquired_at.getTime() - DUPLICATE_MATCH_WINDOW_MS);
    const end = new Date(row.acquired_at.getTime() + DUPLICATE_MATCH_WINDOW_MS);

    const existing = await this.lotRepo.findByInvestorOfferingAndDateRange(
      client,
      input.investor_id,
      input.offering_id,
      start,
      end,
    );

    return existing.some(
      (lot) =>
        lot.asset.toLowerCase() === row.asset.toLowerCase() &&
        lot.quantity === row.quantity &&
        lot.cost_basis_per_unit === row.cost_basis_per_unit,
    );
  }

  // --- Minimal strict CSV parsing (no external dependency) ---

  /** Split into lines, handling \r\n and \n, without breaking quoted newlines. */
  private splitLines(csv: string): string[] {
    const out: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < csv.length; i++) {
      const ch = csv[i];
      if (ch === '"') {
        // Toggle quote state; doubled quotes handled in parseLine.
        const next = csv[i + 1];
        if (inQuotes && next === '"') {
          current += '""';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        current += ch;
        continue;
      }
      if ((ch === '\n' || ch === '\r') && !inQuotes) {
        if (ch === '\r' && csv[i + 1] === '\n') i++; // consume \r\n as one
        out.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    if (current !== '') out.push(current);
    return out;
  }

  /** Parse one CSV line into cells, honoring quotes and doubled quotes. */
  private parseLine(line: string): string[] {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (ch === ',' && !inQuotes) {
        cells.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    cells.push(current);
    return cells;
  }
}

/** Factory matching the codebase convention. */
export function createBrokerCsvImportService(db: Pool): BrokerCsvImportService {
  return new BrokerCsvImportService(new InvestmentLotRepository(db), db);
}
/**
 * Tests for BrokerCsvImportService: schema-validated, transactional-per-file
 * broker CSV cost-basis import with duplicate skipping and metrics emission.
 *
 * @module services/taxation/csvImport/brokerCsvImportService.test
 */

import { BrokerCsvImportService } from '../brokerCsvImportService';
import { InvestmentLotRepository } from '../../../../db/repositories/investmentLotRepository';
import * as transactionModule from '../../../../db/transaction';
import { globalMetrics } from '../../../../lib/metrics';
import { InvestmentLot } from '../../types';

// --- Mocks -----------------------------------------------------------------

jest.mock('../../../../db/transaction');

const mockedWithTransaction = transactionModule.withTransaction as jest.MockedFunction
  typeof transactionModule.withTransaction
>;

// Run the callback with a fake client, mirroring real commit semantics.
function runTransactionInline(fakeClient: unknown) {
  mockedWithTransaction.mockImplementation(async (_pool, cb) =>
    cb(fakeClient as never),
  );
}

function makeLotRepo(overrides: Partial<InvestmentLotRepository> = {}) {
  return {
    createWithClient: jest.fn().mockResolvedValue({ id: 'lot-new' }),
    findByInvestorOfferingAndDateRange: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as InvestmentLotRepository;
}

function makeExistingLot(override: Partial<InvestmentLot> = {}): InvestmentLot {
  return {
    id: 'lot-existing',
    investor_id: 'inv-1',
    offering_id: 'off-1',
    investment_id: 'invst-1',
    asset: 'USDC',
    quantity: 100,
    cost_basis_per_unit: 10,
    total_cost_basis: 1000,
    remaining_quantity: 100,
    cost_currency: 'USD',
    acquired_at: new Date('2024-01-01T00:00:00.000Z'),
    jurisdiction: 'US',
    status: 'open',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...override,
  };
}

const fakeClient = { query: jest.fn() };
const fakePool = {} as never;

const baseInput = {
  investor_id: 'inv-1',
  offering_id: 'off-1',
  investment_id: 'invst-1',
  broker: 'generic',
};

const GENERIC_HEADER = 'asset,quantity,cost_basis_per_unit,acquired_at,currency';

beforeEach(() => {
  jest.clearAllMocks();
  runTransactionInline(fakeClient);
});

// --- Happy path ------------------------------------------------------------

describe('importFile - success', () => {
  it('imports valid rows and emits the tax.import.rows counter', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);
    const counterSpy = jest.spyOn(globalMetrics, 'incrementCounter');

    const csv = [
      GENERIC_HEADER,
      'USDC,100,10,2024-01-01,USD',
      'XLM,50,0.25,2024-02-01,USD',
    ].join('\n');

    const result = await svc.importFile({ ...baseInput, csv });

    expect(result.importedCount).toBe(2);
    expect(result.skippedRows).toHaveLength(0);
    expect(result.totalRows).toBe(2);
    expect(lotRepo.createWithClient).toHaveBeenCalledTimes(2);
    expect(counterSpy).toHaveBeenCalledWith(
      'tax.import.rows',
      expect.objectContaining({ offering_id: 'off-1' }),
      2,
    );
  });

  it('applies the preset default currency when no currency column is present', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = [
      'asset,quantity,cost_basis_per_unit,acquired_at',
      'USDC,100,10,2024-01-01',
    ].join('\n');

    await svc.importFile({ ...baseInput, csv });

    expect(lotRepo.createWithClient).toHaveBeenCalledWith(
      fakeClient,
      expect.objectContaining({ cost_currency: 'USD' }),
    );
  });
});

// --- Schema validation -----------------------------------------------------

describe('importFile - schema validation', () => {
  const svc = () => new BrokerCsvImportService(makeLotRepo(), fakePool);

  it('rejects an empty file', async () => {
    await expect(svc().importFile({ ...baseInput, csv: '   ' })).rejects.toThrow(/empty/i);
  });

  it('rejects a file with only a header', async () => {
    await expect(
      svc().importFile({ ...baseInput, csv: GENERIC_HEADER }),
    ).rejects.toThrow(/at least one data row/i);
  });

  it('rejects an unknown broker preset', async () => {
    await expect(
      svc().importFile({ ...baseInput, broker: 'nope', csv: `${GENERIC_HEADER}\nUSDC,1,1,2024-01-01,USD` }),
    ).rejects.toThrow(/unknown broker/i);
  });

  it('rejects a file missing a required column', async () => {
    const csv = ['asset,quantity,acquired_at', 'USDC,1,2024-01-01'].join('\n');
    await expect(svc().importFile({ ...baseInput, csv })).rejects.toThrow(/missing required columns/i);
  });

  it('rejects a non-positive quantity', async () => {
    const csv = [GENERIC_HEADER, 'USDC,0,10,2024-01-01,USD'].join('\n');
    await expect(svc().importFile({ ...baseInput, csv })).rejects.toThrow(/quantity must be/i);
  });

  it('rejects a negative cost basis', async () => {
    const csv = [GENERIC_HEADER, 'USDC,10,-5,2024-01-01,USD'].join('\n');
    await expect(svc().importFile({ ...baseInput, csv })).rejects.toThrow(/cost_basis_per_unit/i);
  });

  it('rejects an invalid date', async () => {
    const csv = [GENERIC_HEADER, 'USDC,10,5,not-a-date,USD'].join('\n');
    await expect(svc().importFile({ ...baseInput, csv })).rejects.toThrow(/acquired_at/i);
  });

  it('rejects a missing asset', async () => {
    const csv = [GENERIC_HEADER, ',10,5,2024-01-01,USD'].join('\n');
    await expect(svc().importFile({ ...baseInput, csv })).rejects.toThrow(/asset is required/i);
  });

  it('writes nothing when validation fails (transactional integrity)', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);
    const csv = [GENERIC_HEADER, 'USDC,0,10,2024-01-01,USD'].join('\n');

    await expect(svc.importFile({ ...baseInput, csv })).rejects.toThrow();
    expect(lotRepo.createWithClient).not.toHaveBeenCalled();
    expect(mockedWithTransaction).not.toHaveBeenCalled();
  });
});

// --- Duplicate handling ----------------------------------------------------

describe('importFile - duplicates', () => {
  it('skips a row duplicated within the same file, with a note', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = [
      GENERIC_HEADER,
      'USDC,100,10,2024-01-01,USD',
      'USDC,100,10,2024-01-01,USD',
    ].join('\n');

    const result = await svc.importFile({ ...baseInput, csv });

    expect(result.importedCount).toBe(1);
    expect(result.skippedRows).toHaveLength(1);
    expect(result.skippedRows[0].reason).toBe('duplicate_in_file');
    expect(result.skippedRows[0].note).toMatch(/duplicates an earlier row/i);
    expect(lotRepo.createWithClient).toHaveBeenCalledTimes(1);
  });

  it('skips a row matching an existing lot from a prior import, with a note', async () => {
    const lotRepo = makeLotRepo({
      findByInvestorOfferingAndDateRange: jest
        .fn()
        .mockResolvedValue([makeExistingLot()]),
    });
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = [GENERIC_HEADER, 'USDC,100,10,2024-01-01,USD'].join('\n');
    const result = await svc.importFile({ ...baseInput, csv });

    expect(result.importedCount).toBe(0);
    expect(result.skippedRows[0].reason).toBe('duplicate_existing_lot');
    expect(lotRepo.createWithClient).not.toHaveBeenCalled();
  });

  it('does not treat a different quantity as an existing duplicate', async () => {
    const lotRepo = makeLotRepo({
      findByInvestorOfferingAndDateRange: jest
        .fn()
        .mockResolvedValue([makeExistingLot({ quantity: 999 })]),
    });
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = [GENERIC_HEADER, 'USDC,100,10,2024-01-01,USD'].join('\n');
    const result = await svc.importFile({ ...baseInput, csv });

    expect(result.importedCount).toBe(1);
  });
});

// --- CSV parsing edge cases ------------------------------------------------

describe('importFile - CSV parsing', () => {
  it('handles quoted fields containing commas', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = [GENERIC_HEADER, '"USDC, Inc.",100,10,2024-01-01,USD'].join('\n');
    await svc.importFile({ ...baseInput, csv });

    expect(lotRepo.createWithClient).toHaveBeenCalledWith(
      fakeClient,
      expect.objectContaining({ asset: 'USDC, Inc.' }),
    );
  });

  it('tolerates trailing blank lines and CRLF endings', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = `${GENERIC_HEADER}\r\nUSDC,100,10,2024-01-01,USD\r\n\r\n`;
    const result = await svc.importFile({ ...baseInput, csv });

    expect(result.importedCount).toBe(1);
  });
});

/**
 * Tests for BrokerCsvImportService: schema-validated, transactional-per-file
 * broker CSV cost-basis import with duplicate skipping and metrics emission.
 *
 * @module services/taxation/csvImport/brokerCsvImportService.test
 */

import { BrokerCsvImportService } from '../brokerCsvImportService';
import { InvestmentLotRepository } from '../../../../db/repositories/investmentLotRepository';
import * as transactionModule from '../../../../db/transaction';
import { globalMetrics } from '../../../../lib/metrics';
import { InvestmentLot } from '../../types';

// --- Mocks -----------------------------------------------------------------

jest.mock('../../../../db/transaction');

const mockedWithTransaction = transactionModule.withTransaction as jest.MockedFunction
  typeof transactionModule.withTransaction
>;

// Run the callback with a fake client, mirroring real commit semantics.
function runTransactionInline(fakeClient: unknown) {
  mockedWithTransaction.mockImplementation(async (_pool, cb) =>
    cb(fakeClient as never),
  );
}

function makeLotRepo(overrides: Partial<InvestmentLotRepository> = {}) {
  return {
    createWithClient: jest.fn().mockResolvedValue({ id: 'lot-new' }),
    findByInvestorOfferingAndDateRange: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as InvestmentLotRepository;
}

function makeExistingLot(override: Partial<InvestmentLot> = {}): InvestmentLot {
  return {
    id: 'lot-existing',
    investor_id: 'inv-1',
    offering_id: 'off-1',
    investment_id: 'invst-1',
    asset: 'USDC',
    quantity: 100,
    cost_basis_per_unit: 10,
    total_cost_basis: 1000,
    remaining_quantity: 100,
    cost_currency: 'USD',
    acquired_at: new Date('2024-01-01T00:00:00.000Z'),
    jurisdiction: 'US',
    status: 'open',
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...override,
  };
}

const fakeClient = { query: jest.fn() };
const fakePool = {} as never;

const baseInput = {
  investor_id: 'inv-1',
  offering_id: 'off-1',
  investment_id: 'invst-1',
  broker: 'generic',
};

const GENERIC_HEADER = 'asset,quantity,cost_basis_per_unit,acquired_at,currency';

beforeEach(() => {
  jest.clearAllMocks();
  runTransactionInline(fakeClient);
});

// --- Happy path ------------------------------------------------------------

describe('importFile - success', () => {
  it('imports valid rows and emits the tax.import.rows counter', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);
    const counterSpy = jest.spyOn(globalMetrics, 'incrementCounter');

    const csv = [
      GENERIC_HEADER,
      'USDC,100,10,2024-01-01,USD',
      'XLM,50,0.25,2024-02-01,USD',
    ].join('\n');

    const result = await svc.importFile({ ...baseInput, csv });

    expect(result.importedCount).toBe(2);
    expect(result.skippedRows).toHaveLength(0);
    expect(result.totalRows).toBe(2);
    expect(lotRepo.createWithClient).toHaveBeenCalledTimes(2);
    expect(counterSpy).toHaveBeenCalledWith(
      'tax.import.rows',
      expect.objectContaining({ offering_id: 'off-1' }),
      2,
    );
  });

  it('applies the preset default currency when no currency column is present', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = [
      'asset,quantity,cost_basis_per_unit,acquired_at',
      'USDC,100,10,2024-01-01',
    ].join('\n');

    await svc.importFile({ ...baseInput, csv });

    expect(lotRepo.createWithClient).toHaveBeenCalledWith(
      fakeClient,
      expect.objectContaining({ cost_currency: 'USD' }),
    );
  });
});

// --- Schema validation -----------------------------------------------------

describe('importFile - schema validation', () => {
  const svc = () => new BrokerCsvImportService(makeLotRepo(), fakePool);

  it('rejects an empty file', async () => {
    await expect(svc().importFile({ ...baseInput, csv: '   ' })).rejects.toThrow(/empty/i);
  });

  it('rejects a file with only a header', async () => {
    await expect(
      svc().importFile({ ...baseInput, csv: GENERIC_HEADER }),
    ).rejects.toThrow(/at least one data row/i);
  });

  it('rejects an unknown broker preset', async () => {
    await expect(
      svc().importFile({ ...baseInput, broker: 'nope', csv: `${GENERIC_HEADER}\nUSDC,1,1,2024-01-01,USD` }),
    ).rejects.toThrow(/unknown broker/i);
  });

  it('rejects a file missing a required column', async () => {
    const csv = ['asset,quantity,acquired_at', 'USDC,1,2024-01-01'].join('\n');
    await expect(svc().importFile({ ...baseInput, csv })).rejects.toThrow(/missing required columns/i);
  });

  it('rejects a non-positive quantity', async () => {
    const csv = [GENERIC_HEADER, 'USDC,0,10,2024-01-01,USD'].join('\n');
    await expect(svc().importFile({ ...baseInput, csv })).rejects.toThrow(/quantity must be/i);
  });

  it('rejects a negative cost basis', async () => {
    const csv = [GENERIC_HEADER, 'USDC,10,-5,2024-01-01,USD'].join('\n');
    await expect(svc().importFile({ ...baseInput, csv })).rejects.toThrow(/cost_basis_per_unit/i);
  });

  it('rejects an invalid date', async () => {
    const csv = [GENERIC_HEADER, 'USDC,10,5,not-a-date,USD'].join('\n');
    await expect(svc().importFile({ ...baseInput, csv })).rejects.toThrow(/acquired_at/i);
  });

  it('rejects a missing asset', async () => {
    const csv = [GENERIC_HEADER, ',10,5,2024-01-01,USD'].join('\n');
    await expect(svc().importFile({ ...baseInput, csv })).rejects.toThrow(/asset is required/i);
  });

  it('writes nothing when validation fails (transactional integrity)', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);
    const csv = [GENERIC_HEADER, 'USDC,0,10,2024-01-01,USD'].join('\n');

    await expect(svc.importFile({ ...baseInput, csv })).rejects.toThrow();
    expect(lotRepo.createWithClient).not.toHaveBeenCalled();
    expect(mockedWithTransaction).not.toHaveBeenCalled();
  });
});

// --- Duplicate handling ----------------------------------------------------

describe('importFile - duplicates', () => {
  it('skips a row duplicated within the same file, with a note', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = [
      GENERIC_HEADER,
      'USDC,100,10,2024-01-01,USD',
      'USDC,100,10,2024-01-01,USD',
    ].join('\n');

    const result = await svc.importFile({ ...baseInput, csv });

    expect(result.importedCount).toBe(1);
    expect(result.skippedRows).toHaveLength(1);
    expect(result.skippedRows[0].reason).toBe('duplicate_in_file');
    expect(result.skippedRows[0].note).toMatch(/duplicates an earlier row/i);
    expect(lotRepo.createWithClient).toHaveBeenCalledTimes(1);
  });

  it('skips a row matching an existing lot from a prior import, with a note', async () => {
    const lotRepo = makeLotRepo({
      findByInvestorOfferingAndDateRange: jest
        .fn()
        .mockResolvedValue([makeExistingLot()]),
    });
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = [GENERIC_HEADER, 'USDC,100,10,2024-01-01,USD'].join('\n');
    const result = await svc.importFile({ ...baseInput, csv });

    expect(result.importedCount).toBe(0);
    expect(result.skippedRows[0].reason).toBe('duplicate_existing_lot');
    expect(lotRepo.createWithClient).not.toHaveBeenCalled();
  });

  it('does not treat a different quantity as an existing duplicate', async () => {
    const lotRepo = makeLotRepo({
      findByInvestorOfferingAndDateRange: jest
        .fn()
        .mockResolvedValue([makeExistingLot({ quantity: 999 })]),
    });
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = [GENERIC_HEADER, 'USDC,100,10,2024-01-01,USD'].join('\n');
    const result = await svc.importFile({ ...baseInput, csv });

    expect(result.importedCount).toBe(1);
  });
});

// --- CSV parsing edge cases ------------------------------------------------

describe('importFile - CSV parsing', () => {
  it('handles quoted fields containing commas', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = [GENERIC_HEADER, '"USDC, Inc.",100,10,2024-01-01,USD'].join('\n');
    await svc.importFile({ ...baseInput, csv });

    expect(lotRepo.createWithClient).toHaveBeenCalledWith(
      fakeClient,
      expect.objectContaining({ asset: 'USDC, Inc.' }),
    );
  });

  it('tolerates trailing blank lines and CRLF endings', async () => {
    const lotRepo = makeLotRepo();
    const svc = new BrokerCsvImportService(lotRepo, fakePool);

    const csv = `${GENERIC_HEADER}\r\nUSDC,100,10,2024-01-01,USD\r\n\r\n`;
    const result = await svc.importFile({ ...baseInput, csv });

    expect(result.importedCount).toBe(1);
  });
});