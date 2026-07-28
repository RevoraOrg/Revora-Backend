import { Pool } from 'pg';
import { AuditWitnessPublisher } from './auditWitnessPublisher';
import { MockWitnessClient } from './witnessClient';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';

describe('AuditWitnessPublisher', () => {
  let pool: jest.Mocked<Pick<Pool, 'query'>>;
  let witnessClient: MockWitnessClient;
  let metrics: MetricsCollector;
  let logger: jest.Mocked<Logger>;
  let publisher: AuditWitnessPublisher;

  beforeEach(() => {
    pool = {
      query: jest.fn(),
    } as unknown as jest.Mocked<Pick<Pool, 'query'>>;

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
      baseBackoffMs: 10, // fast for tests
    });

    pool.query.mockResolvedValue({ rows: [] } as any);
  });

  it('does nothing if headHash is null', async () => {
    await publisher.publishLatest(null);
    expect(pool.query).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith('No head hash to publish');
  });

  it('does not publish if the hash is already the last published', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ root_hash: 'hash123' }] } as any);
    await publisher.publishLatest('hash123');
    
    expect(pool.query).toHaveBeenCalledTimes(1); // Only checking last published
    expect(logger.debug).toHaveBeenCalledWith('Hash already published', expect.objectContaining({ headHash: 'hash123' }));
  });

  it('publishes and saves receipt successfully', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] } as any) // getLastPublishedHash
      .mockResolvedValueOnce({ rowCount: 1 } as any); // saveReceipt

    await publisher.publishLatest('newhash456');

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO audit_witness_receipts'), [
      'newhash456',
      'mock',
      expect.any(String),
      expect.any(Date),
    ]);

    expect(logger.info).toHaveBeenCalledWith('Audit log Merkle root published to witness', expect.objectContaining({
      headHash: 'newhash456',
    }));
    
    // Test that the metric was recorded (this relies on your metrics collector implementation in tests)
    // You could assert internal state of metrics or just trust it.
  });

  it('retries on failure and eventually succeeds', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] } as any)
      .mockResolvedValueOnce({ rowCount: 1 } as any);

    witnessClient.simulateFailureAttempts = 2; // Will fail twice, succeed on third attempt
    
    await publisher.publishLatest('hash-retry');

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenNthCalledWith(1, expect.stringContaining('Witness publish attempt 1 failed'), expect.any(Object));
    expect(logger.warn).toHaveBeenNthCalledWith(2, expect.stringContaining('Witness publish attempt 2 failed'), expect.any(Object));
    
    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith('Audit log Merkle root published to witness', expect.any(Object));
  });

  it('emits error alarm and fails gracefully on exhaustion', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] } as any);
    
    witnessClient.simulateFailureAttempts = 5; // More than maxRetries
    
    await publisher.publishLatest('hash-fail');

    expect(logger.warn).toHaveBeenCalledTimes(2); // attempt 1, 2
    expect(logger.error).toHaveBeenCalledWith('ALARM: Failed to publish audit root to witness', expect.objectContaining({
      alarm: 'audit_witness_publish_failure',
    }));
    // Should NOT throw
  });
});
