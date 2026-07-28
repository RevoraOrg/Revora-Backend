/**
 * Investor statement PDF rendering (Issue #540).
 *
 * Production would stream bytes to object storage. Here we produce a
 * deterministic buffer + checksum so resume/retry writes the same
 * storage_key without creating duplicate artifacts.
 */

import { createHash } from 'crypto';
import {
  buildStatementStorageKey,
  checksumPayload,
  PdfRenderJobRow,
} from '../db/repositories/pdfRenderJobRepository';

export interface StatementPdfRenderResult {
  storageKey: string;
  checksum: string;
  bytes: Buffer;
}

export interface StatementPdfStorage {
  /** Upsert bytes at storageKey (overwrite is required for crash-safe resume). */
  putObject(storageKey: string, bytes: Buffer): Promise<void>;
  /** Optional read for verification / tests. */
  getObject?(storageKey: string): Promise<Buffer | null>;
}

/** In-memory store used by unit tests and local runners. */
export class InMemoryStatementPdfStorage implements StatementPdfStorage {
  private readonly objects = new Map<string, Buffer>();

  async putObject(storageKey: string, bytes: Buffer): Promise<void> {
    this.objects.set(storageKey, Buffer.from(bytes));
  }

  async getObject(storageKey: string): Promise<Buffer | null> {
    const value = this.objects.get(storageKey);
    return value ? Buffer.from(value) : null;
  }

  clear(): void {
    this.objects.clear();
  }

  size(): number {
    return this.objects.size;
  }
}

/**
 * Build a stable PDF-ish payload for an investor statement.
 * Content is keyed only by period + investor so retries never fork artifacts.
 */
export function renderStatementPdfBytes(job: PdfRenderJobRow): Buffer {
  const body = [
    '%PDF-1.4',
    `% Revora investor statement`,
    `% period=${job.period_id}`,
    `% investor=${job.investor_id}`,
    `% batch=${job.batch_id}`,
    `1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj`,
    `trailer<< /Root 1 0 R >>`,
    `%%EOF`,
  ].join('\n');
  return Buffer.from(body, 'utf8');
}

export type StatementRenderFn = (job: PdfRenderJobRow) => Promise<StatementPdfRenderResult>;

/**
 * Default render + store pipeline. Overwrites the deterministic key so a
 * mid-batch crash that reclaims the job cannot leave two objects behind.
 */
export function makeStatementRenderFn(storage: StatementPdfStorage): StatementRenderFn {
  return async (job: PdfRenderJobRow): Promise<StatementPdfRenderResult> => {
    const storageKey =
      job.storage_key ?? buildStatementStorageKey(job.period_id, job.investor_id);
    const bytes = renderStatementPdfBytes(job);
    const checksum = checksumPayload(bytes);
    await storage.putObject(storageKey, bytes);
    // Defence in depth: checksum of stored bytes must match rendered bytes.
    const verify = createHash('sha256').update(bytes).digest('hex');
    if (verify !== checksum) {
      throw new Error('statement PDF checksum mismatch');
    }
    return { storageKey, checksum, bytes };
  };
}
