/**
 * Tests for KMS Key Provider and ColumnEncryptionRotator service
 */

import { LocalKMSKeyProvider } from './kmsKeyProvider';
import { ColumnEncryptionRotator } from './columnEncryptionRotator';
import { InMemorySecurityAuditRepository } from './audit';
import { MetricsCollector } from '../lib/metrics';
import { Logger, LogLevel } from '../lib/logger';
import crypto from 'crypto';

describe('LocalKMSKeyProvider', () => {
  it('should initialize with generation 1 and default 32-byte key', () => {
    const provider = new LocalKMSKeyProvider();
    expect(provider.getCurrentKeyGeneration()).toBe(1);
    expect(provider.hasKeyGeneration(1)).toBe(true);
    expect(provider.hasKeyGeneration(2)).toBe(false);
  });

  it('should throw error if custom key is not 32 bytes', () => {
    expect(() => new LocalKMSKeyProvider(Buffer.from('short-key'))).toThrow(
      'KMS key must be 32 bytes for AES-256 encryption'
    );
  });

  it('should rotate key generation and increment active generation', async () => {
    const provider = new LocalKMSKeyProvider();
    const newGen = await provider.rotateKey();
    expect(newGen).toBe(2);
    expect(provider.getCurrentKeyGeneration()).toBe(2);
    expect(provider.hasKeyGeneration(1)).toBe(true);
    expect(provider.hasKeyGeneration(2)).toBe(true);
  });

  it('should allow adding custom key generation', () => {
    const provider = new LocalKMSKeyProvider();
    const customKey = crypto.randomBytes(32);
    provider.addKeyGeneration(5, customKey);
    expect(provider.hasKeyGeneration(5)).toBe(true);
    expect(provider.getCurrentKeyGeneration()).toBe(5);

    expect(() => provider.addKeyGeneration(6, Buffer.from('invalid'))).toThrow(
      'KMS key must be 32 bytes for AES-256 encryption'
    );
  });

  it('should encrypt and decrypt plaintext accurately across key generations', async () => {
    const provider = new LocalKMSKeyProvider();
    const plaintext = 'sensitive_user_ssn_12345';

    // Encrypt with gen 1
    const enc1 = await provider.encrypt(plaintext, 1);
    expect(enc1.keyGeneration).toBe(1);
    expect(enc1.ciphertext).toContain(':');

    const dec1 = await provider.decrypt(enc1.ciphertext, 1);
    expect(dec1).toBe(plaintext);

    // Rotate to gen 2
    await provider.rotateKey();
    const enc2 = await provider.encrypt(plaintext);
    expect(enc2.keyGeneration).toBe(2);

    const dec2 = await provider.decrypt(enc2.ciphertext, 2);
    expect(dec2).toBe(plaintext);
  });

  it('should throw error when encrypting or decrypting with missing key generation', async () => {
    const provider = new LocalKMSKeyProvider();
    await expect(provider.encrypt('test', 99)).rejects.toThrow(
      'KMS key generation 99 not found'
    );
    await expect(provider.decrypt('invalid:cipher:text', 99)).rejects.toThrow(
      'KMS key generation 99 not found'
    );
  });

  it('should throw error when decrypting malformed ciphertext', async () => {
    const provider = new LocalKMSKeyProvider();
    await expect(provider.decrypt('badformat', 1)).rejects.toThrow(
      'Invalid ciphertext format for KMS decryption'
    );
  });
});

