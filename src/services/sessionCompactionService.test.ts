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
  });
  
  afterEach(() => {
    service.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('deletes sessions in batches and vacuums', async () => {
    // Return 1000 for the first call, 500 for the second (meaning it's done)
    sessionRepo.purgeOlderThan
      .mockResolvedValueOnce(1000)
      .mockResolvedValueOnce(500);
      
    sessionRepo.getOldestCompactedSessionDate.mockResolvedValue(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000));
    
    const result = await service.runCompaction(1000);
    
    expect(result.deletedCount).toBe(1500);
    expect(sessionRepo.purgeOlderThan).toHaveBeenCalledTimes(2);
    expect(sessionRepo.vacuumSessions).toHaveBeenCalledTimes(1);
    expect(metrics.incrementCounter).toHaveBeenCalledWith('session.compaction.rows', { status: 'success' }, 1500);
    // 40 days - 30 days = 10 days lag
    expect(metrics.recordHistogram).toHaveBeenCalledWith('session.compaction.retention_lag_days', 10, { status: 'success' });
  });

  it('does not vacuum if nothing was deleted', async () => {
    sessionRepo.purgeOlderThan.mockResolvedValue(0);
    sessionRepo.getOldestCompactedSessionDate.mockResolvedValue(null);
    
    const result = await service.runCompaction(1000);
    
    expect(result.deletedCount).toBe(0);
    expect(sessionRepo.purgeOlderThan).toHaveBeenCalledTimes(1);
    expect(sessionRepo.vacuumSessions).not.toHaveBeenCalled();
    expect(metrics.recordHistogram).toHaveBeenCalledWith('session.compaction.retention_lag_days', 0, { status: 'success' });
  });

  it('records error metrics if compaction fails', async () => {
    sessionRepo.purgeOlderThan.mockRejectedValue(new Error('DB failure'));
    
    await expect(service.runCompaction(1000)).rejects.toThrow('DB failure');
    
    expect(metrics.incrementCounter).toHaveBeenCalledWith('session.compaction.errors_total', { status: 'error' });
  });

  it('starts and stops correctly', () => {
    // start calls runCompaction immediately and sets interval
    const runCompactionSpy = jest.spyOn(service, 'runCompaction').mockResolvedValue({ deletedCount: 0 });
    
    service.start(1000);
    expect(runCompactionSpy).toHaveBeenCalledTimes(1);
    
    jest.advanceTimersByTime(1000);
    expect(runCompactionSpy).toHaveBeenCalledTimes(2);
    
    service.stop();
    jest.advanceTimersByTime(1000);
    expect(runCompactionSpy).toHaveBeenCalledTimes(2); // no more calls
  });
});
