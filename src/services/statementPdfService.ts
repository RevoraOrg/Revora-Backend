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
  dataProvider?: StatementDataProvider;
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
  const builder = new PdfDocumentBuilder({
    title: `Investor Statement ${job.period_id} - ${job.investor_id}`,
    periodId: job.period_id,
    investorId: job.investor_id,
    batchId: job.batch_id,
    watermarkSuppressed,
    ledgerRevisionHash,
  });

  builder.addMarkedSection('Title', 'H1', ['STATEMENT']);
  builder.addMarkedSection('InvestorInfo', 'InvestorInfo', [`Investor: ${job.investor_id}`]);
  builder.addMarkedSection('Period', 'Period', [`Period: ${job.period_id}`]);

  const bytes = builder.build();
  return { bytes, watermarkSuppressed, ledgerRevisionHash };
}

// ── PDF/UA Document Builder (Issue #1421) ─────────────────────────────────

export interface PdfSection {
  tag: string;
  role: string;
  mcid: number;
  lines: string[];
}

export interface PdfDocumentBuilderOptions {
  title: string;
  periodId: string;
  investorId: string;
  batchId: string;
  watermarkSuppressed: boolean;
  ledgerRevisionHash: string;
}

/**
 * Deterministic PDF/UA-1 tagged document builder.
 *
 * Emits:
 * - Catalog with `/MarkInfo << /Marked true >>`, `/StructTreeRoot`, `/Metadata` (XMP), `/Lang`
 * - `StructTreeRoot` with `RoleMap`, `ParentTree`, and `StructElem` nodes
 * - Content stream with `BDC` / `EMC` marked-content operators
 * - XMP metadata declaring `pdfuaid:part` = `1`
 * - Draft watermark / suppression marker and ledger revision footer stamp
 */
export class PdfDocumentBuilder {
  private readonly options: PdfDocumentBuilderOptions;
  private readonly sections: PdfSection[] = [];

  constructor(options: PdfDocumentBuilderOptions) {
    this.options = options;
  }

  /** Add a tagged marked-content section to the document. */
  addMarkedSection(tag: string, role: string, lines: string[]): this {
    const mcid = this.sections.length;
    this.sections.push({ tag, role, mcid, lines });
    return this;
  }

  /** Build deterministic XMP metadata declaring PDF/UA-1 conformance. */
  buildXmpMetadata(): string {
    const safeTitle = this.options.title
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return [
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '    <rdf:Description rdf:about=""',
      '      xmlns:dc="http://purl.org/dc/elements/1.1/"',
      '      xmlns:pdf="http://ns.adobe.com/pdf/1.3/"',
      '      xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">',
      '      <pdfuaid:part>1</pdfuaid:part>',
      `      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${safeTitle}</rdf:li></rdf:Alt></dc:title>`,
      '      <pdf:Producer>Revora StatementPdfService</pdf:Producer>',
      '    </rdf:Description>',
      '  </rdf:RDF>',
      '</x:xmpmeta>',
      '<?xpacket end="w"?>',
    ].join('\n');
  }

  /** Build the PDF content stream with BDC/EMC marked-content operators. */
  buildContentStream(): string {
    const streamLines: string[] = ['%%CONTENT_BEGIN'];
    for (const section of this.sections) {
      streamLines.push(`/${section.tag} << /MCID ${section.mcid} >> BDC`);
      streamLines.push('BT /F1 10 Tf');
      for (const line of section.lines) {
        streamLines.push(`(${line}) Tj T*`);
      }
      streamLines.push('ET');
      streamLines.push('EMC');
    }
    streamLines.push('%%CONTENT_END');
    return streamLines.join('\n');
  }

