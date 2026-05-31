import { DistributionScheduler } from './distributionScheduler';
import { Errors } from '../lib/errors';

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

  it('handles and sanitizes errors during processing', async () => {
    // Mock engine to throw a raw error
    engine.distribute.mockRejectedValueOnce(new Error('Sensitive DB Error: connection failed'));

    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toBe('Distribution failed: NETWORK_ERROR');
    expect(revenueReportRepo.markReportDistributionFailed).toHaveBeenCalledWith('report-1');
  });

  it('preserves AppError messages', async () => {
    // Mock engine to throw an AppError
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
      { id: 'report-bad', offering_id: 'off-1' }, // Missing amount and period
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
