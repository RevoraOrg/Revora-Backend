/**
 * Investor statement PDF rendering with Watermark and Version Stamp (Issue #487).
 *
 * Pre-audit draft statements must be visibly marked "DRAFT - subject to audit".
 * When a final flag signed by the treasury Ed25519 key is provided and verified,
 * the watermark is suppressed and a `pdf.watermark.suppressed` audit event is emitted.
 * A footer version stamp keyed to the ledger revision hash is applied to all statements.
 */

import crypto, { KeyObject, createHash } from 'crypto';
import { EventEmitter } from 'events';
import { globalLogger } from '../lib/logger';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import {
  buildStatementStorageKey,
  checksumPayload,
  PdfRenderJobRow,
} from '../db/repositories/pdfRenderJobRepository';
import { StatementContent, StatementDataProvider } from './statementDataProvider';

export const WATERMARK_DRAFT_TEXT = 'DRAFT - subject to audit';
export const EVENT_PDF_WATERMARK_SUPPRESSED = 'pdf.watermark.suppressed';

/** Global event emitter for PDF watermark suppression events */
export const statementPdfEventEmitter = new EventEmitter();

export interface FinalSignaturePayload {
  periodId: string;
  investorId: string;
  ledgerRevisionHash: string;
  timestamp: number;
  expiresAt?: number;
  [key: string]: unknown;
}

export interface StatementFinalFlag {
  signature: string;
  payload: FinalSignaturePayload | string;
}

export interface StatementRenderOptions {
  ledgerRevisionHash?: string;
  finalFlag?: StatementFinalFlag;
  treasuryPublicKey?: string | Buffer | KeyObject;
  eventEmitter?: EventEmitter;
  auditLogRepository?: AuditLogRepository;
  signerKeyId?: string;
  requestingPrincipal?: string;
}

export interface StatementPdfRenderResult {
  storageKey: string;
  checksum: string;
  bytes: Buffer;
  watermarkSuppressed: boolean;
  ledgerRevisionHash: string;
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
 * Parses various Ed25519 public key formats into a Node.js KeyObject.
 */
export function parseEd25519PublicKey(
  input: string | Buffer | KeyObject
): KeyObject {
  if (typeof input === 'object' && 'type' in input && input.type === 'public') {
    return input as KeyObject;
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('-----BEGIN')) {
      return crypto.createPublicKey(trimmed);
    }

    // Hex raw (64 chars) or DER
    if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      const buf = Buffer.from(trimmed, 'hex');
      return parseEd25519PublicKeyBuffer(buf);
    }

    // Base64
    const buf = Buffer.from(trimmed, 'base64');
    return parseEd25519PublicKeyBuffer(buf);
  }

  if (Buffer.isBuffer(input)) {
    return parseEd25519PublicKeyBuffer(input);
  }

  throw new Error('Invalid Ed25519 public key input');
}