  /** Serialize the complete PDF/UA-tagged document to deterministic UTF-8 bytes. */
  build(): Buffer {
    const {
      periodId,
      investorId,
      batchId,
      watermarkSuppressed,
      ledgerRevisionHash,
    } = this.options;

    const headerLines: string[] = [
      '%PDF-1.4',
      '% Revora investor statement',
      `% period=${periodId}`,
      `% investor=${investorId}`,
      `% batch=${batchId}`,
    ];

    if (!watermarkSuppressed) {
      headerLines.push(
        `% WATERMARK: ${WATERMARK_DRAFT_TEXT}`,
        `/Watermark << /Type /Pagination /Subtype /Watermark /Text (${pdfSafe(WATERMARK_DRAFT_TEXT)}) /Rotation 45 /Diagonal true >>`
      );
    } else {
      headerLines.push('% WATERMARK: SUPPRESSED (FINAL SIGNED STATEMENT)');
    }

    headerLines.push(
      `% FOOTER_VERSION_STAMP: ledger_revision=${ledgerRevisionHash}`,
      `/Footer << /Text (Ledger Revision: ${pdfSafe(ledgerRevisionHash)}) >>`
    );

    const xmp = this.buildXmpMetadata();
    const contentStream = this.buildContentStream();

    // StructElem objects start at object number 8
    const firstStructElemObj = 8;
    const structElemRefs = this.sections
      .map((_, idx) => `${firstStructElemObj + idx} 0 R`)
      .join(' ');

    const objects: string[] = [
      // 1: Catalog
      `1 0 obj<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 4 0 R /Metadata 5 0 R /Lang (en-US) /ViewerPreferences << /DisplayDocTitle true >> >>endobj`,
      // 2: Pages
      `2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj`,
      // 3: Page
      `3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /StructParents 0 /Resources << /Font << /F1 7 0 R >> >> >>endobj`,
      // 4: StructTreeRoot with RoleMap & ParentTree
      `4 0 obj<< /Type /StructTreeRoot /K [${structElemRefs}] /RoleMap << /Title /H1 /Period /P /InvestorInfo /Sect /Holdings /Table /Transactions /Table /Distributions /Table /Revenue /Sect /TaxClassifications /Table /Watermark /Artifact /Footer /Artifact >> /ParentTree << /Nums [0 [${structElemRefs}]] >> >>endobj`,
      // 5: XMP Metadata stream
      `5 0 obj<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xmp, 'utf8')} >>\nstream\n${xmp}\nendstream\nendobj`,
      // 6: Content stream with BDC/EMC
      `6 0 obj<< /Length ${Buffer.byteLength(contentStream, 'utf8')} >>\nstream\n${contentStream}\nendstream\nendobj`,
      // 7: Font
      `7 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj`,
    ];

    this.sections.forEach((section, idx) => {
      const objNum = firstStructElemObj + idx;
      objects.push(
        `${objNum} 0 obj<< /Type /StructElem /S /${section.role} /P 4 0 R /Pg 3 0 R /K ${section.mcid} >>endobj`
      );
    });

    const allLines = [
      ...headerLines,
      ...objects,
      'trailer<< /Root 1 0 R >>',
      '%%EOF',
    ];

    return Buffer.from(allLines.join('\n'), 'utf8');
  }
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
 * Build a deterministic, PDF/UA-tagged statement document for the given
 * job and content.
 *
 * Frozen layout guarantees: the output depends ONLY on (job metadata,
 * statement content, watermark state, ledger revision hash). No wall-clock
 * values, random bytes, or locale-dependent formatting are ever embedded.
 * Sections are defensively re-sorted so byte-identical output holds even if
 * a data provider returns rows in a different order.
 */
function buildContentPdfDocument(
  job: PdfRenderJobRow,
  content: StatementContent,
  watermarkSuppressed: boolean,
  ledgerRevisionHash: string
): Buffer {
  const builder = new PdfDocumentBuilder({
    title: `Investor Statement ${content.periodId} - ${content.investorId}`,
    periodId: job.period_id,
    investorId: job.investor_id,
    batchId: job.batch_id,
    watermarkSuppressed,
    ledgerRevisionHash,
  });

  builder.addMarkedSection('Title', 'Title', ['STATEMENT']);
  builder.addMarkedSection('InvestorInfo', 'InvestorInfo', [
    `Investor: ${content.investorId}`,
    `Investor name: ${pdfSafe(content.investorName)}`,
  ]);
  builder.addMarkedSection('Period', 'Period', [
    `Period: ${content.periodId} (${content.periodLabel})`,
  ]);

  // Positions / holdings
  const holdings = [...content.holdings].sort(
    (a, b) =>
      a.offeringName.localeCompare(b.offeringName) ||
      a.offeringSymbol.localeCompare(b.offeringSymbol) ||
      numericCompare(a.balance, b.balance)
  );
  builder.addMarkedSection('Holdings', 'Holdings', [
    'POSITIONS',
    'OFFERING | SYMBOL | BALANCE',
    ...holdings.map(
      (holding) =>
        `${pdfSafe(holding.offeringName)} | ${pdfSafe(holding.offeringSymbol)} | ${holding.balance}`
    ),
  ]);

  // Distributions + fees
  const distributions = [...content.distributionSummary.distributions].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || numericCompare(a.amount, b.amount)
  );
  builder.addMarkedSection('Distributions', 'Distributions', [
    'DISTRIBUTIONS',
    'DATE | AMOUNT | STATUS',
    ...distributions.map(
      (distribution) =>
        `${formatIso(distribution.date)} | ${distribution.amount} | ${distribution.status}`
    ),
    `Total distributed: ${content.distributionSummary.totalDistributed}`,
    `Fees (retained revenue): ${content.distributionSummary.fees}`,
  ]);

