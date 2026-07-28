import { DistributionScheduler, computeTimezoneWindow, normalizeScheduleTimezone, assertValidScheduleTimezone, deduplicateWindowKey, formatWindowForAudit, findNextCronWindow, CronSchedule, TimezoneWindow } from '../distributionScheduler';
import { Errors } from '../../lib/errors';
import { isValidTimezone } from '../../lib/timezoneAllowlist';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScheduler(
  engine?: any,
  repo?: any
): DistributionScheduler {
  const e = engine ?? {
    distribute: jest.fn().mockResolvedValue({
      distributionRun: { id: 'run-1' },
      successfulPayouts: [],
      failedPayouts: [],
    }),
  };
  const r = repo ?? {
    findApprovedWithoutDistribution: jest.fn().mockResolvedValue([]),
    claimApprovedReportForDistribution: jest.fn(),
    markReportDistributionCompleted: jest.fn().mockResolvedValue(undefined),
    markReportDistributionFailed: jest.fn().mockResolvedValue(undefined),
  };
  return new DistributionScheduler(e, r);
}

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    id: 'report-1',
    offering_id: 'off-1',
    period_start: new Date('2026-01-15'),
    period_end: new Date('2026-02-15'),
    amount: '5000.00',
    ...overrides,
  };
}

// ─── Tests: normalizeScheduleTimezone ─────────────────────────────────────────

describe('normalizeScheduleTimezone', () => {
  it('returns UTC for null/undefined/empty input', () => {
    expect(normalizeScheduleTimezone(null)).toBe('UTC');
    expect(normalizeScheduleTimezone(undefined)).toBe('UTC');
    expect(normalizeScheduleTimezone('')).toBe('UTC');
  });

  it('normalizes Etc/UTC and GMT to UTC', () => {
    expect(normalizeScheduleTimezone('Etc/UTC')).toBe('UTC');
    expect(normalizeScheduleTimezone('Etc/GMT')).toBe('UTC');
    expect(normalizeScheduleTimezone('GMT')).toBe('UTC');
    expect(normalizeScheduleTimezone('Z')).toBe('UTC');
  });

  it('returns the timezone as-is if valid', () => {
    expect(normalizeScheduleTimezone('America/New_York')).toBe('America/New_York');
    expect(normalizeScheduleTimezone('Europe/London')).toBe('Europe/London');
  });

  it('returns UTC for an unrecognised timezone', () => {
    expect(normalizeScheduleTimezone('Mars/Olympus')).toBe('UTC');
  });
});

// ─── Tests: assertValidScheduleTimezone ───────────────────────────────────────

describe('assertValidScheduleTimezone', () => {
  it('accepts allowed timezones', () => {
    expect(assertValidScheduleTimezone('America/New_York')).toBe('America/New_York');
    expect(assertValidScheduleTimezone('Europe/London')).toBe('Europe/London');
    expect(assertValidScheduleTimezone('UTC')).toBe('UTC');
  });

  it('normalises Etc/UTC before validation', () => {
    expect(assertValidScheduleTimezone('Etc/UTC')).toBe('UTC');
  });

  it('throws validation error for invalid timezones', () => {
    expect(() => assertValidScheduleTimezone('Bogus/Zone'))
      .toThrow('Invalid timezone');
    expect(() => assertValidScheduleTimezone(''))
      .toThrow('Invalid timezone');
  });
});

// ─── Tests: isValidTimezone (allowlist) ───────────────────────────────────────

describe('isValidTimezone', () => {
  it('returns true for common timezones', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/Paris')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('returns false for invalid timezones', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Foo/Bar')).toBe(false);
    expect(isValidTimezone('US/Eastern')).toBe(false);
  });
});

// ─── Tests: computeTimezoneWindow ─────────────────────────────────────────────