describe('ColumnEncryptionRotator', () => {
  let kmsProvider: LocalKMSKeyProvider;
  let auditRepo: InMemorySecurityAuditRepository;
  let metrics: MetricsCollector;
  let logger: Logger;

  beforeEach(() => {
    kmsProvider = new LocalKMSKeyProvider();
    auditRepo = new InMemorySecurityAuditRepository();
    metrics = new MetricsCollector({ enabled: true });
    logger = new Logger({ level: LogLevel.EMERGENCY });
  });

  it('should successfully rotate column data and emit rotation.rows_reencrypted metric', async () => {
    // Seed test records encrypted under KMS generation 1
    const records = [];
    for (let i = 1; i <= 5; i++) {
      const plaintext = `secret_data_${i}`;
      const enc = await kmsProvider.encrypt(plaintext, 1);
      records.push({
        id: `row_${i}`,
        sensitiveData: enc.ciphertext,
        keyGeneration: 1,
      });
    }

    // Rotate KMS key to generation 2
    await kmsProvider.rotateKey();
    expect(kmsProvider.getCurrentKeyGeneration()).toBe(2);

    const rotator = new ColumnEncryptionRotator({
      kmsKeyProvider: kmsProvider,
      auditRepo,
      metrics,
      logger,
      inMemoryStore: records,
    });

    const job = await rotator.startRotation('kms_sample_records', 'sensitive_data', {
      targetKeyGeneration: 2,
    });

    expect(job.status).toBe('in_progress');
    expect(job.totalRows).toBe(5);

    // Process all in batches of 2
    const batch1 = await rotator.processBatch(job.id, 2);
    expect(batch1.processed).toBe(2);
    expect(batch1.completed).toBe(false);

    const batch2 = await rotator.processBatch(job.id, 2);
    expect(batch2.processed).toBe(2);

    const batch3 = await rotator.processBatch(job.id, 2);
    expect(batch3.completed).toBe(true);

    const finalState = await rotator.getJobState(job.id);
    expect(finalState?.status).toBe('completed');
    expect(finalState?.reencryptedRows).toBe(5);

    // Verify all rows in records are updated to gen 2 and decrypt correctly with gen 2 key
    for (let i = 1; i <= 5; i++) {
      const rec = records.find((r) => r.id === `row_${i}`)!;
      expect(rec.keyGeneration).toBe(2);
      const dec = await kmsProvider.decrypt(rec.sensitiveData, 2);
      expect(dec).toBe(`secret_data_${i}`);
    }

    // Verify rotation.rows_reencrypted metric was emitted 5 times
    const snapshot = await metrics.getSnapshot();
    const rowsReencryptedMetric = snapshot.custom.find(
      (p) => p.name === 'rotation_rows_reencrypted' || p.name === 'rotation.rows_reencrypted'
    );
    expect(rowsReencryptedMetric?.value).toBe(5);

    // Verify security audit events logged
    const auditEvents = auditRepo.getAllEvents();
    expect(auditEvents.some((e) => e.action === 'KMS_KEY_ROTATION_STARTED')).toBe(true);
    expect(auditEvents.some((e) => e.action === 'KMS_KEY_ROTATION_COMPLETED')).toBe(true);
  });

  it('should resume after crash mid-batch without double re-encrypting rows', async () => {
    // Seed 4 records encrypted under gen 1
    const records = [];
    for (let i = 1; i <= 4; i++) {
      const enc = await kmsProvider.encrypt(`data_${i}`, 1);
      records.push({
        id: `row_${i}`,
        sensitiveData: enc.ciphertext,
        keyGeneration: 1,
      });
    }

    // Rotate KMS key to gen 2
    await kmsProvider.rotateKey();

    // First rotator instance runs batch 1 (re-encrypts 2 rows)
    const rotator1 = new ColumnEncryptionRotator({
      kmsKeyProvider: kmsProvider,
      auditRepo,
      metrics,
      logger,
      inMemoryStore: records,
    });

    const job = await rotator1.startRotation('kms_sample_records', 'sensitive_data', {
      targetKeyGeneration: 2,
    });

    await rotator1.processBatch(job.id, 2);

    // Verify row_1 and row_2 are now at gen 2
    expect(records[0].keyGeneration).toBe(2);
    expect(records[1].keyGeneration).toBe(2);
    expect(records[2].keyGeneration).toBe(1);
    expect(records[3].keyGeneration).toBe(1);

    // Simulate crash / restart: create new rotator instance resuming pending rotations
    const rotator2 = new ColumnEncryptionRotator({
      kmsKeyProvider: kmsProvider,
      auditRepo,
      metrics,
      logger,
      inMemoryStore: records,
    });

    // Re-register job state in memory of new rotator instance
    const savedState = await rotator1.getJobState(job.id);
    await (rotator2 as any).saveJobState(savedState);

    const resumedJobs = await rotator2.resumePendingRotations(10);
    expect(resumedJobs.length).toBe(1);
    expect(resumedJobs[0].status).toBe('completed');
    expect(resumedJobs[0].reencryptedRows).toBe(4);

    // Verify all 4 rows are now gen 2 without double re-encrypting row 1 and row 2
    for (let i = 0; i < 4; i++) {
      expect(records[i].keyGeneration).toBe(2);
      const dec = await kmsProvider.decrypt(records[i].sensitiveData, 2);
      expect(dec).toBe(`data_${i + 1}`);
    }
  });

  it('should handle corrupted rows gracefully and update failedRows count & audit failure', async () => {
    const enc = await kmsProvider.encrypt('valid_data', 1);
    const records = [
      { id: 'row_good', sensitiveData: enc.ciphertext, keyGeneration: 1 },
      { id: 'row_bad', sensitiveData: 'corrupted:cipher:text', keyGeneration: 1 },
    ];

    await kmsProvider.rotateKey();

    const rotator = new ColumnEncryptionRotator({
      kmsKeyProvider: kmsProvider,
      auditRepo,
      metrics,
      logger,
      inMemoryStore: records,
    });

    const job = await rotator.startRotation('kms_sample_records', 'sensitive_data', {
      targetKeyGeneration: 2,
    });

    await rotator.processBatch(job.id, 10);

    const state = await rotator.getJobState(job.id);
    expect(state?.reencryptedRows).toBe(1);
    expect(state?.failedRows).toBe(1);

    const auditEvents = auditRepo.getAllEvents();
    expect(auditEvents.some((e) => e.action === 'KMS_ROW_REENCRYPT_FAILED')).toBe(true);
  });

  it('should work with PostgreSQL pool queries when dbPool is provided', async () => {
    const mockQuery = jest.fn();

    // Mock count query
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 3 }] });
    // Mock insert job state
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Mock fetch batch query
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: '1', ciphertext: 'iv:tag:enc1', key_generation: 1 },
        { id: '2', ciphertext: 'iv:tag:enc2', key_generation: 1 },
      ],
    });
    // Mock update row 1
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Mock update row 2
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Mock remaining count check
    mockQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    // Mock update job completed
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // Mock decrypt / encrypt on kmsProvider
    jest.spyOn(kmsProvider, 'decrypt').mockResolvedValue('decrypted_text');
    jest.spyOn(kmsProvider, 'encrypt').mockResolvedValue({ ciphertext: 'iv:tag:new_enc', keyGeneration: 2 });

    const mockPool = { query: mockQuery };
    const rotator = new ColumnEncryptionRotator({
      pool: mockPool as any,
      kmsKeyProvider: kmsProvider,
      auditRepo,
      metrics,
      logger,
    });

    const job = await rotator.startRotation('users', 'ssn', { targetKeyGeneration: 2 });
    expect(job.totalRows).toBe(3);

    // Mock getJobState return for processBatch
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: job.id,
          target_table: 'users',
          target_column: 'ssn',
          target_key_generation: 2,
          last_processed_id: null,
          status: 'in_progress',
          total_rows: '3',
          reencrypted_rows: '0',
          failed_rows: '0',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null,
        },
      ],
    });

    const batchRes = await rotator.processBatch(job.id, 2);
    expect(batchRes.processed).toBe(2);
  });

  it('should return completed state immediately if job is already completed', async () => {
    const rotator = new ColumnEncryptionRotator({
      kmsKeyProvider: kmsProvider,
      auditRepo,
      metrics,
      logger,
      inMemoryStore: [],
    });

    const job = await rotator.startRotation('kms_sample_records', 'sensitive_data', {
      targetKeyGeneration: 2,
    });

    (job as any).status = 'completed';
    await (rotator as any).saveJobState(job);

    const reStartJob = await rotator.startRotation('kms_sample_records', 'sensitive_data', {
      targetKeyGeneration: 2,
    });
    expect(reStartJob.status).toBe('completed');

    const batchRes = await rotator.processBatch(job.id, 10);
    expect(batchRes.completed).toBe(true);
    expect(batchRes.processed).toBe(0);
  });
});