function parseEd25519PublicKeyBuffer(buf: Buffer): KeyObject {
  // Ed25519 SPKI header (12 bytes)
  const ed25519SpkiHeader = Buffer.from('302a300506032b6570032100', 'hex');

  if (buf.length === 32) {
    const der = Buffer.concat([ed25519SpkiHeader, buf]);
    return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  }

  try {
    return crypto.createPublicKey({ key: buf, format: 'der', type: 'spki' });
  } catch {
    if (buf.length > 32) {
      const raw32 = buf.subarray(buf.length - 32);
      const der = Buffer.concat([ed25519SpkiHeader, raw32]);
      return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
    throw new Error('Malformed Ed25519 public key buffer');
  }
}

/**
 * Verifies Ed25519 signature from treasury role key.
 */
export function verifyTreasurySignature(
  job: PdfRenderJobRow,
  options?: StatementRenderOptions
): { valid: boolean; reason?: string; payloadObj?: FinalSignaturePayload } {
  const finalFlag = options?.finalFlag;
  if (!finalFlag || !finalFlag.signature || !finalFlag.payload) {
    return { valid: false, reason: 'Missing signature or payload' };
  }

  let payloadObj: FinalSignaturePayload;
  let canonicalPayload: string;

  if (typeof finalFlag.payload === 'string') {
    try {
      payloadObj = JSON.parse(finalFlag.payload);
      canonicalPayload = finalFlag.payload;
    } catch {
      return { valid: false, reason: 'Invalid JSON payload string' };
    }
  } else {
    payloadObj = finalFlag.payload;
    const sortedKeys = Object.keys(payloadObj).sort();
    canonicalPayload = JSON.stringify(payloadObj, sortedKeys);
  }

  // 1. Verify period and investor match
  if (payloadObj.periodId !== job.period_id) {
    return {
      valid: false,
      reason: `Period mismatch: expected ${job.period_id}, got ${payloadObj.periodId}`,
    };
  }
  if (payloadObj.investorId !== job.investor_id) {
    return {
      valid: false,
      reason: `Investor mismatch: expected ${job.investor_id}, got ${payloadObj.investorId}`,
    };
  }

  // 2. Verify ledger revision hash if specified in options
  if (
    options?.ledgerRevisionHash &&
    payloadObj.ledgerRevisionHash &&
    payloadObj.ledgerRevisionHash !== options.ledgerRevisionHash
  ) {
    return { valid: false, reason: 'Ledger revision hash mismatch' };
  }

  // 3. Verify expiration deadline
  const now = Date.now();
  if (payloadObj.expiresAt !== undefined) {
    const expiresMs =
      payloadObj.expiresAt < 1e11 ? payloadObj.expiresAt * 1000 : payloadObj.expiresAt;
    if (now > expiresMs) {
      return { valid: false, reason: 'Signature expired' };
    }
  }

  // 4. Verify timestamp sanity
  if (payloadObj.timestamp !== undefined) {
    const tsMs =
      payloadObj.timestamp < 1e11 ? payloadObj.timestamp * 1000 : payloadObj.timestamp;
    if (tsMs > now + 300_000) {
      return { valid: false, reason: 'Timestamp in future' };
    }
    if (payloadObj.expiresAt === undefined && now - tsMs > 86_400_000) {
      return { valid: false, reason: 'Signature timestamp stale (> 24 hours)' };
    }
  }

  // 5. Look up treasury key
  const pubKeyInput = options?.treasuryPublicKey ?? process.env.TREASURY_ED25519_PUBKEY;
  if (!pubKeyInput) {
    return { valid: false, reason: 'Treasury Ed25519 public key not configured' };
  }

  let keyObject: KeyObject;
  try {
    keyObject = parseEd25519PublicKey(pubKeyInput);
  } catch (err: any) {
    return { valid: false, reason: `Invalid treasury public key: ${err.message}` };
  }

  // 6. Verify Ed25519 signature
  try {
    let sigBuf: Buffer;
    const sigStr = finalFlag.signature.trim();
    if (/^[0-9a-fA-F]+$/.test(sigStr) && sigStr.length % 2 === 0) {
      sigBuf = Buffer.from(sigStr, 'hex');
    } else {
      sigBuf = Buffer.from(sigStr, 'base64');
    }

    const verified = crypto.verify(
      null,
      Buffer.from(canonicalPayload, 'utf8'),
      keyObject,
      sigBuf
    );
    if (!verified) {
      return { valid: false, reason: 'Ed25519 signature verification failed' };
    }
    return { valid: true, payloadObj };
  } catch (err: any) {
    return { valid: false, reason: `Signature verification error: ${err.message}` };
  }
}

/**
 * Evaluate watermark suppression + ledger revision hash for a job.
 *
 * Shared by both the legacy details renderer and the deterministic
 * content renderer so the security behavior (signature verification,
 * audit emission, security-relevant logging) stays in exactly one place.
 *
 * Returns values that are deterministic for a given job + options — the
 * wall-clock timestamps used in audit payloads are never part of the
 * rendered PDF bytes.
 */
function evaluateWatermarkState(
  job: PdfRenderJobRow,
  options?: StatementRenderOptions
): { watermarkSuppressed: boolean; ledgerRevisionHash: string } {
  const verification = verifyTreasurySignature(job, options);
  const watermarkSuppressed = verification.valid;

  if (!watermarkSuppressed && options?.finalFlag) {
    globalLogger.warn('pdf.watermark.security-relevant: signature verification failed', {
      periodId: job.period_id,
      investorId: job.investor_id,
      batchId: job.batch_id,
      reason: verification.reason,
      timestamp: new Date().toISOString(),
    });
  }

  const ledgerRevisionHash =
    options?.ledgerRevisionHash ||
    verification.payloadObj?.ledgerRevisionHash ||
    checksumPayload(`${job.period_id}:${job.investor_id}`).slice(0, 16);

  if (watermarkSuppressed) {
    const signerKeyId =
      options?.signerKeyId ||
      verification.payloadObj?.kid ||
      deriveSignerKeyId(options?.treasuryPublicKey ?? process.env.TREASURY_ED25519_PUBKEY);
    const auditData: Record<string, unknown> = {
      event: EVENT_PDF_WATERMARK_SUPPRESSED,
      periodId: job.period_id,
      investorId: job.investor_id,
      ledgerRevisionHash,
      batchId: job.batch_id,
      timestamp: new Date().toISOString(),
      signerKeyId: signerKeyId ?? null,
      requestingPrincipal: options?.requestingPrincipal ?? null,
    };

    statementPdfEventEmitter.emit(EVENT_PDF_WATERMARK_SUPPRESSED, auditData);
    if (options?.eventEmitter) {
      options.eventEmitter.emit(EVENT_PDF_WATERMARK_SUPPRESSED, auditData);
    }
    if (options?.auditLogRepository) {
      options.auditLogRepository
        .createAuditLog({
          action: EVENT_PDF_WATERMARK_SUPPRESSED,
          resource: `statement:${job.period_id}:${job.investor_id}`,
          details: JSON.stringify(auditData),
        })
        .catch((err) => {
          globalLogger.warn('Failed to record pdf.watermark.suppressed audit log', {
            error: err,
          });
        });
    }
    globalLogger.info('pdf.watermark.suppressed audit event emitted', auditData);
  }

  return { watermarkSuppressed, ledgerRevisionHash };
}

/**
 * Renders statement PDF details, returning bytes, watermark state, and revision hash.
 */
export function deriveSignerKeyId(pubKeyInput: string | Buffer | KeyObject | undefined): string | undefined {
  if (!pubKeyInput) return undefined;
  try {
    const keyObj = parseEd25519PublicKey(pubKeyInput);
    const der = keyObj.export({ format: 'der', type: 'spki' }) as Buffer;
    return createHash('sha256').update(der).digest('hex').slice(0, 16);
  } catch {
    return undefined;
  }
}

export function renderStatementPdfDetails(
  job: PdfRenderJobRow,
  options?: StatementRenderOptions
): { bytes: Buffer; watermarkSuppressed: boolean; ledgerRevisionHash: string } {
  const { watermarkSuppressed, ledgerRevisionHash } = evaluateWatermarkState(job, options);

  const lines = [
    '%PDF-1.4',
    `% Revora investor statement`,
    `% period=${job.period_id}`,
    `% investor=${job.investor_id}`,
    `% batch=${job.batch_id}`,
  ];

  if (!watermarkSuppressed) {
    lines.push(
      `% WATERMARK: ${WATERMARK_DRAFT_TEXT}`,
      `/Watermark << /Type /Pagination /Subtype /Watermark /Text (${WATERMARK_DRAFT_TEXT}) /Rotation 45 /Diagonal true >>`
    );
  } else {
    lines.push(`% WATERMARK: SUPPRESSED (FINAL SIGNED STATEMENT)`);
  }

  lines.push(
    `% FOOTER_VERSION_STAMP: ledger_revision=${ledgerRevisionHash}`,
    `/Footer << /Text (Ledger Revision: ${ledgerRevisionHash}) >>`,
    `1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj`,
    `trailer<< /Root 1 0 R >>`,
    `%%EOF`
  );

  const bytes = Buffer.from(lines.join('\n'), 'utf8');
  return { bytes, watermarkSuppressed, ledgerRevisionHash };
}

// ── Deterministic content renderer (Issue #874) ───────────────────────────

/** Escape text for safe embedding in PDF string literals and comment lines. */
function pdfSafe(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, ' ');
}

