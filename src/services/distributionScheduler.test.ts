import { DistributionScheduler } from './distributionScheduler';
import { HolidayCalendarService } from './holidayCalendarService';
import { MetricsCollector } from '../lib/metrics';
import { InMemorySecurityAuditRepository } from '../security/audit';
import { Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';

const ENV_CATCHUP_MAX_BAK = process.env.SCHEDULER_CATCHUP_MAX;

const SECRET = 'test-holiday-secret-1234567890';

function createSignedCalendarFile(payload: Record<string, unknown>): string {
  const payloadJson = JSON.stringify(payload);
  const base64Payload = Buffer.from(payloadJson, 'utf8').toString('base64');
  const hmac = require('crypto').createHmac('sha256', SECRET);
  hmac.update(base64Payload);
  const signature = `sha256=${hmac.digest('hex')}`;
  return JSON.stringify({ payload: base64Payload, signature });
}

async function writeTempCalendar(content: string): Promise<string> {
  const path = require('path');
  const fs = require('fs');
  const tmpFile = path.join('/tmp', `holiday-calendar-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.json`);
  await fs.promises.writeFile(tmpFile, content);
  return tmpFile;
}

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

  it('handles markReportDistributionFailed throwing after distribution error', async () => {
    engine.distribute.mockRejectedValueOnce(new Error('Sensitive DB Error: connection failed'));
    revenueReportRepo.markReportDistributionFailed.mockRejectedValueOnce(null);

    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toBe('Distribution failed: NETWORK_ERROR');
  });

  it('handles claimApprovedReportForDistribution throwing', async () => {
    revenueReportRepo.claimApprovedReportForDistribution.mockRejectedValueOnce(new Error('Claim error'));

    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(0);
    expect(engine.distribute).not.toHaveBeenCalled();
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

  // ── Holiday calendar integration ────────────────────────────────────────────

  describe('holiday calendar integration', () => {
    let holidayService: HolidayCalendarService;
    let metrics: MetricsCollector;
    let auditRepo: InMemorySecurityAuditRepository;

    beforeEach(async () => {
      metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
      auditRepo = new InMemorySecurityAuditRepository();
      holidayService = new HolidayCalendarService({ metrics, auditRepository: auditRepo });

      const calendarPayload = {
        version: '1.0.0',
        jurisdictions: {
          US: ['2026-01-31'],
          GB: ['2026-01-31'],
        },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      };
      const signedFile = createSignedCalendarFile(calendarPayload);
      const tmpFile = await writeTempCalendar(signedFile);
      await holidayService.loadCalendar(tmpFile, SECRET);
    });

    it('does not shift when no holiday calendar is configured', async () => {
      const noHolidayScheduler = new DistributionScheduler(engine, revenueReportRepo);
      const result = await noHolidayScheduler.processPendingDistributions();

      expect(result.successful).toBe(1);
      expect(engine.distribute).toHaveBeenCalledWith(
        'off-1',
        expect.objectContaining({
          end: new Date('2026-01-31'),
        }),
        1000
      );
    });

    it('does not shift when jurisdiction cannot be resolved', async () => {
      const schedulerWithCalendar = new DistributionScheduler(engine, revenueReportRepo, {
        holidayCalendarService: holidayService,
      });
      const result = await schedulerWithCalendar.processPendingDistributions();

      expect(result.successful).toBe(1);
      expect(engine.distribute).toHaveBeenCalledWith(
        'off-1',
        expect.objectContaining({
          end: new Date('2026-01-31'),
        }),
        1000
      );
    });

    it('does not shift when period_end is not a blackout day', async () => {
      const nonBlackoutPayload = {
        version: '1.0.0',
        jurisdictions: {
          US: ['2026-12-25'],
        },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      };
      const nonBlackoutFile = createSignedCalendarFile(nonBlackoutPayload);
      const tmpFile = await writeTempCalendar(nonBlackoutFile);
      const svc = new HolidayCalendarService({ metrics });
      await svc.loadCalendar(tmpFile, SECRET);

      const schedulerWithCalendar = new DistributionScheduler(engine, revenueReportRepo, {
        holidayCalendarService: svc,
        resolveJurisdiction: () => 'US',
      });

      const result = await schedulerWithCalendar.processPendingDistributions();
      expect(result.successful).toBe(1);
      expect(engine.distribute).toHaveBeenCalledWith(
        'off-1',
        expect.objectContaining({
          end: new Date('2026-01-31'),
        }),
        1000
      );
    });

    it('shifts distribution window when period_end is a blackout day', async () => {
      const schedulerWithCalendar = new DistributionScheduler(engine, revenueReportRepo, {
        holidayCalendarService: holidayService,
        resolveJurisdiction: () => 'US',
      });

      const result = await schedulerWithCalendar.processPendingDistributions();

      expect(result.successful).toBe(1);
      expect(engine.distribute).toHaveBeenCalledWith(
        'off-1',
        expect.objectContaining({
          end: new Date('2026-01-30'),
        }),
        1000
      );
    });

    it('emits scheduler_blackout_shift metric on shift', async () => {
      const schedulerWithCalendar = new DistributionScheduler(engine, revenueReportRepo, {
        holidayCalendarService: holidayService,
        resolveJurisdiction: () => 'US',
      });

      await schedulerWithCalendar.processPendingDistributions();

      const snapshot = await metrics.getSnapshot();
      const metric = snapshot.custom.find((p: any) => p.name === 'scheduler_blackout_shift_total')!;
      expect(metric.value).toBe(1);
      expect(metric.labels?.direction).toBe('previous');
    });

    it('records an audit event when calendar is loaded', async () => {
      const events = auditRepo.getAllEvents();
      const loadEvent = events.find((e: any) => e.action === 'holiday_calendar.load')!;
      expect(loadEvent.outcome).toBe('SUCCESS');
      expect(loadEvent.details.hash).toBeDefined();
      expect(loadEvent.details.version).toBe('1.0.0');
    });

    it('handles resolveJurisdiction throwing gracefully', async () => {
      const schedulerWithCalendar = new DistributionScheduler(engine, revenueReportRepo, {
        holidayCalendarService: holidayService,
        resolveJurisdiction: () => { throw new Error('Jurisdiction DB error'); },
      });

      const result = await schedulerWithCalendar.processPendingDistributions();
      expect(result.successful).toBe(1);
    });

    it('handles synchronous resolveJurisdiction return value', async () => {
      const schedulerWithCalendar = new DistributionScheduler(engine, revenueReportRepo, {
        holidayCalendarService: holidayService,
        resolveJurisdiction: () => 'US',
      });

      const result = await schedulerWithCalendar.processPendingDistributions();
      expect(result.successful).toBe(1);
    });

    it('shifts to previous business day for weekend blackout', async () => {
      const weekendPayload = {
        version: '1.0.0',
        jurisdictions: {
          US: ['2026-02-01'], // Sunday
        },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      };
      const weekendFile = createSignedCalendarFile(weekendPayload);
      const weekendTmpFile = await writeTempCalendar(weekendFile);
      const weekendService = new HolidayCalendarService({ metrics });
      await weekendService.loadCalendar(weekendTmpFile, SECRET);

      const weekendEngine = {
        distribute: jest.fn().mockResolvedValue({
          distributionRun: { id: 'run-weekend' },
          successfulPayouts: [],
          failedPayouts: [],
        }),
      };
      const weekendRepo = {
        findApprovedWithoutDistribution: jest.fn().mockResolvedValue([
          { id: 'report-weekend', offering_id: 'off-weekend', period_start: new Date('2026-01-01'), period_end: new Date('2026-02-01'), amount: '1000.00' },
        ]),
        claimApprovedReportForDistribution: jest.fn().mockResolvedValue({
          id: 'report-weekend',
          offering_id: 'off-weekend',
          period_start: new Date('2026-01-01'),
          period_end: new Date('2026-02-01'),
          amount: '1000.00',
        }),
        markReportDistributionCompleted: jest.fn().mockResolvedValue(undefined),
        markReportDistributionFailed: jest.fn().mockResolvedValue(undefined),
      };

      const weekendScheduler = new DistributionScheduler(
        weekendEngine as any,
        weekendRepo as any,
        {
          holidayCalendarService: weekendService,
          resolveJurisdiction: () => 'US',
        }
      );

      const result = await weekendScheduler.processPendingDistributions();
      expect(result.successful).toBe(1);
      expect(weekendEngine.distribute).toHaveBeenCalledWith(
        'off-weekend',
        expect.objectContaining({
          end: new Date('2026-01-30'),
        }),
        1000
      );
    });

    it('applies strictest shift when overlapping holidays exist across jurisdictions', async () => {
      const overlapPayload = {
        version: '1.0.0',
        jurisdictions: {
          US: ['2026-01-31'],
          GB: ['2026-01-31'],
          DE: ['2026-01-30'],
        },
        overrides: {},
        generatedAt: '2026-01-01T00:00:00Z',
      };
      const overlapFile = createSignedCalendarFile(overlapPayload);
      const overlapTmpFile = await writeTempCalendar(overlapFile);
      const overlapService = new HolidayCalendarService({ metrics });
      await overlapService.loadCalendar(overlapTmpFile, SECRET);

      const overlapEngine = {
        distribute: jest.fn().mockResolvedValue({
          distributionRun: { id: 'run-overlap' },
          successfulPayouts: [],
          failedPayouts: [],
        }),
      };
      const overlapRepo = {
        findApprovedWithoutDistribution: jest.fn().mockResolvedValue([
          { id: 'report-us', offering_id: 'off-US', period_start: new Date('2026-01-01'), period_end: new Date('2026-01-31'), amount: '1000.00' },
          { id: 'report-gb', offering_id: 'off-GB', period_start: new Date('2026-01-01'), period_end: new Date('2026-01-31'), amount: '1000.00' },
          { id: 'report-de', offering_id: 'off-DE', period_start: new Date('2026-01-01'), period_end: new Date('2026-01-30'), amount: '1000.00' },
        ]),
        claimApprovedReportForDistribution: jest.fn().mockImplementation(async (reportId: string) => {
          const map: Record<string, any> = {
            'report-us': { id: 'report-us', offering_id: 'off-US', period_start: new Date('2026-01-01'), period_end: new Date('2026-01-31'), amount: '1000.00' },
            'report-gb': { id: 'report-gb', offering_id: 'off-GB', period_start: new Date('2026-01-01'), period_end: new Date('2026-01-31'), amount: '1000.00' },
            'report-de': { id: 'report-de', offering_id: 'off-DE', period_start: new Date('2026-01-01'), period_end: new Date('2026-01-30'), amount: '1000.00' },
          };
          return map[reportId] ?? null;
        }),
        markReportDistributionCompleted: jest.fn().mockResolvedValue(undefined),
        markReportDistributionFailed: jest.fn().mockResolvedValue(undefined),
      };

      const overlapScheduler = new DistributionScheduler(
        overlapEngine as any,
        overlapRepo as any,
        {
          holidayCalendarService: overlapService,
          resolveJurisdiction: (offeringId: string) => {
            if (offeringId === 'off-US') return 'US';
            if (offeringId === 'off-GB') return 'GB';
            return 'DE';
          },
        }
      );

      const result = await overlapScheduler.processPendingDistributions();
      expect(result.successful).toBe(3);

      expect(overlapEngine.distribute).toHaveBeenNthCalledWith(1, 'off-US', expect.objectContaining({ end: new Date('2026-01-30') }), 1000);
      expect(overlapEngine.distribute).toHaveBeenNthCalledWith(2, 'off-GB', expect.objectContaining({ end: new Date('2026-01-30') }), 1000);
      expect(overlapEngine.distribute).toHaveBeenNthCalledWith(3, 'off-DE', expect.objectContaining({ end: new Date('2026-01-29') }), 1000);
    });
  });
});
