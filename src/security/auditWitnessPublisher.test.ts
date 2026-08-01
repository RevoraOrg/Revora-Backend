/**
 * Tests for AuditWitnessPublisher (issue #721).
 *
 * Covers:
 *   - publishLatest skip / publish / retry / exhaustion isolation
 *   - publishDayRoot Merkle construction + empty day + downtime isolation
 *   - StellarMemoWitnessClient validation + dry-run receipt
 */

import { Pool } from 'pg';
import { AuditWitnessPublisher } from './auditWitnessPublisher';
import { MockWitnessClient, StellarMemoWitnessClient } from './witnessClient';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';
import { createHash } from 'crypto';
import { hashPair } from './auditMerkle';

describe('AuditWitnessPublisher', () => {
  let pool: jest.Mocked<Pick<Pool, 'query'>>;
  let witnessClient: MockWitnessClient;
  let metrics: MetricsCollector;
  let logger: jest.Mocked<Logger>;
  let publisher: AuditWitnessPublisher;

  beforeEach(() => {
    pool = { query: jest.fn() } as unknown as jest.Mocked<Pick<Pool, 'query'>>;
    witnessClient = new MockWitnessClient();
    metrics = new MetricsCollector({ enabled: true });
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      fatal: jest.fn(),
      metric: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    publisher = new AuditWitnessPublisher(pool, witnessClient, {
      logger,
      metrics,
      maxRetries: 2,
      baseBackoffMs: 10,
      now: () => new Date('2026-08-01T12:00:00Z'),
    });

    pool.query.mockResolvedValue({ rows: [] } as any);
  });

  // ── publishLatest ──────────────────────────────────────────────────────────

  it('does nothing if headHash is null', async () => {
    await publisher.publishLatest(null);
    expect(pool.query).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith('No head hash to publish');
  });

  it('does not publish if the hash is already the last published', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ root_hash: 'hash123' }] } as any);
    await publisher.publishLatest('hash123');

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      'Hash already published',
      expect.objectContaining({ rootHash: 'hash123' }),
    );
  });

  it('publishes and saves receipt successfully', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rowCount: 1 } as any);

    await publisher.publishLatest('newhash456');

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('INSERT INTO audit_witness_receipts'),
      ['newhash456', 'mock', expect.any(String), expect.any(Date)],
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Audit log Merkle root published to witness',
      expect.objectContaining({ rootHash: 'newhash456' }),
    );

    const snapshot = await metrics.getSnapshot();
    const published = snapshot.custom.find((m) => m.name === 'audit_witness_published');
    expect(published?.value).toBe(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rowCount: 1 } as any);

    witnessClient.simulateFailureAttempts = 2;

    await publisher.publishLatest('hash-retry');

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      'Audit log Merkle root published to witness',
      expect.any(Object),
    );
  });

  it('emits error alarm and fails gracefully on exhaustion', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] } as any);
    witnessClient.simulateFailureAttempts = 5;

    await expect(publisher.publishLatest('hash-fail')).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      'ALARM: Failed to publish audit root to witness',
      expect.objectContaining({ alarm: 'audit_witness_publish_failure' }),
    );

    const snapshot = await metrics.getSnapshot();
    const errors = snapshot.custom.find((m) => m.name === 'audit_witness_publish_errors');
    expect(errors?.value).toBe(1);
  });

  // ── publishDayRoot ─────────────────────────────────────────────────────────

  it('computes the day Merkle root and publishes it', async () => {
    const a = createHash('sha256').update('a').digest('hex');
    const b = createHash('sha256').update('b').digest('hex');
    const expectedRoot = hashPair(a, b);

    pool.query
      .mockResolvedValueOnce({ rows: [{ row_hash: a }, { row_hash: b }] } as any) // loadDayRowHashes
      .mockResolvedValueOnce({ rows: [] } as any) // getLastPublishedHash
      .mockResolvedValueOnce({ rowCount: 1 } as any); // saveReceipt

    await publisher.publishDayRoot(new Date('2026-07-31T00:00:00Z'));

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('FROM audit_logs'),
      [new Date('2026-07-31T00:00:00.000Z'), new Date('2026-08-01T00:00:00.000Z')],
    );
    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO audit_witness_receipts'),
      [expectedRoot, 'mock', expect.any(String), expect.any(Date)],
    );
  });

  it('skips publish when the day has no audit rows', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] } as any);
    await publisher.publishDayRoot(new Date('2026-07-31T00:00:00Z'));
    expect(logger.debug).toHaveBeenCalledWith(
      'No audit rows for day — nothing to witness',
      expect.objectContaining({ day: '2026-07-31' }),
    );
  });

  it('witness downtime does not break local integrity (day root)', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(publisher.publishDayRoot()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'ALARM: Failed to publish audit root to witness',
      expect.objectContaining({ alarm: 'audit_witness_publish_failure' }),
    );
  });
});

describe('StellarMemoWitnessClient', () => {
  it('rejects a non-hex root', async () => {
    const client = new StellarMemoWitnessClient();
    await expect(client.publish('not-a-hash')).rejects.toThrow(/64-char hex/);
  });

  it('returns a dry-run stellar receipt when no submitter is configured', async () => {
    const root = createHash('sha256').update('root').digest('hex');
    const client = new StellarMemoWitnessClient({ network: 'testnet' });
    const receipt = await client.publish(root);
    expect(receipt.witnessType).toBe('stellar');
    expect(receipt.rootHash).toBe(root);
    expect(receipt.receiptData.dryRun).toBe(true);
    expect(String(receipt.receiptData.memo)).toContain(root.slice(0, 20));
  });

  it('uses the injected Horizon submitter when provided', async () => {
    const root = createHash('sha256').update('root').digest('hex');
    const submitMemo = jest.fn().mockResolvedValue({ txHash: 'tx-abc' });
    const client = new StellarMemoWitnessClient({ submitMemo, network: 'public' });
    const receipt = await client.publish(root);
    expect(submitMemo).toHaveBeenCalled();
    expect(receipt.receiptData.txHash).toBe('tx-abc');
    expect(receipt.receiptData.dryRun).toBeUndefined();
  });
});