/** Deterministic (locale-independent) date rendering. */
function formatIso(date: Date): string {
  return date.toISOString();
}

/** Numeric comparison of decimal strings (stable and locale-independent). */
function numericCompare(a: string, b: string): number {
  return Number(a) - Number(b);
}

/**
 * Build the deterministic PDF text lines for a statement.
 *
 * Frozen layout guarantees: the output depends ONLY on (job metadata,
 * statement content, watermark state, ledger revision hash). No wall-clock
 * values, random bytes, or locale-dependent formatting are ever embedded.
 * Sections are defensively re-sorted so byte-identical output holds even if
 * a data provider returns rows in a different order.
 */
function buildContentPdfLines(
  job: PdfRenderJobRow,
  content: StatementContent,
  watermarkSuppressed: boolean,
  ledgerRevisionHash: string
): string[] {
  const lines = [
    '%PDF-1.4',
    '% Revora investor statement',
    `% period=${job.period_id}`,
    `% investor=${job.investor_id}`,
    `% batch=${job.batch_id}`,
  ];

  if (!watermarkSuppressed) {
    lines.push(
      `% WATERMARK: ${WATERMARK_DRAFT_TEXT}`,
      `/Watermark << /Type /Pagination /Subtype /Watermark /Text (${pdfSafe(WATERMARK_DRAFT_TEXT)}) /Rotation 45 /Diagonal true >>`
    );
  } else {
    lines.push(`% WATERMARK: SUPPRESSED (FINAL SIGNED STATEMENT)`);
  }

  lines.push(
    `% FOOTER_VERSION_STAMP: ledger_revision=${ledgerRevisionHash}`,
    `/Footer << /Text (Ledger Revision: ${pdfSafe(ledgerRevisionHash)}) >>`
  );

  // ── Statement sections ─────────────────────────────────────────────────
  lines.push('%%CONTENT_BEGIN');
  lines.push('STATEMENT');
  lines.push(`Investor: ${content.investorId}`);
  lines.push(`Investor name: ${pdfSafe(content.investorName)}`);
  lines.push(`Period: ${content.periodId} (${content.periodLabel})`);

  // Positions / holdings
  lines.push('', 'POSITIONS', 'OFFERING | SYMBOL | BALANCE');
  const holdings = [...content.holdings].sort(
    (a, b) =>
      a.offeringName.localeCompare(b.offeringName) ||
      a.offeringSymbol.localeCompare(b.offeringSymbol) ||
      numericCompare(a.balance, b.balance)
  );
  for (const holding of holdings) {
    lines.push(
      `${pdfSafe(holding.offeringName)} | ${pdfSafe(holding.offeringSymbol)} | ${holding.balance}`
    );
  }

  // Distributions + fees
  lines.push('', 'DISTRIBUTIONS', 'DATE | AMOUNT | STATUS');
  const distributions = [...content.distributionSummary.distributions].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || numericCompare(a.amount, b.amount)
  );
  for (const distribution of distributions) {
    lines.push(`${formatIso(distribution.date)} | ${distribution.amount} | ${distribution.status}`);
  }
  lines.push(`Total distributed: ${content.distributionSummary.totalDistributed}`);
  lines.push(`Fees (retained revenue): ${content.distributionSummary.fees}`);

  // Transactions
  lines.push('', 'TRANSACTIONS', 'DATE | TYPE | DESCRIPTION | AMOUNT | STATUS');
  const transactions = [...content.transactions].sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.type.localeCompare(b.type) ||
      numericCompare(a.amount, b.amount) ||
      a.description.localeCompare(b.description) ||
      a.status.localeCompare(b.status)
  );
  for (const transaction of transactions) {
    lines.push(
      `${formatIso(transaction.date)} | ${transaction.type} | ${pdfSafe(transaction.description)} | ${transaction.amount} | ${transaction.status}`
    );
  }

  // Revenue
  if (content.revenueSummary) {
    lines.push('', 'REVENUE', `Total revenue: ${content.revenueSummary.totalAmount}`);
    if (content.revenueSummary.periodStart) {
      lines.push(`Period start: ${formatIso(content.revenueSummary.periodStart)}`);
    }
    if (content.revenueSummary.periodEnd) {
      lines.push(`Period end: ${formatIso(content.revenueSummary.periodEnd)}`);
    }
  }

  // Tax classifications
  lines.push('', 'TAX CLASSIFICATIONS', 'OFFERING | JURISDICTION | QUANTITY | COST BASIS/UNIT | ACQUIRED');
  const taxClassifications = [...content.taxClassifications].sort(
    (a, b) =>
      a.offeringId.localeCompare(b.offeringId) ||
      a.jurisdiction.localeCompare(b.jurisdiction) ||
      a.acquiredAt.getTime() - b.acquiredAt.getTime() ||
      numericCompare(a.costBasisPerUnit, b.costBasisPerUnit)
  );
  for (const classification of taxClassifications) {
    lines.push(
      `${pdfSafe(classification.offeringName)} | ${pdfSafe(classification.jurisdiction)} | ${classification.quantity} | ${classification.costBasisPerUnit} | ${formatIso(classification.acquiredAt)}`
    );
  }

  lines.push('%%CONTENT_END');
  lines.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj');
  lines.push('trailer<< /Root 1 0 R >>');
  lines.push('%%EOF');
  return lines;
}

