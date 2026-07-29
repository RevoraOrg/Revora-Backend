/**
 * Tests for PushQuietHoursService.
 *
 * Coverage targets (≥95%):
 * - getLocalHour / isInQuietHours logic (midnight-crossing, same-day, disabled,
 *   zero-width window, invalid timezone)
 * - send(): sent outside window, deferred inside, urgent bypass + audit metric
 * - flush(): delivers due items, retains still-quiet items, returns count, gauge
 * - Bounded queue: overflow drops oldest, emits overflow metric
 * - DST: spring-forward does not double-defer
 * - Metric emission: push_deferred_count, push_urgent_bypass_total,
 *   push_deferred_queue_size, push_deferred_queue_overflow_total
 */

import {
  getLocalHour,
  isInQuietHours,
  PushQuietHoursService,
  PushPayload,
  QuietHoursConfig,
  DEFAULT_QUIET_HOURS,
  MAX_QUEUE_SIZE,
} from './pushQuietHoursService';
import { MetricsCollector } from '../lib/metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<QuietHoursConfig> = {}): QuietHoursConfig {
  return { ...DEFAULT_QUIET_HOURS, timezone: 'UTC', ...overrides };
}

function makePayload(overrides: Partial<PushPayload> = {}): PushPayload {
  return { userId: 'u1', title: 'Hello', body: 'World', ...overrides };
}

/** UTC date at a specific hour (minute=0). */
function utcAt(hour: number, date = '2024-06-15'): Date {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
}

/** Read a counter value directly from a MetricsCollector's internal map. */
function counterValue(m: MetricsCollector, name: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (m as any)['counters'].get(name) ?? 0;
}

/** Read a gauge value directly from a MetricsCollector's internal map. */
function gaugeValue(m: MetricsCollector, name: string): number | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (m as any)['gauges'].get(name);
}

// ---------------------------------------------------------------------------
// getLocalHour
// ---------------------------------------------------------------------------

