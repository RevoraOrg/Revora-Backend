import { PushQuietHoursScheduler } from './pushQuietHoursScheduler';
import { PushQuietHoursService, PushDeliveryFn } from './pushQuietHoursService';
import { MetricsCollector } from '../lib/metrics';

// Minimal fake service exposing just the flush() contract the scheduler uses.
class FakeService {
  public delivered = 0;
  public throwOnce = false;
  public throwNonError = false;
  async flush(_fn: PushDeliveryFn): Promise<number> {
    if (this.throwNonError) {
      this.throwNonError = false;
      // eslint-disable-next-line no-throw-literal
      throw 'string failure';
    }
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error('delivery boom');
    }
    return this.delivered;
  }
}

const noopDeliver: PushDeliveryFn = async () => {};

/** Read a counter value directly from a MetricsCollector's internal map. */
function counterValue(m: MetricsCollector, name: string): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (m as any)['counters'].get(name) ?? 0;
}

describe('PushQuietHoursScheduler', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    jest.useFakeTimers();
    metrics = new MetricsCollector({ enabled: true });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const make = (svc: FakeService, intervalMs = 1000) =>
    new PushQuietHoursScheduler(
      svc as unknown as PushQuietHoursService,
      noopDeliver,
      { intervalMs, metrics },
    );

  it('flushes on each interval tick', async () => {
    const svc = new FakeService();
    svc.delivered = 3;
    const flushSpy = jest.spyOn(svc, 'flush');
    const sched = make(svc);

    sched.start();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(flushSpy).toHaveBeenCalledTimes(1);
    sched.stop();
  });

  it('start() is idempotent — a second call does not create a second timer', async () => {
    const svc = new FakeService();
    svc.delivered = 1;
    const flushSpy = jest.spyOn(svc, 'flush');
    const sched = make(svc);

    sched.start();
    sched.start(); // no-op
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(flushSpy).toHaveBeenCalledTimes(1);
    sched.stop();
  });

  it('stop() halts further ticks and is idempotent', async () => {
    const svc = new FakeService();
    const flushSpy = jest.spyOn(svc, 'flush');
    const sched = make(svc);

    sched.start();
    sched.stop();
    sched.stop(); // idempotent
    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    expect(flushSpy).not.toHaveBeenCalled();
  });

  it('tick() returns delivered count and increments the delivered counter', async () => {
    const svc = new FakeService();
    svc.delivered = 5;
    const sched = make(svc);

    const n = await sched.tick();

    expect(n).toBe(5);
    expect(counterValue(metrics, 'push_flush_delivered_total')).toBe(5);
  });

  it('does not emit the delivered counter when nothing was released', async () => {
    const svc = new FakeService();
    svc.delivered = 0;
    const sched = make(svc);

    const n = await sched.tick();

    expect(n).toBe(0);
    expect(counterValue(metrics, 'push_flush_delivered_total')).toBe(0);
  });

  it('catches flush errors, counts them, and keeps returning 0', async () => {
    const svc = new FakeService();
    svc.throwOnce = true;
    const sched = make(svc);

    const n = await sched.tick();

    expect(n).toBe(0);
    expect(counterValue(metrics, 'push_flush_errors_total')).toBe(1);
  });

  it('handles a non-Error throw from flush', async () => {
    const svc = new FakeService();
    svc.throwNonError = true;
    const sched = make(svc);

    await expect(sched.tick()).resolves.toBe(0);
    expect(counterValue(metrics, 'push_flush_errors_total')).toBe(1);
  });

  it('constructs with default interval/logger/metrics when no options are given', async () => {
    const svc = new FakeService();
    svc.delivered = 0;
    // No options object → exercises the intervalMs/logger/metrics defaults.
    const sched = new PushQuietHoursScheduler(
      svc as unknown as PushQuietHoursService,
      noopDeliver,
    );
    await expect(sched.tick()).resolves.toBe(0);
    // start()/stop() must work against the default (unref'd) interval too.
    sched.start();
    sched.stop();
  });
});
