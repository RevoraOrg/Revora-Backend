import { AuditIntegrityScheduler, createAuditIntegrityScheduler } from './auditIntegrityScheduler';
import * as auditHashChain from './auditHashChain';

describe('AuditIntegrityScheduler', () => {
  const validResult: auditHashChain.AuditIntegrityResult = {
    valid: true,
    totalRows: 3,
    verifiedRows: 3,
    durationMs: 12,
    headHash: 'abc123',
  };

  const invalidResult: auditHashChain.AuditIntegrityResult = {
    valid: false,
    totalRows: 3,
    verifiedRows: 1,
    durationMs: 8,
    headHash: null,
    failure: {
      type: 'hash_mismatch',
      rowId: 'row-2',
      index: 1,
      message: 'Tampered row detected',
    },
  };

  let pool: { query: jest.Mock };
  let metrics: {
    setGauge: jest.Mock;
    recordHistogram: jest.Mock;
    incrementCounter: jest.Mock;
  };
  let logger: {
    info: jest.Mock;
    warn: jest.Mock;
    error: jest.Mock;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    pool = { query: jest.fn() };
    metrics = {
      setGauge: jest.fn(),
      recordHistogram: jest.fn(),
      incrementCounter: jest.fn(),
    };
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    jest.spyOn(auditHashChain, 'verifyAuditLogIntegrity').mockResolvedValue(validResult);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('runs verification on start when runOnStart is enabled', async () => {
    const scheduler = new AuditIntegrityScheduler(pool, {
      runOnStart: true,
      logger: logger as any,
      metrics: metrics as any,
    });

    scheduler.start();
    await Promise.resolve();

    expect(auditHashChain.verifyAuditLogIntegrity).toHaveBeenCalledWith(pool);
    expect(metrics.setGauge).toHaveBeenCalledWith('audit_integrity_valid', 1, undefined, expect.any(String));
    expect(metrics.incrementCounter).toHaveBeenCalledWith('audit_integrity_success_total');
    scheduler.stop();
  });

  it('records failure metrics and raises alarm on tamper detection', async () => {
    jest.spyOn(auditHashChain, 'verifyAuditLogIntegrity').mockResolvedValue(invalidResult);

    const scheduler = new AuditIntegrityScheduler(pool, {
      logger: logger as any,
      metrics: metrics as any,
    });

    const result = await scheduler.runVerification();

    expect(result.valid).toBe(false);
    expect(metrics.setGauge).toHaveBeenCalledWith('audit_integrity_valid', 0, undefined, expect.any(String));
    expect(metrics.incrementCounter).toHaveBeenCalledWith('audit_integrity_failures_total', {
      failure_type: 'hash_mismatch',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'ALARM: Audit log integrity verification failed',
      expect.objectContaining({
        alarm: 'audit_log_integrity_failure',
        severity: 'critical',
      }),
    );
  });

  it('runs verification on interval', async () => {
    const scheduler = new AuditIntegrityScheduler(pool, {
      intervalMs: 60_000,
      logger: logger as any,
      metrics: metrics as any,
    });

    scheduler.start();
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();

    expect(auditHashChain.verifyAuditLogIntegrity).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('records runtime errors and rethrows', async () => {
    jest.spyOn(auditHashChain, 'verifyAuditLogIntegrity').mockRejectedValue(new Error('db down'));

    const scheduler = new AuditIntegrityScheduler(pool, {
      logger: logger as any,
      metrics: metrics as any,
    });

    await expect(scheduler.runVerification()).rejects.toThrow('db down');
    expect(metrics.incrementCounter).toHaveBeenCalledWith('audit_integrity_verification_errors_total');
    expect(metrics.setGauge).toHaveBeenCalledWith('audit_integrity_valid', 0);
    expect(logger.error).toHaveBeenCalled();
  });

  it('skips overlapping verification runs', async () => {
    let resolveVerification: (value: auditHashChain.AuditIntegrityResult) => void = () => {};
    jest.spyOn(auditHashChain, 'verifyAuditLogIntegrity').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveVerification = resolve;
        }),
    );

    const scheduler = new AuditIntegrityScheduler(pool, {
      logger: logger as any,
      metrics: metrics as any,
    });

    const first = scheduler.runVerification();
    const second = await scheduler.runVerification();

    expect(second.valid).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'Audit integrity verification already in progress',
      expect.any(Object),
    );

    resolveVerification(validResult);
    await first;
  });

  it('creates scheduler via factory', () => {
    const scheduler = createAuditIntegrityScheduler(pool);
    expect(scheduler).toBeInstanceOf(AuditIntegrityScheduler);
  });
});