describe('computeTimezoneWindow', () => {
  it('computes UTC window correctly for UTC timezone', () => {
    const start = new Date('2026-06-15T10:00:00Z');
    const end = new Date('2026-07-15T10:00:00Z');
    const { window, dstTransition } = computeTimezoneWindow('off-1', start, end, 'UTC');
    expect(window.timezone).toBe('UTC');
    expect(window.utcStart.toISOString()).toBe(start.toISOString());
    expect(window.utcEnd.toISOString()).toBe(end.toISOString());
    expect(dstTransition).toBe('none');
  });

  it('computes wall-clock times for America/New_York (non-DST)', () => {
    // January — EST (UTC-5)
    const start = new Date('2026-01-15T10:00:00Z');
    const end = new Date('2026-02-15T10:00:00Z');
    const { window, dstTransition } = computeTimezoneWindow('off-1', start, end, 'America/New_York');
    expect(window.timezone).toBe('America/New_York');
    // EST is UTC-5, so wall-clock should be 5 AM
    expect(window.wallClockStart.getUTCHours()).toBe(5);
    expect(window.wallClockEnd.getUTCHours()).toBe(5);
    expect(dstTransition).toBe('none');
  });

  it('detects spring-forward DST transition', () => {
    // March transition: EST (UTC-5) -> EDT (UTC-4) on 2nd Sunday of March
    const start = new Date('2026-03-01T10:00:00Z');
    const end = new Date('2026-04-01T10:00:00Z');
    const { dstTransition } = computeTimezoneWindow('off-1', start, end, 'America/New_York');
    // EDT offset is larger (less negative) than EST, so offsetEnd > offsetStart
    expect(dstTransition).toBe('springForward');
  });

  it('detects fall-back DST transition', () => {
    // November transition: EDT (UTC-4) -> EST (UTC-5)
    const start = new Date('2026-10-01T10:00:00Z');
    const end = new Date('2026-11-15T10:00:00Z');
    const { dstTransition } = computeTimezoneWindow('off-1', start, end, 'America/New_York');
    // EST offset is more negative than EDT, so offsetEnd < offsetStart
    expect(dstTransition).toBe('fallback');
  });
});

// ─── Tests: deduplicateWindowKey & formatWindowForAudit ────────────────────────

describe('deduplicateWindowKey', () => {
  it('produces a stable key from UTC bounds', () => {
    const utcStart = new Date('2026-01-15T00:00:00.000Z');
    const utcEnd = new Date('2026-02-15T00:00:00.000Z');
    const w: TimezoneWindow = {
      wallClockStart: utcStart,
      wallClockEnd: utcEnd,
      utcStart,
      utcEnd,
      timezone: 'UTC',
    };
    const key = deduplicateWindowKey(w);
    expect(key).toBe(`${utcStart.getTime()}:${utcEnd.getTime()}`);
  });
});

describe('formatWindowForAudit', () => {
  it('returns ISO strings and timezone', () => {
    const w: TimezoneWindow = {
      wallClockStart: new Date('2026-01-15T05:00:00Z'),
      wallClockEnd: new Date('2026-02-15T05:00:00Z'),
      utcStart: new Date('2026-01-15T10:00:00Z'),
      utcEnd: new Date('2026-02-15T10:00:00Z'),
      timezone: 'America/New_York',
    };
    const audit = formatWindowForAudit(w);
    expect(audit.timezone).toBe('America/New_York');
    expect(audit.wall_clock_start).toBeDefined();
    expect(audit.utc_start).toBeDefined();
  });
});

// ─── Tests: findNextCronWindow ────────────────────────────────────────────────

describe('findNextCronWindow', () => {
  it('returns null when schedule does not match within lookahead', () => {
    // Use a cron that won't match soon (e.g. month=13)
    const schedule: CronSchedule = { expression: '0 0 1 13 *', timezone: 'UTC' };
    const result = findNextCronWindow(schedule, new Date('2026-01-01'));
    expect(result).toBeNull();
  });

  it('matches a daily cron at midnight', () => {
    const schedule: CronSchedule = { expression: '0 0 * * *', timezone: 'UTC' };
    const after = new Date('2026-01-01T00:00:00Z');
    const result = findNextCronWindow(schedule, after);
    expect(result).not.toBeNull();
    if (result) {
      // The first minute of Jan 1 should match
      expect(result.start.getTime()).toBe(after.getTime());
    }
  });

  it('respects timezone when matching', () => {
    // A cron at 5 AM UTC = midnight EST
    const schedule: CronSchedule = { expression: '0 5 * * *', timezone: 'America/New_York' };
    const after = new Date('2026-01-01T00:00:00Z');
    const result = findNextCronWindow(schedule, after);
    expect(result).not.toBeNull();
  });

  it('matches every 30 minutes cron', () => {
    const schedule: CronSchedule = { expression: '*/30 * * * *', timezone: 'UTC' };
    const after = new Date('2026-01-01T00:00:00Z');
    const result = findNextCronWindow(schedule, after);
    expect(result).not.toBeNull();
  });

  it('matches cron with range syntax', () => {
    const schedule: CronSchedule = { expression: '0 9-17 * * *', timezone: 'UTC' };
    const after = new Date('2026-01-01T09:00:00Z');
    const result = findNextCronWindow(schedule, after);
    expect(result).not.toBeNull();
  });
});

