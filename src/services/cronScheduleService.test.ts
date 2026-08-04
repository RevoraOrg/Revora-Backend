import { CronScheduleService } from './cronScheduleService';
import { Errors } from '../lib/errors';

describe('CronScheduleService', () => {
  const offering = {
    id: 'off-1',
    cron_expression: '0 3 * * 2',
    distribution_timezone: 'UTC',
  };

  function makeService(overrides: {
    listWithCronSchedules?: jest.Mock;
    updateCronSchedule?: jest.Mock;
    query?: jest.Mock;
  } = {}) {
    const offeringRepo = {
      listWithCronSchedules: overrides.listWithCronSchedules ?? jest.fn().mockResolvedValue([]),
      updateCronSchedule:
        overrides.updateCronSchedule ?? jest.fn().mockResolvedValue(offering),
    };
    const pool = {
      query: overrides.query ?? jest.fn().mockResolvedValue({ rows: [] }),
    };
    return {
      service: new CronScheduleService(offeringRepo as any, pool as any),
      offeringRepo,
      pool,
    };
  }

  it('persists a valid schedule to offerings and distribution_schedules', async () => {
    const { service, offeringRepo, pool } = makeService();
    const result = await service.persistSchedule({
      offeringId: 'off-1',
      expression: '0 3 * * 2',
      timezone: 'UTC',
    });

    expect(result.validation.valid).toBe(true);
    expect(offeringRepo.updateCronSchedule).toHaveBeenCalledWith('off-1', '0 3 * * 2', 'UTC');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO distribution_schedules'),
      ['off-1', '0 3 * * 2', 'UTC']
    );
  });

  it('rejects overlapping Stellar maintenance before persistence', async () => {
    const { service, offeringRepo } = makeService();
    await expect(
      service.persistSchedule({
        offeringId: 'off-1',
        expression: '0 6 * * 0', // Sunday 06:00 UTC maintenance
        timezone: 'UTC',
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(offeringRepo.updateCronSchedule).not.toHaveBeenCalled();
  });

  it('rejects overlap with an existing offering window', async () => {
    const { service, offeringRepo } = makeService({
      listWithCronSchedules: jest.fn().mockResolvedValue([
        { id: 'off-other', cron_expression: '0 3 * * 2', distribution_timezone: 'UTC' },
      ]),
    });

    await expect(
      service.persistSchedule({
        offeringId: 'off-1',
        expression: '0 3 * * 2',
        timezone: 'UTC',
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(offeringRepo.updateCronSchedule).not.toHaveBeenCalled();
  });

  it('clears schedule from both stores', async () => {
    const { service, offeringRepo, pool } = makeService();
    await service.clearSchedule('off-1');
    expect(offeringRepo.updateCronSchedule).toHaveBeenCalledWith('off-1', null, 'UTC');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM distribution_schedules'),
      ['off-1']
    );
  });
});
