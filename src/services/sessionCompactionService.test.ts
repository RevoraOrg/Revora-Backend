import { SessionCompactionService } from './sessionCompactionService';
import { SessionRepository } from '../db/repositories/sessionRepository';
import { MetricsCollector } from '../lib/metrics';
import { env } from '../config/env';
import { globalLogger } from '../lib/logger';

describe('SessionCompactionService', () => {
  let sessionRepo: jest.Mocked<SessionRepository>;
  let metrics: jest.Mocked<MetricsCollector>;
  let service: SessionCompactionService;

  beforeEach(() => {
    sessionRepo = {
      purgeOlderThan: jest.fn(),
      getOldestCompactedSessionDate: jest.fn(),
      vacuumSessions: jest.fn(),
    } as any;

    metrics = {
      incrementCounter: jest.fn(),
      recordHistogram: jest.fn(),
    } as any;

    env.SESSION_RETENTION_DAYS = 30;

    service = new SessionCompactionService(sessionRepo, metrics);

    jest.useFakeTimers();
    jest.spyOn(globalLogger, 'info').mockImplementation(() => {});
    jest.spyOn(globalLogger, 'error').mockImplementation(() => {});
    jest.spyOn(globalLogger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    service.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('deletes sessions in bounded batches and vacuums', async () => {
    // First batch returns a full batch (1000), the second a partial batch,
    // signalling that the table has been drained.
    sessionRepo.purgeOlderThan
      .mockResolvedValueOnce(1000)
      .mockResolvedValueOnce(500);

    sessionRepo.getOldestCompactedSessionDate.mockResolvedValue(
      new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    );

    const result = await service.runCompaction(1000);

    expect(result.deletedCount).toBe(1500);
    expect(result.capHit).toBe(false);
    expect(sessionRepo.purgeOlderThan).toHaveBeenCalledTimes(2);
    expect(sessionRepo.purgeOlderThan).toHaveBeenCalledWith(30, 1000);
    expect(sessionRepo.vacuumSessions).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'session.compaction.rows',
      { status: 'success' },
      1500,
    );
    // 40 days - 30 days = 10 days lag from the retention boundary
    expect(metrics.recordHistogram).toHaveBeenCalledWith(
      'session.compaction.retention_lag_days',
      10,
      { status: 'success' },
    );
  });

  it('does not vacuum when nothing was deleted', async () => {
    sessionRepo.purgeOlderThan.mockResolvedValue(0);
    sessionRepo.getOldestCompactedSessionDate.mockResolvedValue(null);

    const result = await service.runCompaction(1000);

    expect(result.deletedCount).toBe(0);
    expect(result.lagDays).toBe(0);
    expect(sessionRepo.purgeOlderThan).toHaveBeenCalledTimes(1);
    expect(sessionRepo.vacuumSessions).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'session.compaction.rows',
      { status: 'success' },
      0,
    );
  });

  it('records error metrics if compaction fails', async () => {
    sessionRepo.purgeOlderThan.mockRejectedValue(new Error('DB failure'));

    await expect(service.runCompaction(1000)).rejects.toThrow('DB failure');

    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'session.compaction.errors_total',
      { status: 'error' },
    );
    expect(metrics.recordHistogram).toHaveBeenCalledWith(
      'session.compaction.duration_ms',
      expect.any(Number),
      { status: 'error' },
    );
  });

  it('passes retention days (not a server-derived cutoff) to the repository', async () => {
    // Bad-clock safety: the boundary must be computed by the DATABASE clock.
    // The service therefore hands the repository a number of days, never a
    // Date derived from a potentially skewed application-server clock.
    sessionRepo.purgeOlderThan.mockResolvedValue(0);
    sessionRepo.getOldestCompactedSessionDate.mockResolvedValue(null);

    await service.runCompaction(1000);

    const [retentionArg, batchArg] = sessionRepo.purgeOlderThan.mock.calls[0];
    expect(retentionArg).toBe(env.SESSION_RETENTION_DAYS);
    expect(retentionArg).not.toBeInstanceOf(Date);
    expect(batchArg).toBe(1000);

    const [oldestArg] = sessionRepo.getOldestCompactedSessionDate.mock.calls[0];
    expect(oldestArg).not.toBeInstanceOf(Date);
    expect(oldestArg).toBe(env.SESSION_RETENTION_DAYS);
  });

  it('stops at the per-run cap and emits the cap_hit metric', async () => {
    // Simulate a table with far more eligible rows than the cap: every batch
    // comes back full.
    sessionRepo.purgeOlderThan.mockImplementation(async (_retention, size) => size);
    sessionRepo.getOldestCompactedSessionDate.mockResolvedValue(
      new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    );

    const result = await service.runCompaction(1000, 2500);

    expect(result.deletedCount).toBe(2500);
    expect(result.capHit).toBe(true);
    // Batches of 1000, 1000, then a truncated 500 to land exactly on the cap.
    expect(sessionRepo.purgeOlderThan).toHaveBeenCalledTimes(3);
    expect(sessionRepo.purgeOlderThan).toHaveBeenNthCalledWith(1, 30, 1000);
    expect(sessionRepo.purgeOlderThan).toHaveBeenNthCalledWith(2, 30, 1000);
    expect(sessionRepo.purgeOlderThan).toHaveBeenNthCalledWith(3, 30, 500);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'session.compaction.cap_hit',
      { status: 'warning' },
    );
    expect(globalLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('per-run cap'),
      expect.any(Object),
    );
  });

  it('does not emit cap_hit when the last batch drains the table', async () => {
    sessionRepo.purgeOlderThan.mockResolvedValueOnce(1000).mockResolvedValueOnce(250);
    sessionRepo.getOldestCompactedSessionDate.mockResolvedValue(null);

    const result = await service.runCompaction(1000, 5000);

    expect(result.deletedCount).toBe(1250);
    expect(result.capHit).toBe(false);
    expect(metrics.incrementCounter).not.toHaveBeenCalledWith(
      'session.compaction.cap_hit',
      { status: 'warning' },
    );
  });

  describe('input validation', () => {
    it('rejects a zero batch size', async () => {
      await expect(service.runCompaction(0)).rejects.toThrow(
        'batchSize must be a positive integer',
      );
    });

    it('rejects a negative batch size', async () => {
      await expect(service.runCompaction(-100)).rejects.toThrow(
        'batchSize must be a positive integer',
      );
    });

    it('rejects a non-integer batch size', async () => {
      await expect(service.runCompaction(10.5)).rejects.toThrow(
        'batchSize must be a positive integer',
      );
    });

    it('rejects a zero or negative per-run cap', async () => {
      await expect(service.runCompaction(1000, 0)).rejects.toThrow(
        'maxRowsPerRun must be a positive integer',
      );
      await expect(service.runCompaction(1000, -5)).rejects.toThrow(
        'maxRowsPerRun must be a positive integer',
      );
    });
  });

  it('starts and stops correctly', () => {
    const runCompactionSpy = jest
      .spyOn(service, 'runCompaction')
      .mockResolvedValue({ deletedCount: 0, lagDays: 0, capHit: false });

    service.start(1000);
    expect(runCompactionSpy).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1000);
    expect(runCompactionSpy).toHaveBeenCalledTimes(2);

    service.stop();
    jest.advanceTimersByTime(1000);
    expect(runCompactionSpy).toHaveBeenCalledTimes(2); // no more calls
  });

  it('start() restarts cleanly when called while already running', () => {
    const runCompactionSpy = jest
      .spyOn(service, 'runCompaction')
      .mockResolvedValue({ deletedCount: 0, lagDays: 0, capHit: false });

    service.start(1000);
    service.start(2000);

    // The immediate run fires once per start; the second start clears the old
    // interval, so advancing the old cadence must not trigger extra runs.
    expect(runCompactionSpy).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1000);
    expect(runCompactionSpy).toHaveBeenCalledTimes(2);

    // The new 2000 ms cadence does fire.
    jest.advanceTimersByTime(1000);
    expect(runCompactionSpy).toHaveBeenCalledTimes(3);
  });

  it('start() logs a failed immediate run without throwing', async () => {
    const runCompactionSpy = jest
      .spyOn(service, 'runCompaction')
      .mockRejectedValue(new Error('immediate DB failure'));

    expect(() => service.start(1000)).not.toThrow();

    // Flush the microtask queue so the swallowed .catch() handler runs.
    await Promise.resolve();

    expect(globalLogger.error).toHaveBeenCalledWith(
      'Initial session compaction failed',
      expect.objectContaining({ error: expect.any(Error) }),
    );
    service.stop();
    expect(runCompactionSpy).toHaveBeenCalledTimes(1);
  });

  it('start() logs a failed scheduled run without throwing', async () => {
    // First call (immediate run) resolves; second call (scheduled run) rejects.
    jest
      .spyOn(service, 'runCompaction')
      .mockResolvedValueOnce({ deletedCount: 0, lagDays: 0, capHit: false })
      .mockRejectedValueOnce(new Error('scheduled DB failure'));

    service.start(1000);
    jest.advanceTimersByTime(1000);
    // Flush the microtask queue so the swallowed .catch() handler runs.
    await Promise.resolve();

    expect(globalLogger.error).toHaveBeenCalledWith(
      'Scheduled session compaction failed',
      expect.objectContaining({ error: expect.any(Error) }),
    );
    service.stop();
  });
});