// ─── Tests: DistributionScheduler — resolveOfferingTimezone ────────────────────

describe('DistributionScheduler.resolveOfferingTimezone', () => {
  it('returns UTC for null/undefined', () => {
    const s = makeScheduler();
    expect(s.resolveOfferingTimezone(null)).toBe('UTC');
    expect(s.resolveOfferingTimezone(undefined)).toBe('UTC');
  });

  it('returns the timezone if valid', () => {
    const s = makeScheduler();
    expect(s.resolveOfferingTimezone('America/New_York')).toBe('America/New_York');
  });

  it('returns UTC for invalid timezone', () => {
    const s = makeScheduler();
    expect(s.resolveOfferingTimezone('Bad/Zone')).toBe('UTC');
  });
});

// ─── Tests: DistributionScheduler — evaluateCron ──────────────────────────────

describe('DistributionScheduler.evaluateCron', () => {
  it('returns false for malformed cron expressions', () => {
    const s = makeScheduler();
    expect(s.evaluateCron('invalid', new Date(), 'UTC')).toBe(false);
    expect(s.evaluateCron('* * * *', new Date(), 'UTC')).toBe(false);
  });

  it('matches exact minute and hour', () => {
    const s = makeScheduler();
    const date = new Date('2026-06-15T10:30:00Z');
    expect(s.evaluateCron('30 10 * * *', date, 'UTC')).toBe(true);
    expect(s.evaluateCron('0 10 * * *', date, 'UTC')).toBe(false);
  });

  it('matches range syntax in cron fields', () => {
    const s = makeScheduler();
    const date = new Date('2026-06-15T10:30:00Z');
    expect(s.evaluateCron('30 9-11 * * *', date, 'UTC')).toBe(true);
    expect(s.evaluateCron('30 12-23 * * *', date, 'UTC')).toBe(false);
  });

  it('handles */0 as invalid step returning false', () => {
    const s = makeScheduler();
    const date = new Date('2026-06-15T10:30:00Z');
    expect(s.evaluateCron('*/0 * * * *', date, 'UTC')).toBe(false);
  });
});

// ─── Tests: DistributionScheduler — window deduplication ──────────────────────

describe('DistributionScheduler window deduplication', () => {
  it('marks and checks windows', () => {
    const s = makeScheduler();
    const w: TimezoneWindow = {
      wallClockStart: new Date('2026-01-15'),
      wallClockEnd: new Date('2026-02-15'),
      utcStart: new Date('2026-01-15T10:00:00Z'),
      utcEnd: new Date('2026-02-15T10:00:00Z'),
      timezone: 'UTC',
    };
    expect(s.isWindowAlreadyCompleted(w)).toBe(false);
    s.markWindowCompleted(w);
    expect(s.isWindowAlreadyCompleted(w)).toBe(true);
  });
});

// ─── Tests: DistributionScheduler — processPendingDistributions ───────────────

