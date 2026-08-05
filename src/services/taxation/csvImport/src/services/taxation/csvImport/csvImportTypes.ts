/**
 * Types for broker CSV cost-basis import.
 *
 * Establishes opening cost basis for investor lots brought over from an
 * external broker. Import is schema-validated, transactional per file, and
 * skips duplicate rows across imports with a recorded note.
 *
 * @module services/taxation/csvImport/csvImportTypes
 */

/** Canonical fields every parsed row must resolve to after mapping. */
export interface ParsedBrokerRow {
  asset: string;
  quantity: number;
  cost_basis_per_unit: number;
  acquired_at: Date;
  cost_currency: string;
  /** 1-based row number in the source file, for error reporting. */
  sourceLine: number;
}

/** Why a single row was rejected during validation. */
export interface RowError {
  sourceLine: number;
  message: string;
}

/** Reason a row was skipped rather than imported. */
export type SkipReason = 'duplicate_in_file' | 'duplicate_existing_lot';

/** A row that passed validation but was intentionally not imported. */
export interface SkippedRow {
  sourceLine: number;
  reason: SkipReason;
  note: string;
}

/** Outcome of importing one CSV file for one investor + offering. */
export interface BrokerCsvImportResult {
  investor_id: string;
  offering_id: string;
  broker: string;
  /** Rows written as new lots. */
  importedCount: number;
  /** Rows skipped as duplicates (with notes). */
  skippedRows: SkippedRow[];
  /** Total data rows seen (excludes header). */
  totalRows: number;
}

/** Input to the import service. */
export interface BrokerCsvImportInput {
  investor_id: string;
  offering_id: string;
  investment_id: string;
  /** Preset key selecting the broker column mapping. */
  broker: string;
  /** Raw CSV file contents. */
  csv: string;
  jurisdiction?: string;
}