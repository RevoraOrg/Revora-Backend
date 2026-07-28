import crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  renderStatementPdfBytes,
  renderStatementPdfDetails,
  makeStatementRenderFn,
  verifyTreasurySignature,
  parseEd25519PublicKey,
  statementPdfEventEmitter,
  InMemoryStatementPdfStorage,
  WATERMARK_DRAFT_TEXT,
  EVENT_PDF_WATERMARK_SUPPRESSED,
  StatementFinalFlag,
  FinalSignaturePayload,
} from './statementPdfService';
import {
  PdfRenderJobRow,
  buildStatementStorageKey,
  checksumPayload,
} from '../db/repositories/pdfRenderJobRepository';

function makeJob(overrides: Partial<PdfRenderJobRow> = {}): PdfRenderJobRow {
  const period_id = overrides.period_id ?? '2026-07';
  const investor_id = overrides.investor_id ?? 'inv-999';
  return {
    id: 'job-123',
    batch_id: 'batch-abc',
    investor_id,
    period_id,
    status: 'processing',
    attempts: 1,
    available_at: new Date(),
    claimed_at: new Date(),
    storage_key: buildStatementStorageKey(period_id, investor_id),
    checksum: null,
    error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function createTreasuryKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function signPayload(
  payloadObj: FinalSignaturePayload,
  privateKey: crypto.KeyObject
): StatementFinalFlag {
  const sortedKeys = Object.keys(payloadObj).sort();
  const canonical = JSON.stringify(payloadObj, sortedKeys);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey);
  return {
    signature: signature.toString('base64'),
    payload: payloadObj,
  };
}

describe('statementPdfService - Draft Watermark and Version Stamp (#487)', () => {
  let treasuryKeyPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };

  beforeAll(() => {
    treasuryKeyPair = createTreasuryKeyPair();
  });

  describe('Draft Statement Generation (Watermark ON)', () => {
    it('renders pre-audit draft statements with DRAFT watermark and footer version stamp by default', () => {
      const job = makeJob();
      const result = renderStatementPdfDetails(job);
      const pdfText = result.bytes.toString('utf8');

      expect(result.watermarkSuppressed).toBe(false);
      expect(pdfText).toContain(WATERMARK_DRAFT_TEXT);
      expect(pdfText).toContain('/Watermark');
      expect(pdfText).toContain('Rotation 45');
      expect(pdfText).toContain('FOOTER_VERSION_STAMP: ledger_revision=');
      expect(pdfText).toContain(`/Footer << /Text (Ledger Revision: ${result.ledgerRevisionHash}) >>`);
    });

    it('uses provided ledgerRevisionHash in footer version stamp', () => {
      const job = makeJob();
      const customHash = 'rev-1234567890abcdef';
      const result = renderStatementPdfDetails(job, { ledgerRevisionHash: customHash });
      const pdfText = result.bytes.toString('utf8');

      expect(result.ledgerRevisionHash).toBe(customHash);
      expect(pdfText).toContain(`ledger_revision=${customHash}`);
    });

    it('returns PDF Buffer directly from renderStatementPdfBytes', () => {
      const job = makeJob();
      const bytes = renderStatementPdfBytes(job);
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect(bytes.toString('utf8')).toContain(WATERMARK_DRAFT_TEXT);
    });
  });

  describe('Final Statement Generation (Watermark SUPPRESSED with Ed25519 Treasury Signature)', () => {
    it('suppresses watermark when a valid Ed25519 treasury signature is provided', () => {
      const job = makeJob({ period_id: '2026-07', investor_id: 'inv-42' });
      const ledgerRevisionHash = 'rev-hash-999';
      const payloadObj: FinalSignaturePayload = {
        periodId: '2026-07',
        investorId: 'inv-42',
        ledgerRevisionHash,
        timestamp: Date.now(),
        expiresAt: Date.now() + 3600_000,
      };

      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
        ledgerRevisionHash,
      });

      const pdfText = result.bytes.toString('utf8');

      expect(result.watermarkSuppressed).toBe(true);
      expect(pdfText).not.toContain(WATERMARK_DRAFT_TEXT);
      expect(pdfText).toContain('WATERMARK: SUPPRESSED (FINAL SIGNED STATEMENT)');
      expect(pdfText).toContain(`ledger_revision=${ledgerRevisionHash}`);
    });

    it('emits pdf.watermark.suppressed audit event when watermark is suppressed', (done) => {
      const job = makeJob({ period_id: '2026-07', investor_id: 'inv-777' });
      const ledgerRevisionHash = 'rev-777';
      const payloadObj: FinalSignaturePayload = {
        periodId: '2026-07',
        investorId: 'inv-777',
        ledgerRevisionHash,
        timestamp: Date.now(),
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);
      const customEmitter = new EventEmitter();

      customEmitter.on(EVENT_PDF_WATERMARK_SUPPRESSED, (eventData) => {
        expect(eventData.event).toBe(EVENT_PDF_WATERMARK_SUPPRESSED);
        expect(eventData.periodId).toBe('2026-07');
        expect(eventData.investorId).toBe('inv-777');
        expect(eventData.ledgerRevisionHash).toBe(ledgerRevisionHash);
        expect(eventData.batchId).toBe(job.batch_id);
        done();
      });

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
        eventEmitter: customEmitter,
      });

      expect(result.watermarkSuppressed).toBe(true);
    });

    it('records audit log entry when auditLogRepository is provided', async () => {
      const job = makeJob();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-audit',
        timestamp: Date.now(),
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);
      const mockAuditLogRepo = {
        createAuditLog: jest.fn().mockResolvedValue({ id: 'log-1' }),
      } as any;

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
        auditLogRepository: mockAuditLogRepo,
      });

      expect(result.watermarkSuppressed).toBe(true);
      expect(mockAuditLogRepo.createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: EVENT_PDF_WATERMARK_SUPPRESSED,
          resource: `statement:${job.period_id}:${job.investor_id}`,
        })
      );
    });

    it('supports stringified JSON signature payloads', () => {
      const job = makeJob();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-str-payload',
        timestamp: Date.now(),
      };
      const sortedKeys = Object.keys(payloadObj).sort();
      const jsonStr = JSON.stringify(payloadObj, sortedKeys);
      const signatureBuf = crypto.sign(null, Buffer.from(jsonStr, 'utf8'), treasuryKeyPair.privateKey);

      const finalFlag: StatementFinalFlag = {
        signature: signatureBuf.toString('hex'),
        payload: jsonStr,
      };

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });

      expect(result.watermarkSuppressed).toBe(true);
    });
  });

  describe('Edge Cases and Security Boundaries (Watermark Remains ON)', () => {
    it('keeps watermark ON when signature is missing', () => {
      const job = makeJob();
      const result = renderStatementPdfDetails(job, {
        finalFlag: { signature: '', payload: { periodId: job.period_id, investorId: job.investor_id, ledgerRevisionHash: 'h', timestamp: Date.now() } },
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });

      expect(result.watermarkSuppressed).toBe(false);
      expect(result.bytes.toString('utf8')).toContain(WATERMARK_DRAFT_TEXT);
    });

    it('keeps watermark ON when signature is expired', () => {
      const job = makeJob();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-exp',
        timestamp: Date.now() - 100_000,
        expiresAt: Date.now() - 1000, // expired 1 second ago
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });

      expect(result.watermarkSuppressed).toBe(false);
      expect(result.bytes.toString('utf8')).toContain(WATERMARK_DRAFT_TEXT);
    });

    it('keeps watermark ON when timestamp is in the future by > 5 min', () => {
      const job = makeJob();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-fut',
        timestamp: Date.now() + 600_000, // 10 minutes in future
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });

      expect(result.watermarkSuppressed).toBe(false);
    });

    it('keeps watermark ON when timestamp is stale (> 24 hours) without explicit expiresAt', () => {
      const job = makeJob();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-stale',
        timestamp: Date.now() - 86_400_000 * 2, // 2 days ago
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });

      expect(result.watermarkSuppressed).toBe(false);
    });

    it('keeps watermark ON when signature is forged / invalid', () => {
      const job = makeJob();
      const otherKey = createTreasuryKeyPair();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-forged',
        timestamp: Date.now(),
      };
      // Signed with a different key
      const finalFlag = signPayload(payloadObj, otherKey.privateKey);

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });

      expect(result.watermarkSuppressed).toBe(false);
      expect(result.bytes.toString('utf8')).toContain(WATERMARK_DRAFT_TEXT);
    });

    it('keeps watermark ON when periodId does not match job', () => {
      const job = makeJob({ period_id: '2026-07' });
      const payloadObj: FinalSignaturePayload = {
        periodId: '2026-08', // mismatch
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-period-mismatch',
        timestamp: Date.now(),
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });

      expect(result.watermarkSuppressed).toBe(false);
    });

    it('keeps watermark ON when investorId does not match job', () => {
      const job = makeJob({ investor_id: 'inv-100' });
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: 'inv-999', // mismatch
        ledgerRevisionHash: 'rev-inv-mismatch',
        timestamp: Date.now(),
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });

      expect(result.watermarkSuppressed).toBe(false);
    });

    it('keeps watermark ON when ledgerRevisionHash in options mismatches signed payload', () => {
      const job = makeJob();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'hash-A',
        timestamp: Date.now(),
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
        ledgerRevisionHash: 'hash-B', // mismatch
      });

      expect(result.watermarkSuppressed).toBe(false);
    });

    it('keeps watermark ON when treasury public key is not configured', () => {
      const oldEnv = process.env.TREASURY_ED25519_PUBKEY;
      delete process.env.TREASURY_ED25519_PUBKEY;
      try {
        const job = makeJob();
        const payloadObj: FinalSignaturePayload = {
          periodId: job.period_id,
          investorId: job.investor_id,
          ledgerRevisionHash: 'rev-no-key',
          timestamp: Date.now(),
        };
        const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

        const result = renderStatementPdfDetails(job, { finalFlag });
        expect(result.watermarkSuppressed).toBe(false);
      } finally {
        if (oldEnv) process.env.TREASURY_ED25519_PUBKEY = oldEnv;
      }
    });

    it('reads treasury public key from process.env.TREASURY_ED25519_PUBKEY if omitted from options', () => {
      const spkiPem = treasuryKeyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
      process.env.TREASURY_ED25519_PUBKEY = spkiPem;

      try {
        const job = makeJob();
        const payloadObj: FinalSignaturePayload = {
          periodId: job.period_id,
          investorId: job.investor_id,
          ledgerRevisionHash: 'rev-env-key',
          timestamp: Date.now(),
        };
        const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

        const result = renderStatementPdfDetails(job, { finalFlag });
        expect(result.watermarkSuppressed).toBe(true);
      } finally {
        delete process.env.TREASURY_ED25519_PUBKEY;
      }
    });
  });

  describe('Ed25519 Key Parser Formats', () => {
    it('parses PEM, raw Hex (64 chars), Base64, and KeyObject correctly', () => {
      const keyObj = treasuryKeyPair.publicKey;
      expect(parseEd25519PublicKey(keyObj)).toBe(keyObj);

      const pem = keyObj.export({ format: 'pem', type: 'spki' }).toString();
      expect(parseEd25519PublicKey(pem)).toBeDefined();

      const spkiDer = keyObj.export({ format: 'der', type: 'spki' });
      expect(parseEd25519PublicKey(spkiDer.toString('hex'))).toBeDefined();

      const raw32 = spkiDer.subarray(spkiDer.length - 32);
      expect(parseEd25519PublicKey(raw32.toString('hex'))).toBeDefined();
      expect(parseEd25519PublicKey(raw32.toString('base64'))).toBeDefined();
    });

    it('throws error for malformed key inputs', () => {
      expect(() => parseEd25519PublicKey('not-a-key')).toThrow();
    });
  });

  describe('Storage & Render Function Integration (makeStatementRenderFn)', () => {
    it('renders and stores PDF bytes with checksum verification and watermark metadata', async () => {
      const storage = new InMemoryStatementPdfStorage();
      const renderFn = makeStatementRenderFn(storage);
      const job = makeJob();

      const res = await renderFn(job);
      expect(res.storageKey).toBe(buildStatementStorageKey(job.period_id, job.investor_id));
      expect(res.checksum).toBe(checksumPayload(res.bytes));
      expect(res.watermarkSuppressed).toBe(false);

      const stored = await storage.getObject(res.storageKey);
      expect(stored).not.toBeNull();
      expect(stored?.equals(res.bytes)).toBe(true);
    });

    it('passes options through makeStatementRenderFn for final signed render', async () => {
      const storage = new InMemoryStatementPdfStorage();
      const payloadObj: FinalSignaturePayload = {
        periodId: '2026-07',
        investorId: 'inv-999',
        ledgerRevisionHash: 'rev-stored-final',
        timestamp: Date.now(),
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

      const renderFn = makeStatementRenderFn(storage, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });
      const job = makeJob({ period_id: '2026-07', investor_id: 'inv-999' });

      const res = await renderFn(job);
      expect(res.watermarkSuppressed).toBe(true);
      expect(res.bytes.toString('utf8')).not.toContain(WATERMARK_DRAFT_TEXT);
    });

    it('handles audit log repository rejection gracefully', async () => {
      const job = makeJob();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-audit-err',
        timestamp: Date.now(),
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);
      const failingAuditLogRepo = {
        createAuditLog: jest.fn().mockRejectedValue(new Error('DB write failed')),
      } as any;

      const result = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
        auditLogRepository: failingAuditLogRepo,
      });

      expect(result.watermarkSuppressed).toBe(true);
      // Wait for catch block microtask
      await new Promise((r) => setTimeout(r, 10));
      expect(failingAuditLogRepo.createAuditLog).toHaveBeenCalled();
    });

    it('handles invalid JSON string in finalFlag payload', () => {
      const job = makeJob();
      const res = verifyTreasurySignature(job, {
        finalFlag: { signature: 'sig', payload: 'not-valid-json{{{' },
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toBe('Invalid JSON payload string');
    });

    it('handles invalid treasury public key error during signature verification', () => {
      const job = makeJob();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-key-err',
        timestamp: Date.now(),
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

      const res = verifyTreasurySignature(job, {
        finalFlag,
        treasuryPublicKey: 'bad-key-string-12345',
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('Invalid treasury public key');
    });

    it('parses raw Buffer public key (>32 bytes) in parseEd25519PublicKey', () => {
      const spkiDer = treasuryKeyPair.publicKey.export({ format: 'der', type: 'spki' });
      // Buffer larger than 32 bytes
      expect(parseEd25519PublicKey(spkiDer)).toBeDefined();
    });

    it('handles buffer fallback for non-DER buffer > 32 bytes in parseEd25519PublicKey', () => {
      const raw32 = treasuryKeyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
      const paddedBuf = Buffer.concat([Buffer.alloc(10), raw32]); // 42 bytes
      expect(parseEd25519PublicKey(paddedBuf)).toBeDefined();
    });

    it('throws error for invalid input types in parseEd25519PublicKey', () => {
      expect(() => parseEd25519PublicKey(12345 as any)).toThrow('Invalid Ed25519 public key input');
    });

    it('handles crypto.verify thrown error for malformed signature length', () => {
      const job = makeJob();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-short-sig',
        timestamp: Date.now(),
      };
      const res = verifyTreasurySignature(job, {
        finalFlag: { signature: '12345678', payload: payloadObj },
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });
      expect(res.valid).toBe(false);
      expect(res.reason).toBe('Ed25519 signature verification failed');
    });

    it('handles crypto.verify thrown error during signature verification', () => {
      const job = makeJob();
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-err',
        timestamp: Date.now(),
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);
      jest.spyOn(crypto, 'verify').mockImplementationOnce(() => {
        throw new Error('Crypto internal error');
      });

      const res = verifyTreasurySignature(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });

      expect(res.valid).toBe(false);
      expect(res.reason).toBe('Signature verification error: Crypto internal error');
    });

    it('handles timestamp and expiresAt formatted as Unix epoch seconds (<1e11)', () => {
      const job = makeJob();
      const nowSec = Math.floor(Date.now() / 1000);
      const payloadObj: FinalSignaturePayload = {
        periodId: job.period_id,
        investorId: job.investor_id,
        ledgerRevisionHash: 'rev-sec',
        timestamp: nowSec,
        expiresAt: nowSec + 3600,
      };
      const finalFlag = signPayload(payloadObj, treasuryKeyPair.privateKey);

      const res = renderStatementPdfDetails(job, {
        finalFlag,
        treasuryPublicKey: treasuryKeyPair.publicKey,
      });

      expect(res.watermarkSuppressed).toBe(true);
    });
  });
});