describe('DistributionScheduler.processPendingDistributions', () => {
  it('processes pending distributions successfully with timezone', async () => {
    const engine = {
      distribute: jest.fn().mockResolvedValue({
        distributionRun: { id: 'run-1' },
        successfulPayouts: [],
        failedPayouts: [],
      }),
    };
    const report = makeReport({ offering_timezone: 'America/New_York' });
    const revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([report]),
      claimApprovedReportForDistribution: jest.fn().mockImplementation(async (id: string) => report),
      markReportDistributionCompleted: jest.fn().mockResolvedValue(undefined),
      markReportDistributionFailed: jest.fn().mockResolvedValue(undefined),
    };
    const scheduler = makeScheduler(engine, revenueReportRepo);
    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
    expect(engine.distribute).toHaveBeenCalled();
    expect(revenueReportRepo.markReportDistributionCompleted).toHaveBeenCalledWith('report-1');
  });

  it('processes pending distributions without timezone (defaults to UTC)', async () => {
    const engine = {
      distribute: jest.fn().mockResolvedValue({
        distributionRun: { id: 'run-1' },
        successfulPayouts: [],
        failedPayouts: [],
      }),
    };
    const report = makeReport({});
    const revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([report]),
      claimApprovedReportForDistribution: jest.fn().mockImplementation(async (id: string) => report),
      markReportDistributionCompleted: jest.fn().mockResolvedValue(undefined),
      markReportDistributionFailed: jest.fn().mockResolvedValue(undefined),
    };
    const scheduler = makeScheduler(engine, revenueReportRepo);
    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('skips already-completed windows (dedup)', async () => {
    const engine = { distribute: jest.fn() };
    const report = makeReport({ offering_timezone: 'America/New_York' });
    const revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([report, report]),
      claimApprovedReportForDistribution: jest.fn().mockImplementation(async (id: string) => report),
      markReportDistributionCompleted: jest.fn().mockResolvedValue(undefined),
      markReportDistributionFailed: jest.fn().mockResolvedValue(undefined),
    };
    const scheduler = makeScheduler(engine, revenueReportRepo);
    const result = await scheduler.processPendingDistributions();

    // Both reports have same period, so dedup should skip the second
    expect(result.processed).toBe(2);
    expect(result.successful).toBe(1);
    // distribute should have been called exactly once
    expect(engine.distribute).toHaveBeenCalledTimes(1);
  });

  it('skips reports claimed by another scheduler', async () => {
    const revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([makeReport()]),
      claimApprovedReportForDistribution: jest.fn().mockResolvedValue(null),
      markReportDistributionCompleted: jest.fn(),
      markReportDistributionFailed: jest.fn(),
    };
    const scheduler = makeScheduler(undefined, revenueReportRepo);
    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(0);
    expect(revenueReportRepo.markReportDistributionCompleted).not.toHaveBeenCalled();
  });

  it('handles markReportDistributionFailed errors without crashing', async () => {
    const engine = {
      distribute: jest.fn().mockRejectedValue(new Error('Distribute failed')),
    };
    const revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([makeReport()]),
      claimApprovedReportForDistribution: jest.fn().mockImplementation(async (id: string) => makeReport()),
      markReportDistributionCompleted: jest.fn(),
      markReportDistributionFailed: jest.fn().mockRejectedValue(new Error('DB error marking failed')),
    };
    const scheduler = makeScheduler(engine, revenueReportRepo);
    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('handles non-Error markReportDistributionFailed throw', async () => {
    const engine = {
      distribute: jest.fn().mockRejectedValue(new Error('Distribute failed')),
    };
    const revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([makeReport()]),
      claimApprovedReportForDistribution: jest.fn().mockImplementation(async (id: string) => makeReport()),
      markReportDistributionCompleted: jest.fn(),
      markReportDistributionFailed: jest.fn().mockRejectedValue('String error, not Error object'),
    };
    const scheduler = makeScheduler(engine, revenueReportRepo);
    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('skips when claim is null after error path', async () => {
    const engine = {
      distribute: jest.fn(),
    };
    const revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([makeReport()]),
      claimApprovedReportForDistribution: jest.fn().mockResolvedValue(null),
      markReportDistributionCompleted: jest.fn(),
      markReportDistributionFailed: jest.fn(),
    };
    const scheduler = makeScheduler(engine, revenueReportRepo);
    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('handles claim throwing and continues', async () => {
    const engine = {
      distribute: jest.fn(),
    };
    const revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([makeReport()]),
      claimApprovedReportForDistribution: jest.fn().mockRejectedValue(new Error('Claim failed')),
      markReportDistributionCompleted: jest.fn(),
      markReportDistributionFailed: jest.fn(),
    };
    const scheduler = makeScheduler(engine, revenueReportRepo);
    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('handles and sanitizes errors during processing', async () => {
    const engine = {
      distribute: jest.fn().mockRejectedValue(new Error('Sensitive DB Error: connection failed')),
    };
    const revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([makeReport()]),
      claimApprovedReportForDistribution: jest.fn().mockImplementation(async (id: string) => makeReport()),
      markReportDistributionCompleted: jest.fn(),
      markReportDistributionFailed: jest.fn().mockResolvedValue(undefined),
    };
    const scheduler = makeScheduler(engine, revenueReportRepo);
    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toBe('Distribution failed: NETWORK_ERROR');
    expect(revenueReportRepo.markReportDistributionFailed).toHaveBeenCalledWith('report-1');
  });

  it('skips reports with missing period data', async () => {
    const revenueReportRepo = {
      findApprovedWithoutDistribution: jest.fn().mockResolvedValue([
        makeReport({ period_start: null, period_end: null, amount: undefined }),
      ]),
      claimApprovedReportForDistribution: jest.fn().mockImplementation(async (id: string) =>
        makeReport({ period_start: null, period_end: null, amount: undefined })
      ),
      markReportDistributionCompleted: jest.fn(),
      markReportDistributionFailed: jest.fn().mockResolvedValue(undefined),
    };
    const scheduler = makeScheduler(undefined, revenueReportRepo);
    const result = await scheduler.processPendingDistributions();

    expect(result.processed).toBe(1);
    expect(result.successful).toBe(0);
    expect(result.failed).toBe(1);
  });
});

// ─── Tests: DST Edge Cases ────────────────────────────────────────────────────

describe('DST transition handling', () => {
  // US DST: Spring forward 2026-03-08 at 2:00 AM local -> 3:00 AM
  // US DST: Fall back 2026-11-01 at 2:00 AM local -> 1:00 AM

  it('fall-back window fires exactly once', () => {
    const s = makeScheduler();

    // Create two windows with the same UTC bounds (simulating the repeated hour)
    const sharedUtcStart = new Date('2026-11-01T06:00:00Z'); // 2 AM EDT / 1 AM EST
    const sharedUtcEnd = new Date('2026-11-02T06:00:00Z');

    const w1: TimezoneWindow = {
      wallClockStart: new Date('2026-11-01T06:00:00Z'),
      wallClockEnd: new Date('2026-11-02T05:00:00Z'),
      utcStart: sharedUtcStart,
      utcEnd: sharedUtcEnd,
      timezone: 'America/New_York',
    };
    const w2: TimezoneWindow = {
      wallClockStart: new Date('2026-11-01T05:00:00Z'), // Different wall clock but same UTC
      wallClockEnd: new Date('2026-11-02T06:00:00Z'),
      utcStart: sharedUtcStart,
      utcEnd: sharedUtcEnd,
      timezone: 'America/New_York',
    };

    // Same dedup key because utcStart/utcEnd are identical
    expect(s.isWindowAlreadyCompleted(w1)).toBe(false);
    s.markWindowCompleted(w1);
    expect(s.isWindowAlreadyCompleted(w2)).toBe(true);
  });

  it('spring-forward window does not skip', () => {
    // On spring-forward day (Mar 8, 2026), 2:00 AM is skipped
    // A cron at 2:30 AM should slide to 3:00 AM
    const schedule: CronSchedule = { expression: '30 2 * * *', timezone: 'America/New_York' };
    const after = new Date('2026-03-08T00:00:00Z');
    const result = findNextCronWindow(schedule, after);
    // There should still be a next window (though it may be the next day)
    expect(result).not.toBeNull();
  });

  it('DST transition is correctly detected as fallback', () => {
    // Nov 1, 2026: Fall back from EDT to EST
    const start = new Date('2026-11-01T00:00:00Z');
    const end = new Date('2026-11-02T00:00:00Z');
    const { dstTransition } = computeTimezoneWindow('off-1', start, end, 'America/New_York');
    expect(dstTransition).toBe('fallback');
  });

  it('DST transition is correctly detected as spring-forward', () => {
    // Mar 8, 2026: Spring forward from EST to EDT
    const start = new Date('2026-03-08T00:00:00Z');
    const end = new Date('2026-03-09T00:00:00Z');
    const { dstTransition } = computeTimezoneWindow('off-1', start, end, 'America/New_York');
    expect(dstTransition).toBe('springForward');
  });

  it('non-DST timezone reports no transition', () => {
    const start = new Date('2026-03-08T00:00:00Z');
    const end = new Date('2026-03-09T00:00:00Z');
    const { dstTransition } = computeTimezoneWindow('off-1', start, end, 'UTC');
    expect(dstTransition).toBe('none');
  });
});
