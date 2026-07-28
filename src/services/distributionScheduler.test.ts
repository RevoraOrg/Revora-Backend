import { DistributionScheduler } from './distributionScheduler';
import { HolidayCalendarService } from './holidayCalendarService';
import { MetricsCollector } from '../lib/metrics';
import { InMemorySecurityAuditRepository } from '../security/audit';
import { Errors } from '../lib/errors';

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

    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toBe('Distribution failed: UNKNOWN');
    expect(revenueReportRepo.markReportDistributionFailed).toHaveBeenCalledWith('report-bad');
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
