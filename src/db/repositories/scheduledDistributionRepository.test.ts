import { Pool } from 'pg';
import { ScheduledDistributionRepository } from './scheduledDistributionRepository';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sched-1',
    offering_id: 'off-1',
    period_id: 'period-1',
    period_start: new Date('2026-06-01T00:00:00Z'),
    period_end: new Date('2026-07-01T00:00:00Z'),
    total_amount: '1000.00',
    run_at: new Date('2026-08-01T00:00:00Z'),
    status: 'scheduled',
    attempts: 0,
    error_message: null,
    created_by: 'admin-1',
    executed_at: null,
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
    ...overrides,
  };
}

function makeDb(query: jest.Mock) {
  return { query } as unknown as Pool;
}

describe('ScheduledDistributionRepository', () => {
  it('creates a scheduled distribution and maps the inserted row', async () => {
    const row = makeRow();
    const db = makeDb(jest.fn().mockResolvedValue({ rows: [row] }));
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.create({
      offering_id: 'off-1',
      period_id: 'period-1',
      period_start: new Date('2026-06-01T00:00:00Z'),
      period_end: new Date('2026-07-01T00:00:00Z'),
      total_amount: 1000,
      run_at: new Date('2026-08-01T00:00:00Z'),
      created_by: 'admin-1',
    });

    expect(result.id).toBe('sched-1');
    expect(result.offering_id).toBe('off-1');
    expect(result.status).toBe('scheduled');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('maps a unique-violation to a structured 409 conflict', async () => {
    const db = makeDb(
      jest.fn().mockRejectedValue({ code: '23505', message: 'duplicate key' }),
    );
    const repo = new ScheduledDistributionRepository(db);

    await expect(
      repo.create({
        offering_id: 'off-1',
        period_id: 'period-1',
        total_amount: '1000.00',
        run_at: new Date('2026-08-01T00:00:00Z'),
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
    });
  });

  it('re-throws non-unique database errors unchanged', async () => {
    const db = makeDb(jest.fn().mockRejectedValue(new Error('db down')));
    const repo = new ScheduledDistributionRepository(db);

    await expect(
      repo.create({
        offering_id: 'off-1',
        period_id: 'period-1',
        total_amount: '1000.00',
        run_at: new Date('2026-08-01T00:00:00Z'),
      }),
    ).rejects.toThrow('db down');
  });

  it('finds due scheduled distributions with the lease window and limit', async () => {
    const rows = [makeRow(), makeRow({ id: 'sched-2', status: 'processing' })];
    const query = jest.fn().mockResolvedValue({ rows });
    const db = makeDb(query);
    const repo = new ScheduledDistributionRepository(db);

    const now = new Date('2026-08-01T00:00:00Z');
    const result = await repo.findDueScheduledDistributions(now, 900000, 50);

    expect(result).toHaveLength(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('run_at <= $1'), [
      now,
      900000,
      50,
    ]);
  });

  it('returns an empty list when no rows are due', async () => {
    const db = makeDb(jest.fn().mockResolvedValue({ rows: [] }));
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.findDueScheduledDistributions(new Date(), 900000, 50);
    expect(result).toEqual([]);
  });

  it('claims a scheduled row atomically and increments attempts', async () => {
    const query = jest
      .fn()
      .mockResolvedValue({ rows: [makeRow({ status: 'processing', attempts: 1 })] });
    const db = makeDb(query);
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.claimScheduledDistribution('sched-1', 900000);

    expect(result).not.toBeNull();
    expect(result!.status).toBe('processing');
    expect(result!.attempts).toBe(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('attempts = attempts + 1'), [
      'sched-1',
      900000,
    ]);
  });

  it('returns null when a row cannot be claimed', async () => {
    const db = makeDb(jest.fn().mockResolvedValue({ rows: [] }));
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.claimScheduledDistribution('sched-1', 900000);
    expect(result).toBeNull();
  });

  it('marks a row completed with an executed timestamp', async () => {
    const db = makeDb(
      jest.fn().mockResolvedValue({
        rows: [makeRow({ status: 'completed', executed_at: new Date() })],
      }),
    );
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.markCompleted('sched-1');
    expect(result!.status).toBe('completed');
    expect(result!.executed_at).toBeInstanceOf(Date);
  });

  it('returns null when marking a missing row completed', async () => {
    const db = makeDb(jest.fn().mockResolvedValue({ rows: [] }));
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.markCompleted('missing');
    expect(result).toBeNull();
  });

  it('returns null when marking a missing row failed', async () => {
    const db = makeDb(jest.fn().mockResolvedValue({ rows: [] }));
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.markFailed('missing', 'Distribution failed: RPC_ERROR');
    expect(result).toBeNull();
  });

  it('marks a row failed with a sanitized error message', async () => {
    const db = makeDb(
      jest.fn().mockResolvedValue({
        rows: [makeRow({ status: 'failed', error_message: 'Distribution failed: RPC_ERROR' })],
      }),
    );
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.markFailed('sched-1', 'Distribution failed: RPC_ERROR');
    expect(result!.status).toBe('failed');
    expect(result!.error_message).toBe('Distribution failed: RPC_ERROR');
  });

  it('cancels a row still in scheduled status', async () => {
    const db = makeDb(
      jest.fn().mockResolvedValue({ rows: [makeRow({ status: 'cancelled' })] }),
    );
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.markCancelled('sched-1');
    expect(result!.status).toBe('cancelled');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'scheduled'"),
      ['sched-1'],
    );
  });

  it('returns null when cancelling a non-scheduled row', async () => {
    const db = makeDb(jest.fn().mockResolvedValue({ rows: [] }));
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.markCancelled('sched-1');
    expect(result).toBeNull();
  });

  it('finds a row by id', async () => {
    const db = makeDb(jest.fn().mockResolvedValue({ rows: [makeRow()] }));
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.findById('sched-1');
    expect(result!.id).toBe('sched-1');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1'), [
      'sched-1',
    ]);
  });

  it('returns null when findById matches nothing', async () => {
    const db = makeDb(jest.fn().mockResolvedValue({ rows: [] }));
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.findById('missing');
    expect(result).toBeNull();
  });

  it('lists rows for an offering ordered by run_at', async () => {
    const db = makeDb(jest.fn().mockResolvedValue({ rows: [makeRow()] }));
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.findByOffering('off-1');
    expect(result).toHaveLength(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('WHERE offering_id = $1'), [
      'off-1',
    ]);
  });

  it('lists all rows with limit and offset', async () => {
    const db = makeDb(jest.fn().mockResolvedValue({ rows: [makeRow()] }));
    const repo = new ScheduledDistributionRepository(db);

    const result = await repo.findAll(25, 5);
    expect(result).toHaveLength(1);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $1 OFFSET $2'), [
      25,
      5,
    ]);
  });
});
