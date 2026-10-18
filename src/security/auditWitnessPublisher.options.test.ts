import { Pool } from 'pg';
import { AuditWitnessPublisher } from './auditWitnessPublisher';
import { MockWitnessClient } from './witnessClient';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';

/**
 * Options/defaults + retry-schedule suite for AuditWitnessPublisher
 * (issue: AuditWitnessPublisherOptions failure handling).
 *
 * `auditWitnessPublisher.test.ts` already covers the publish/retry/exhaustion
 * happy paths. This suite pins what was left unasserted:
 *  - the documented `AuditWitnessPublisherOptions` defaults (maxRetries 3,
 *    baseBackoffMs 1000) and the exponential backoff sequence;
 *  - the exact `audit_witness_receipts` INSERT payload;
 *  - the metrics counters emitted on success and on failure;
 *  - that `publishLatest` never rejects, even when the witness is fully down.
 */
describe('AuditWitnessPublisher options and retry schedule', () => {
  let pool: jest.Mocked<Pick<Pool, 'query'>>;
  let witnessClient: MockWitnessClient;
  let publishSpy: jest.SpyInstance;
  let metrics: MetricsCollector;
  let incrementSpy: jest.SpyInstance;
  let logger: jest.Mocked<Logger>;
  let sleepDelays: number[];

  beforeEach(() => {
    sleepDelays = [];
    // Keep the suite instant while still recording the computed backoff: the
    // publisher awaits `new Promise((resolve) => setTimeout(resolve, delay))`.
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      sleepDelays.push(ms as number);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);

    pool = { query: jest.fn() } as unknown as jest.Mocked<Pick<Pool, 'query'>>;
    witnessClient = new MockWitnessClient();
    publishSpy = jest.spyOn(witnessClient, 'publish');

    metrics = new MetricsCollector({ enabled: true });
    incrementSpy = jest.spyOn(metrics, 'incrementCounter');

    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      fatal: jest.fn(),
      metric: jest.fn(),
    } as unknown as jest.Mocked<Logger>;

    // Default: no previously published hash.
    pool.query.mockResolvedValue({ rows: [] } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const build = (options: Record<string, unknown> = {}) =>
    new AuditWitnessPublisher(pool, witnessClient, { logger, metrics, ...options });

  describe('defaults', () => {
    it('uses maxRetries 3 and baseBackoffMs 1000 with the documented backoff sequence', async () => {
      const publisher = build();
      witnessClient.simulateFailureAttempts = 10; // always fails

      await expect(publisher.publishLatest('hash-down')).resolves.toBeUndefined();

      // 1 initial attempt + 3 retries.
      expect(publishSpy).toHaveBeenCalledTimes(4);
      // baseBackoffMs * 2^(attempt - 1) for attempts 1..3.
      expect(sleepDelays).toEqual([1000, 2000, 4000]);
    });

    it('leaves the saved receipt untouched when the witness never recovers', async () => {
      const publisher = build();
      witnessClient.simulateFailureAttempts = 10;

      await publisher.publishLatest('hash-down');

      // Only the getLastPublishedHash read; saveReceipt must not run.
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('SELECT root_hash'));
    });
  });

  describe('explicit options', () => {
    it('honours maxRetries and baseBackoffMs overrides', async () => {
      const publisher = build({ maxRetries: 1, baseBackoffMs: 5 });
      witnessClient.simulateFailureAttempts = 10;

      await publisher.publishLatest('hash-down');

      expect(publishSpy).toHaveBeenCalledTimes(2);
      expect(sleepDelays).toEqual([5]);
    });

    it('allows maxRetries 0, i.e. a single attempt with no sleeping', async () => {
      const publisher = build({ maxRetries: 0, baseBackoffMs: 5 });
      witnessClient.simulateFailureAttempts = 10;

      await publisher.publishLatest('hash-down');

      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(sleepDelays).toEqual([]);
    });
  });

  describe('receipt persistence', () => {
    it('inserts the receipt with a JSON-encoded receiptData and the receipt timestamp', async () => {
      const publisher = build({ maxRetries: 0 });
      pool.query
        .mockResolvedValueOnce({ rows: [] } as never) // getLastPublishedHash
        .mockResolvedValueOnce({ rowCount: 1 } as never); // saveReceipt

      await publisher.publishLatest('hash-new');

      const insertCall = pool.query.mock.calls[1];
      expect(insertCall[0]).toEqual(expect.stringContaining('INSERT INTO audit_witness_receipts'));

      const params = insertCall[1] as unknown[];
      expect(params[0]).toBe('hash-new');
      expect(params[1]).toBe('mock');
      expect(typeof params[2]).toBe('string');
      expect(JSON.parse(params[2] as string)).toEqual(
        expect.objectContaining({ attempt: expect.any(Number), txId: expect.any(String) }),
      );
      expect(params[3]).toBeInstanceOf(Date);
    });

    it('publishes when the last stored hash differs from the current head', async () => {
      const publisher = build({ maxRetries: 0 });
      pool.query
        .mockResolvedValueOnce({ rows: [{ root_hash: 'hash-old' }] } as never)
        .mockResolvedValueOnce({ rowCount: 1 } as never);

      await publisher.publishLatest('hash-new');

      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(pool.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('metrics counters', () => {
    it('increments audit.witness.published on success', async () => {
      const publisher = build({ maxRetries: 0 });
      pool.query
        .mockResolvedValueOnce({ rows: [] } as never)
        .mockResolvedValueOnce({ rowCount: 1 } as never);

      await publisher.publishLatest('hash-new');

      expect(incrementSpy).toHaveBeenCalledWith('audit.witness.published');
      expect(incrementSpy).not.toHaveBeenCalledWith('audit.witness.publish_errors');
    });

    it('increments audit.witness.publish_errors when the witness is down', async () => {
      const publisher = build({ maxRetries: 0 });
      witnessClient.simulateFailureAttempts = 10;

      await publisher.publishLatest('hash-down');

      expect(incrementSpy).toHaveBeenCalledWith('audit.witness.publish_errors');
      expect(incrementSpy).not.toHaveBeenCalledWith('audit.witness.published');
    });
  });

  describe('failure isolation', () => {
    it('never rejects even when the witness client rejects on every attempt', async () => {
      const publisher = build({ maxRetries: 1, baseBackoffMs: 1 });
      publishSpy.mockRejectedValue(new Error('witness offline'));

      await expect(publisher.publishLatest('hash-down')).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        'ALARM: Failed to publish audit root to witness',
        expect.objectContaining({
          alarm: 'audit_witness_publish_failure',
          headHash: 'hash-down',
          error: 'witness offline',
        }),
      );
    });

    it('never rejects when the read of the last published hash fails', async () => {
      const publisher = build({ maxRetries: 0 });
      pool.query.mockRejectedValueOnce(new Error('db unavailable'));

      await expect(publisher.publishLatest('hash-new')).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        'ALARM: Failed to publish audit root to witness',
        expect.objectContaining({ error: 'db unavailable' }),
      );
    });

    it('does not publish when the head hash is null or empty', async () => {
      const publisher = build({ maxRetries: 0 });

      await publisher.publishLatest(null);
      await publisher.publishLatest('');

      expect(publishSpy).not.toHaveBeenCalled();
      expect(pool.query).not.toHaveBeenCalled();
    });
  });
});
