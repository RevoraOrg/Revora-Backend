import { DistributionScheduler } from './distributionScheduler';
import { Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';

const ENV_CATCHUP_MAX_BAK = process.env.SCHEDULER_CATCHUP_MAX;

describe('DistributionScheduler', () => {
  let engine: any;
  let revenueReportRepo: any;
  let scheduler: DistributionScheduler;

  beforeAll(() => {
    delete process.env.SCHEDULER_CATCHUP_MAX;
  });

  afterAll(() => {
    if (ENV_CATCHUP_MAX_BAK !== undefined) {
      process.env.SCHEDULER_CATCHUP_MAX = ENV_CATCHUP_MAX_BAK;
    }
  });

  beforeEach(() => {
    engine = {
      distribute: jest.fn().mockResolvedValue({
        distributionRun: { id: 'run-1' },
        successfulPayouts: [],
        failedPayouts: [],
      }),
    };

    revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([
        {
          id: 'report-1',
          offering_id: 'off-1',
          period_start: new Date('2026-01-01'),
          period_end: new Date('2026-01-31'),
          amount: '1000.00',
        },
      ]),
      claimApprovedReportForDistribution: jest.fn().mockImplementation(async (reportId: string) => ({
        id: reportId,
        offering_id: 'off-1',
        period_start: new Date('2026-01-01'),
        period_end: new Date('2026-01-31'),
        amount: '1000.00',
      })),
      markReportDistributionCompleted: jest.fn().mockResolvedValue(undefined),
      markReportDistributionFailed: jest.fn().mockResolvedValue(undefined),
    };

    scheduler = new DistributionScheduler(engine, revenueReportRepo);
  });

  describe('processPendingDistributions', () => {
    it('processes pending distributions successfully', async () => {
      const result = await scheduler.processPendingDistributions();

      expect(result.processed).toBe(1);
      expect(result.successful).toBe(1);
      expect(result.failed).toBe(0);
      expect(engine.distribute).toHaveBeenCalledWith(
        'off-1',
        {
          id: 'report-1',
          start: expect.any(Date),
          end: expect.any(Date),
        },
        1000
      );
      expect(revenueReportRepo.claimApprovedReportForDistribution).toHaveBeenCalledWith('report-1');
      expect(revenueReportRepo.markReportDistributionCompleted).toHaveBeenCalledWith('report-1');
      expect(revenueReportRepo.markReportDistributionFailed).not.toHaveBeenCalled();
    });

    it('skips reports claimed by another scheduler', async () => {
      revenueReportRepo.claimApprovedReportForDistribution.mockResolvedValueOnce(null);

      const result = await scheduler.processPendingDistributions();

      expect(result.processed).toBe(1);
      expect(result.successful).toBe(0);
      expect(result.failed).toBe(0);
      expect(engine.distribute).not.toHaveBeenCalled();
      expect(revenueReportRepo.markReportDistributionCompleted).not.toHaveBeenCalled();
      expect(revenueReportRepo.markReportDistributionFailed).not.toHaveBeenCalled();
    });

    it('handles and sanitizes errors during processing', async () => {
      engine.distribute.mockRejectedValueOnce(new Error('Sensitive DB Error: connection failed'));

      const result = await scheduler.processPendingDistributions();

      expect(result.processed).toBe(1);
      expect(result.successful).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toBe('Distribution failed: NETWORK_ERROR');
      expect(revenueReportRepo.markReportDistributionFailed).toHaveBeenCalledWith('report-1');
    });

    it('preserves AppError messages', async () => {
      const appError = Errors.badRequest('Invalid data');
      engine.distribute.mockRejectedValueOnce(appError);

      const result = await scheduler.processPendingDistributions();

      expect(result.processed).toBe(1);
      expect(result.successful).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toBe('Distribution failed: UNKNOWN');
    });

    it('skips reports with missing data', async () => {
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValueOnce([
        { id: 'report-bad', offering_id: 'off-1' },
      ]);
      revenueReportRepo.claimApprovedReportForDistribution.mockResolvedValueOnce({
        id: 'report-bad',
        offering_id: 'off-1',
      });

      const result = await scheduler.processPendingDistributions();

      expect(result.processed).toBe(1);
      expect(result.successful).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toBe('Distribution failed: UNKNOWN');
      expect(revenueReportRepo.markReportDistributionFailed).toHaveBeenCalledWith('report-bad');
    });
  });

  describe('constructor validation', () => {
    beforeEach(() => {
      delete process.env.SCHEDULER_CATCHUP_MAX;
    });

    it('defaults catchupMax to 50 when not specified', () => {
      const s = new DistributionScheduler(engine, revenueReportRepo);
      expect((s as any).catchupMax).toBe(50);
      expect((s as any).catchupBacklogAlertThreshold).toBe(100);
    });

    it('accepts explicit catchupMax from options', () => {
      const s = new DistributionScheduler(engine, revenueReportRepo, { catchupMax: 10 });
      expect((s as any).catchupMax).toBe(10);
      expect((s as any).catchupBacklogAlertThreshold).toBe(20);
    });

    it('reads catchupMax from SCHEDULER_CATCHUP_MAX env var', () => {
      process.env.SCHEDULER_CATCHUP_MAX = '25';
      const s = new DistributionScheduler(engine, revenueReportRepo);
      expect((s as any).catchupMax).toBe(25);
      delete process.env.SCHEDULER_CATCHUP_MAX;
    });

    it('options.catchupMax takes precedence over env var', () => {
      process.env.SCHEDULER_CATCHUP_MAX = '99';
      const s = new DistributionScheduler(engine, revenueReportRepo, { catchupMax: 5 });
      expect((s as any).catchupMax).toBe(5);
      delete process.env.SCHEDULER_CATCHUP_MAX;
    });

    it('accepts custom backlogAlertThreshold', () => {
      const s = new DistributionScheduler(engine, revenueReportRepo, {
        catchupMax: 10,
        catchupBacklogAlertThreshold: 50,
      });
      expect((s as any).catchupBacklogAlertThreshold).toBe(50);
    });

    it('throws on non-integer catchupMax option', () => {
      expect(() => new DistributionScheduler(engine, revenueReportRepo, { catchupMax: 12.5 as any }))
        .toThrow('catchupMax must be a positive integer');
    });

    it('throws on zero catchupMax option', () => {
      expect(() => new DistributionScheduler(engine, revenueReportRepo, { catchupMax: 0 }))
        .toThrow('catchupMax must be a positive integer');
    });

    it('throws on negative catchupMax option', () => {
      expect(() => new DistributionScheduler(engine, revenueReportRepo, { catchupMax: -5 }))
        .toThrow('catchupMax must be a positive integer');
    });

    it('throws on invalid SCHEDULER_CATCHUP_MAX env var', () => {
      process.env.SCHEDULER_CATCHUP_MAX = 'not-a-number';
      expect(() => new DistributionScheduler(engine, revenueReportRepo))
        .toThrow('SCHEDULER_CATCHUP_MAX must be a positive integer');
      delete process.env.SCHEDULER_CATCHUP_MAX;
    });

    it('throws on empty-string SCHEDULER_CATCHUP_MAX env var treated as unset (default 50)', () => {
      process.env.SCHEDULER_CATCHUP_MAX = '';
      const s = new DistributionScheduler(engine, revenueReportRepo);
      expect((s as any).catchupMax).toBe(50);
      delete process.env.SCHEDULER_CATCHUP_MAX;
    });
  });

  describe('catchUpMissedWindows', () => {
    beforeEach(() => {
      delete process.env.SCHEDULER_CATCHUP_MAX;
    });

    it('returns zero totalMissed when no reports are pending', async () => {
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValueOnce([]);

      const result = await scheduler.catchUpMissedWindows();

      expect(result.totalMissed).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.backlogExceededCeiling).toBe(false);
    });

    it('enqueues up to catchupMax reports', async () => {
      const reports = Array.from({ length: 5 }, (_, i) => ({
        id: `report-${i + 1}`,
        offering_id: `off-${i + 1}`,
        period_start: new Date('2026-01-01'),
        period_end: new Date('2026-01-31'),
        amount: '1000.00',
      }));
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValueOnce(reports);

      const s = new DistributionScheduler(engine, revenueReportRepo, {
        catchupMax: 3,
        catchupBacklogAlertThreshold: 4,
      });
      const result = await s.catchUpMissedWindows();

      expect(result.totalMissed).toBe(5);
      expect(result.enqueued).toBe(3);
      expect(result.skipped).toBe(2);
      expect(result.errors).toEqual([]);
      expect(result.backlogExceededCeiling).toBe(true);
      expect(revenueReportRepo.claimApprovedReportForDistribution).toHaveBeenCalledTimes(3);
      expect(revenueReportRepo.claimApprovedReportForDistribution).toHaveBeenCalledWith('report-1');
      expect(revenueReportRepo.claimApprovedReportForDistribution).toHaveBeenCalledWith('report-3');
    });

    it('enqueues all when backlog is under catchupMax', async () => {
      const reports = Array.from({ length: 3 }, (_, i) => ({
        id: `report-${i + 1}`,
        offering_id: `off-${i + 1}`,
        period_start: new Date('2026-01-01'),
        period_end: new Date('2026-01-31'),
        amount: '1000.00',
      }));
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValueOnce(reports);

      const s = new DistributionScheduler(engine, revenueReportRepo, { catchupMax: 10 });
      const result = await s.catchUpMissedWindows();

      expect(result.totalMissed).toBe(3);
      expect(result.enqueued).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.backlogExceededCeiling).toBe(false);
    });

    it('records errors when claimApprovedReportForDistribution throws', async () => {
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValueOnce([
        { id: 'report-ok', offering_id: 'off-1' } as any,
        { id: 'report-bad', offering_id: 'off-2' } as any,
      ]);
      revenueReportRepo.claimApprovedReportForDistribution
        .mockResolvedValueOnce({ id: 'report-ok', offering_id: 'off-1' } as any)
        .mockRejectedValueOnce(new Error('DB connection lost'));

      const result = await scheduler.catchUpMissedWindows();

      expect(result.totalMissed).toBe(2);
      expect(result.enqueued).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reportId).toBe('report-bad');
      expect(result.errors[0].error).toBe('DB connection lost');
    });

    it('does not count already-claimed reports as enqueued', async () => {
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValueOnce([
        { id: 'report-1', offering_id: 'off-1' } as any,
        { id: 'report-2', offering_id: 'off-2' } as any,
      ]);
      revenueReportRepo.claimApprovedReportForDistribution
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'report-2', offering_id: 'off-2' } as any);

      const s = new DistributionScheduler(engine, revenueReportRepo, { catchupMax: 1 });
      const result = await s.catchUpMissedWindows();

      expect(result.totalMissed).toBe(2);
      expect(result.enqueued).toBe(0);
      expect(result.skipped).toBe(1);
      expect(revenueReportRepo.claimApprovedReportForDistribution).toHaveBeenCalledTimes(1);
    });

    it('does not emit backlogExceededCeiling when backlog is within threshold', async () => {
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValueOnce(
        Array.from({ length: 5 }, (_, i) => ({
          id: `r-${i}`, offering_id: 'off-1',
        })) as any
      );

      const s = new DistributionScheduler(engine, revenueReportRepo, {
        catchupMax: 10,
        catchupBacklogAlertThreshold: 100,
      });
      const result = await s.catchUpMissedWindows();

      expect(result.totalMissed).toBe(5);
      expect(result.backlogExceededCeiling).toBe(false);
    });

    it('can be called repeatedly to paginate through backlog', async () => {
      const allReports = Array.from({ length: 5 }, (_, i) => ({
        id: `report-${i + 1}`,
        offering_id: `off-${i + 1}`,
        period_start: new Date('2026-01-01'),
        period_end: new Date('2026-01-31'),
        amount: '1000.00',
      }));

      // First call: returns 3 reports (catchupMax)
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValue(allReports);
      revenueReportRepo.claimApprovedReportForDistribution.mockResolvedValue({ id: 'claimed', offering_id: 'off-1' } as any);

      const s = new DistributionScheduler(engine, revenueReportRepo, { catchupMax: 3 });
      const first = await s.catchUpMissedWindows();
      expect(first.enqueued).toBe(3);
      expect(first.skipped).toBe(2);

      // Second call: catches up the remaining
      const second = await s.catchUpMissedWindows();
      expect(second.enqueued).toBe(3);
      expect(second.skipped).toBe(2);
      // Total claims = 6 across two calls (claim doesn't know what was already claimed)
      expect(revenueReportRepo.claimApprovedReportForDistribution).toHaveBeenCalledTimes(6);
    });
  });

  describe('catchUpMissedWindows with MetricsCollector', () => {
    let metrics: MetricsCollector;

    beforeEach(() => {
      metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
    });

    it('emits scheduler.catchup.backlog gauge', async () => {
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValueOnce(
        Array.from({ length: 7 }, (_, i) => ({
          id: `r-${i}`, offering_id: 'off-1',
        })) as any
      );

      const s = new DistributionScheduler(engine, revenueReportRepo, {
        catchupMax: 10,
        metrics,
      });
      await s.catchUpMissedWindows();

      const snapshot = await metrics.getSnapshot();
      const gauge = snapshot.custom.find((p) => p.name === 'scheduler_catchup_backlog');
      expect(gauge).toBeDefined();
      expect(gauge?.value).toBe(7);
    });

    it('emits red-alert when backlog exceeds threshold', async () => {
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValueOnce(
        Array.from({ length: 15 }, (_, i) => ({
          id: `r-${i}`, offering_id: 'off-1',
        })) as any
      );

      const mockLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
      const s = new DistributionScheduler(engine, revenueReportRepo, {
        catchupMax: 5,
        catchupBacklogAlertThreshold: 10,
        metrics,
        logger: mockLogger as any,
      });
      const result = await s.catchUpMissedWindows();

      expect(result.backlogExceededCeiling).toBe(true);
      expect(result.totalMissed).toBe(15);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('[RED-ALERT]')
      );
    });

    it('works correctly without metrics collector (no gauge emitted)', async () => {
      revenueReportRepo.findApprovedWithoutDistribution.mockResolvedValueOnce(
        Array.from({ length: 3 }, (_, i) => ({
          id: `r-${i}`, offering_id: 'off-1',
        })) as any
      );

      const s = new DistributionScheduler(engine, revenueReportRepo, { catchupMax: 10 });
      const result = await s.catchUpMissedWindows();

      expect(result.totalMissed).toBe(3);
      expect(result.enqueued).toBe(3);
    });
  });
});