/**
 * Render a deterministic, content-aware statement PDF.
 *
 * The output bytes are a pure function of the job metadata, the statement
 * content, and the watermark/revision state — regenerating the same input
 * yields the same sha256, which is what makes archival + tamper detection
 * possible.
 */
export function renderStatementPdfWithContent(
  job: PdfRenderJobRow,
  content: StatementContent,
  options?: StatementRenderOptions
): { bytes: Buffer; watermarkSuppressed: boolean; ledgerRevisionHash: string } {
  const { watermarkSuppressed, ledgerRevisionHash } = evaluateWatermarkState(job, options);
  const lines = buildContentPdfLines(job, content, watermarkSuppressed, ledgerRevisionHash);
  const bytes = Buffer.from(lines.join('\n'), 'utf8');
  return { bytes, watermarkSuppressed, ledgerRevisionHash };
}

/**
 * Build PDF payload bytes for an investor statement.
 */
export function renderStatementPdfBytes(
  job: PdfRenderJobRow,
  options?: StatementRenderOptions
): Buffer {
  return renderStatementPdfDetails(job, options).bytes;
}

export type StatementRenderFn = (
  job: PdfRenderJobRow,
  options?: StatementRenderOptions
) => Promise<StatementPdfRenderResult>;

/**
 * Render + store pipeline with watermark suppression & version stamp.
 */