  // Transactions
  const transactions = [...content.transactions].sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.type.localeCompare(b.type) ||
      numericCompare(a.amount, b.amount) ||
      a.description.localeCompare(b.description) ||
      a.status.localeCompare(b.status)
  );
  builder.addMarkedSection('Transactions', 'Transactions', [
    'TRANSACTIONS',
    'DATE | TYPE | DESCRIPTION | AMOUNT | STATUS',
    ...transactions.map(
      (transaction) =>
        `${formatIso(transaction.date)} | ${transaction.type} | ${pdfSafe(transaction.description)} | ${transaction.amount} | ${transaction.status}`
    ),
  ]);

  // Revenue
  if (content.revenueSummary) {
    const revLines = ['REVENUE', `Total revenue: ${content.revenueSummary.totalAmount}`];
    if (content.revenueSummary.periodStart) {
      revLines.push(`Period start: ${formatIso(content.revenueSummary.periodStart)}`);
    }
    if (content.revenueSummary.periodEnd) {
      revLines.push(`Period end: ${formatIso(content.revenueSummary.periodEnd)}`);
    }
    builder.addMarkedSection('Revenue', 'Revenue', revLines);
  }

  // Tax classifications
  const taxClassifications = [...content.taxClassifications].sort(
    (a, b) =>
      a.offeringId.localeCompare(b.offeringId) ||
      a.jurisdiction.localeCompare(b.jurisdiction) ||
      a.acquiredAt.getTime() - b.acquiredAt.getTime() ||
      numericCompare(a.costBasisPerUnit, b.costBasisPerUnit)
  );
  builder.addMarkedSection('TaxClassifications', 'TaxClassifications', [
    'TAX CLASSIFICATIONS',
    'OFFERING | JURISDICTION | QUANTITY | COST BASIS/UNIT | ACQUIRED',
    ...taxClassifications.map(
      (classification) =>
        `${pdfSafe(classification.offeringName)} | ${pdfSafe(classification.jurisdiction)} | ${classification.quantity} | ${classification.costBasisPerUnit} | ${formatIso(classification.acquiredAt)}`
    ),
  ]);

  return builder.build();
}

/**
 * Render a deterministic, content-aware statement PDF with PDF/UA structure.
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
  const bytes = buildContentPdfDocument(job, content, watermarkSuppressed, ledgerRevisionHash);
  return { bytes, watermarkSuppressed, ledgerRevisionHash };
}

function isStatementContent(value: unknown): value is StatementContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'holdings' in value &&
    'transactions' in value &&
    'distributionSummary' in value
  );
}

/**
 * Build PDF/UA-tagged payload bytes for an investor statement.
 *
 * Accepts either `(job, content, options?)` for full statement rendering or
 * `(job, options?)` for minimal job-only rendering.
 */
export function renderStatementPdfBytes(
  job: PdfRenderJobRow,
  content: StatementContent,
  options?: StatementRenderOptions
): Buffer;
export function renderStatementPdfBytes(
  job: PdfRenderJobRow,
  options?: StatementRenderOptions
): Buffer;
export function renderStatementPdfBytes(
  job: PdfRenderJobRow,
  contentOrOptions?: StatementContent | StatementRenderOptions,
  options?: StatementRenderOptions
): Buffer {
  if (isStatementContent(contentOrOptions)) {
    return renderStatementPdfWithContent(job, contentOrOptions, options).bytes;
  }
  return renderStatementPdfDetails(job, contentOrOptions).bytes;
}

export type StatementRenderFn = (
  job: PdfRenderJobRow,
  options?: StatementRenderOptions
) => Promise<StatementPdfRenderResult>;

function isDataProvider(value: unknown): value is StatementDataProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StatementDataProvider).getStatementContent === 'function'
  );
}

async function renderAndStoreStatement(
  storage: StatementPdfStorage,
  job: PdfRenderJobRow,
  mergedOptions: StatementRenderOptions,
  dataProvider?: StatementDataProvider
): Promise<StatementPdfRenderResult> {
  const storageKey =
    job.storage_key ?? buildStatementStorageKey(job.period_id, job.investor_id);

  const details = dataProvider
    ? renderStatementPdfWithContent(
        job,
        await dataProvider.getStatementContent(job.investor_id, job.period_id),
        mergedOptions
      )
    : renderStatementPdfDetails(job, mergedOptions);

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
}

/**
 * Render + store pipeline with watermark suppression, version stamp, and
 * optional `StatementDataProvider` for full PDF/UA content rendering.
 */
export function makeStatementRenderFn(
  storage: StatementPdfStorage,
  defaultOptions?: StatementRenderOptions
): StatementRenderFn;
export function makeStatementRenderFn(
  storage: StatementPdfStorage,
  dataProvider: StatementDataProvider,
  defaultOptions?: StatementRenderOptions
): StatementRenderFn;
export function makeStatementRenderFn(
  storage: StatementPdfStorage,
  optionsOrProvider?: StatementRenderOptions | StatementDataProvider,
  defaultOptions?: StatementRenderOptions
): StatementRenderFn {
  const provider = isDataProvider(optionsOrProvider) ? optionsOrProvider : undefined;
  const baseOptions = provider ? defaultOptions : optionsOrProvider;

  return async (
    job: PdfRenderJobRow,
    options?: StatementRenderOptions
  ): Promise<StatementPdfRenderResult> => {
    const mergedOptions = { ...baseOptions, ...options };
    const effectiveProvider = mergedOptions.dataProvider ?? provider;
    return renderAndStoreStatement(storage, job, mergedOptions, effectiveProvider);
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
    return renderAndStoreStatement(storage, job, mergedOptions, dataProvider);
  };
}