describe('getLocalHour', () => {
  it('returns correct hour in UTC', () => {
    expect(getLocalHour(utcAt(14), 'UTC')).toBe(14);
    expect(getLocalHour(utcAt(0), 'UTC')).toBe(0);
    expect(getLocalHour(utcAt(23), 'UTC')).toBe(23);
  });

  it('returns correct hour in America/New_York (UTC-4 in summer / EDT)', () => {
    // 2024-06-15 18:00 UTC = 14:00 EDT
    expect(getLocalHour(new Date('2024-06-15T18:00:00Z'), 'America/New_York')).toBe(14);
  });

  it('returns correct hour in Asia/Tokyo (UTC+9)', () => {
    // 2024-06-15 20:00 UTC = 05:00 next-day JST
    expect(getLocalHour(new Date('2024-06-15T20:00:00Z'), 'Asia/Tokyo')).toBe(5);
  });

  it('throws for an invalid timezone', () => {
    expect(() => getLocalHour(utcAt(12), 'Not/AZone')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// isInQuietHours
// ---------------------------------------------------------------------------

describe('isInQuietHours', () => {
  const config = makeConfig({ startHour: 22, endHour: 8 }); // crosses midnight

  it('is true late at night (23:00)', () => {
    expect(isInQuietHours(utcAt(23), config)).toBe(true);
  });

  it('is true just after midnight (02:00)', () => {
    expect(isInQuietHours(utcAt(2), config)).toBe(true);
  });

  it('is true exactly at start hour (22:00)', () => {
    expect(isInQuietHours(utcAt(22), config)).toBe(true);
  });

  it('is false exactly at end hour (08:00, exclusive)', () => {
    expect(isInQuietHours(utcAt(8), config)).toBe(false);
  });

  it('is false during the day (14:00)', () => {
    expect(isInQuietHours(utcAt(14), config)).toBe(false);
  });

  it('handles same-day windows (09:00–17:00)', () => {
    const day = makeConfig({ startHour: 9, endHour: 17 });
    expect(isInQuietHours(utcAt(12), day)).toBe(true);
    expect(isInQuietHours(utcAt(8), day)).toBe(false);
    expect(isInQuietHours(utcAt(17), day)).toBe(false);
  });

  it('returns false when disabled', () => {
    expect(isInQuietHours(utcAt(23), makeConfig({ enabled: false }))).toBe(false);
  });

  it('returns false for a zero-width window (start === end)', () => {
    expect(isInQuietHours(utcAt(10), makeConfig({ startHour: 10, endHour: 10 }))).toBe(false);
  });

  it('respects the investor local timezone', () => {
    // 03:00 UTC = 22:00 previous-day America/New_York (EST, UTC-5 in January)
    const nyConfig = makeConfig({ timezone: 'America/New_York', startHour: 22, endHour: 8 });
    expect(isInQuietHours(new Date('2024-01-15T03:00:00Z'), nyConfig)).toBe(true);
    // 18:00 UTC = 13:00 EST → outside quiet hours
    expect(isInQuietHours(new Date('2024-01-15T18:00:00Z'), nyConfig)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PushQuietHoursService.send
// ---------------------------------------------------------------------------

describe('PushQuietHoursService.send', () => {
  let metrics: MetricsCollector;
  let svc: PushQuietHoursService;
  let delivered: PushPayload[];
  let deliver: (p: PushPayload) => Promise<void>;

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true });
    svc = new PushQuietHoursService(metrics);
    delivered = [];
    deliver = async (p) => {
      delivered.push(p);
    };
  });

  it('delivers immediately outside quiet hours', async () => {
    const result = await svc.send(makePayload(), makeConfig(), deliver, utcAt(14));
    expect(result).toBe('sent');
    expect(delivered).toHaveLength(1);
    expect(svc.queueSize).toBe(0);
  });

  it('defers a non-urgent push inside quiet hours', async () => {
    const result = await svc.send(makePayload(), makeConfig(), deliver, utcAt(23));
    expect(result).toBe('deferred');
    expect(delivered).toHaveLength(0);
    expect(svc.queueSize).toBe(1);
    expect(counterValue(metrics, 'push_deferred_count')).toBe(1);
  });

  it('bypasses quiet hours for an urgent push and emits an audit metric', async () => {
    const result = await svc.send(makePayload({ urgent: true }), makeConfig(), deliver, utcAt(23));
    expect(result).toBe('sent');
    expect(delivered).toHaveLength(1);
    expect(svc.queueSize).toBe(0);
    expect(counterValue(metrics, 'push_urgent_bypass_total')).toBe(1);
    expect(counterValue(metrics, 'push_deferred_count')).toBe(0);
  });

  it('increments push_deferred_count once per deferred push', async () => {
    await svc.send(makePayload(), makeConfig(), deliver, utcAt(23));
    await svc.send(makePayload(), makeConfig(), deliver, utcAt(2));
    expect(counterValue(metrics, 'push_deferred_count')).toBe(2);
    expect(svc.queueSize).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PushQuietHoursService.flush
// ---------------------------------------------------------------------------

describe('PushQuietHoursService.flush', () => {
  let metrics: MetricsCollector;
  let svc: PushQuietHoursService;
  let delivered: PushPayload[];
  let deliver: (p: PushPayload) => Promise<void>;

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true });
    svc = new PushQuietHoursService(metrics);
    delivered = [];
    deliver = async (p) => {
      delivered.push(p);
    };
  });

  it('delivers deferred pushes once the window ends', async () => {
    await svc.send(makePayload({ title: 'A' }), makeConfig(), deliver, utcAt(23));
    expect(svc.queueSize).toBe(1);

    const count = await svc.flush(deliver, utcAt(9)); // 09:00 — window over
    expect(count).toBe(1);
    expect(delivered.map((d) => d.title)).toEqual(['A']);
    expect(svc.queueSize).toBe(0);
    expect(gaugeValue(metrics, 'push_deferred_queue_size')).toBe(0);
  });

  it('retains pushes still inside the window', async () => {
    await svc.send(makePayload(), makeConfig(), deliver, utcAt(23));
    const count = await svc.flush(deliver, utcAt(2)); // still quiet
    expect(count).toBe(0);
    expect(svc.queueSize).toBe(1);
    expect(gaugeValue(metrics, 'push_deferred_queue_size')).toBe(1);
  });

  it('returns 0 and emits gauge when queue is empty', async () => {
    const count = await svc.flush(deliver, utcAt(9));
    expect(count).toBe(0);
    expect(gaugeValue(metrics, 'push_deferred_queue_size')).toBe(0);
  });

  it('flushes only the items whose windows have ended', async () => {
    // Send at 22:00 UTC: A (UTC) is at 22:00 → quiet; B (Tokyo +9) is at 07:00
    // → quiet. Both are queued.
    await svc.send(makePayload({ title: 'A' }), makeConfig(), deliver, utcAt(22));
    await svc.send(
      makePayload({ title: 'B' }),
      makeConfig({ timezone: 'Asia/Tokyo' }),
      deliver,
      utcAt(22),
    );
    expect(svc.queueSize).toBe(2);

    // Flush at 13:00 UTC: A (UTC 13:00) has exited its window; B (Tokyo 22:00)
    // is still inside → only A is delivered.
    const count = await svc.flush(deliver, utcAt(13));
    expect(count).toBe(1);
    expect(delivered.map((d) => d.title)).toEqual(['A']);
    expect(svc.queueSize).toBe(1);
  });

  it('uses the live clock when no time is supplied', async () => {
    // Empty queue → resolves to 0 regardless of wall-clock time.
    await expect(svc.flush(deliver)).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bounded queue
// ---------------------------------------------------------------------------

describe('PushQuietHoursService bounded queue', () => {
  it('drops the oldest entry and emits an overflow metric on overflow', async () => {
    const metrics = new MetricsCollector({ enabled: true });
    const svc = new PushQuietHoursService(metrics);
    const deliver = async () => {};
    const config = makeConfig();

    // Fill to capacity.
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      await svc.send(makePayload({ title: `msg-${i}` }), config, deliver, utcAt(23));
    }
    expect(svc.queueSize).toBe(MAX_QUEUE_SIZE);
    expect(counterValue(metrics, 'push_deferred_queue_overflow_total')).toBe(0);

    // One more triggers overflow: oldest dropped, size stays at cap.
    await svc.send(makePayload({ title: 'overflow' }), config, deliver, utcAt(23));
    expect(svc.queueSize).toBe(MAX_QUEUE_SIZE);
    expect(counterValue(metrics, 'push_deferred_queue_overflow_total')).toBe(1);

    // The dropped-oldest ('msg-0') should be gone; 'overflow' should be present.
    const delivered: PushPayload[] = [];
    await svc.flush(async (p) => {
      delivered.push(p);
    }, utcAt(9));
    const titles = delivered.map((d) => d.title);
    expect(titles).not.toContain('msg-0');
    expect(titles).toContain('overflow');
  });
});

// ---------------------------------------------------------------------------
// DST safety
// ---------------------------------------------------------------------------

describe('PushQuietHoursService DST transitions', () => {
  it('does not double-defer across a spring-forward transition', async () => {
    // US spring-forward 2024: 2024-03-10, clocks jump 02:00 → 03:00 EST→EDT.
    const config = makeConfig({ timezone: 'America/New_York', startHour: 22, endHour: 8 });
    const metrics = new MetricsCollector({ enabled: true });
    const svc = new PushQuietHoursService(metrics);
    const delivered: PushPayload[] = [];
    const deliver = async (p: PushPayload) => {
      delivered.push(p);
    };

    // 2024-03-10 06:00 UTC = 01:00 EST → inside quiet hours. Deferred once.
    await svc.send(makePayload(), config, deliver, new Date('2024-03-10T06:00:00Z'));
    expect(counterValue(metrics, 'push_deferred_count')).toBe(1);
    expect(svc.queueSize).toBe(1);

    // 2024-03-10 07:30 UTC = 03:30 EDT (after the skipped 02:00–03:00 hour).
    // Still before 08:00 local → remains deferred, NOT re-counted.
    const flushedEarly = await svc.flush(deliver, new Date('2024-03-10T07:30:00Z'));
    expect(flushedEarly).toBe(0);
    expect(counterValue(metrics, 'push_deferred_count')).toBe(1); // unchanged
    expect(svc.queueSize).toBe(1);

    // 2024-03-10 13:00 UTC = 09:00 EDT → window over. Delivered exactly once.
    const flushed = await svc.flush(deliver, new Date('2024-03-10T13:00:00Z'));
    expect(flushed).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(counterValue(metrics, 'push_deferred_count')).toBe(1); // never double-counted
  });

  it('does not double-deliver across a fall-back transition', async () => {
    // US fall-back 2024: 2024-11-03, clocks 02:00 EDT → 01:00 EST (01:00 occurs twice).
    const config = makeConfig({ timezone: 'America/New_York', startHour: 22, endHour: 8 });
    const svc = new PushQuietHoursService(new MetricsCollector({ enabled: true }));
    const delivered: PushPayload[] = [];
    const deliver = async (p: PushPayload) => {
      delivered.push(p);
    };

    // Deferred at 2024-11-03 05:00 UTC = 01:00 EDT (first occurrence).
    await svc.send(makePayload(), config, deliver, new Date('2024-11-03T05:00:00Z'));

    // 06:30 UTC = 01:30 EST (second 01:00 hour) → still quiet, retained.
    expect(await svc.flush(deliver, new Date('2024-11-03T06:30:00Z'))).toBe(0);
    expect(svc.queueSize).toBe(1);

    // 14:00 UTC = 09:00 EST → delivered once.
    expect(await svc.flush(deliver, new Date('2024-11-03T14:00:00Z'))).toBe(1);
    expect(delivered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Default metrics collector wiring
// ---------------------------------------------------------------------------

describe('PushQuietHoursService default construction', () => {
  it('constructs with the global metrics collector when none is provided', async () => {
    const svc = new PushQuietHoursService();
    const delivered: PushPayload[] = [];
    // Disabled config → never in quiet hours, so it delivers immediately using
    // the default live clock (no `now` argument) without touching metrics.
    const result = await svc.send(
      makePayload(),
      makeConfig({ enabled: false }),
      async (p) => {
        delivered.push(p);
      },
    );
    expect(result).toBe('sent');
    expect(delivered).toHaveLength(1);
  });
});