export function makeStatementRenderFn(
  storage: StatementPdfStorage,
  defaultOptions?: StatementRenderOptions
): StatementRenderFn {
  return async (
    job: PdfRenderJobRow,
    options?: StatementRenderOptions
  ): Promise<StatementPdfRenderResult> => {
    const mergedOptions = { ...defaultOptions, ...options };
    const storageKey =
      job.storage_key ?? buildStatementStorageKey(job.period_id, job.investor_id);
    const details = renderStatementPdfDetails(job, mergedOptions);
    const bytes = details.bytes;
    const checksum = checksumPayload(bytes);
    await storage.putObject(storageKey, bytes);

    const verify = createHash('sha256').update(bytes).digest('hex');
    if (verify !== checksum) {
      throw new Error('statement PDF checksum mismatch');
    }
    return {
      storageKey,
      checksum,
      bytes,
      watermarkSuppressed: details.watermarkSuppressed,
      ledgerRevisionHash: details.ledgerRevisionHash,
    };
  };
}

/**
 * Content-aware render + store pipeline (Issue #874).
 *
 * Fetches statement content from the data provider, renders a deterministic
 * PDF (same input → same bytes → same sha256), stores it under the job's
 * deterministic storage key, and returns the checksum for DB persistence.
 */
export function makeContentStatementRenderFn(
  storage: StatementPdfStorage,
  dataProvider: StatementDataProvider,
  defaultOptions?: StatementRenderOptions
): StatementRenderFn {
  return async (
    job: PdfRenderJobRow,
    options?: StatementRenderOptions
  ): Promise<StatementPdfRenderResult> => {
    const mergedOptions = { ...defaultOptions, ...options };
    const content = await dataProvider.getStatementContent(
      job.investor_id,
      job.period_id
    );
    const storageKey =
      job.storage_key ?? buildStatementStorageKey(job.period_id, job.investor_id);
    const details = renderStatementPdfWithContent(job, content, mergedOptions);
    const bytes = details.bytes;
    const checksum = checksumPayload(bytes);
    await storage.putObject(storageKey, bytes);

    const verify = createHash('sha256').update(bytes).digest('hex');
    if (verify !== checksum) {
      throw new Error('statement PDF checksum mismatch');
    }
    return {
      storageKey,
      checksum,
      bytes,
      watermarkSuppressed: details.watermarkSuppressed,
      ledgerRevisionHash: details.ledgerRevisionHash,
    };
  };
}
