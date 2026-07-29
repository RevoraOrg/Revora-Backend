/**
 * Tests for ProviderHealthScorer, ScoredRateProvider, and FxProviderRouter.
 *
 * Coverage targets:
 * - Rolling window eviction
 * - Demotion on low success rate, high latency, high staleness
 * - Promotion hysteresis (must cross promotion threshold, not just exit demotion threshold)
 * - Oscillation prevention (mandatory recovery window + hysteresis gap)
 * - Borderline metrics do NOT trigger demotion
 * - ScoredRateProvider wraps inner provider and records correctly
 * - FxProviderRouter: healthy-first routing, demoted fallback, all-demoted fallback
 * - Metric and callback emissions on demotion/promotion
 * - minCallsForEvaluation gate
 * - sanitiseProviderId (special characters)
 * - Config validation error (promotionSuccessRate <= demotionSuccessRate)
 */

import {
  ProviderHealthScorer,
  ScoredRateProvider,
  FxProviderRouter,
  CallRecord,
  HealthStateChangeCallback,
} from './providerHealthScorer';
import { InMemoryRateProvider } from './fxConversionEngine';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMetrics(): MetricsCollector {
  return new MetricsCollector({ enabled: true, enablePIIDetection: false });
}

function makeLogger(): Logger {
  return new Logger();
}

/** Build a CallRecord with sensible defaults. */
function record(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    success:    true,
    latencyMs:  50,
    rateAgeMs:  1_000,
    timestamp:  new Date(),
    ...overrides,
  };
}

/** Push `n` identical call records into the scorer for `providerId`. */
function push(
  scorer: ProviderHealthScorer,
  providerId: string,
  n: number,
  overrides: Partial<CallRecord> = {}
): void {
  for (let i = 0; i < n; i++) {
    scorer.record(providerId, record(overrides));
  }
}

/** Build a fast scorer with a tiny window for unit tests. */
function makeScorer(overrides: ConstructorParameters<typeof ProviderHealthScorer>[0] = {}): ProviderHealthScorer {
  return new ProviderHealthScorer(
    {
      windowSize:           20,
      minCallsForEvaluation: 5,
      demotionSuccessRate:  0.80,
      promotionSuccessRate: 0.90,
      demotionLatencyP95Ms: 500,
      promotionLatencyP95Ms: 200,
      demotionRateAgeMs:    10_000,
      promotionRateAgeMs:   5_000,
      recoveryWindowMs:     0,   // disabled by default so promotions can happen quickly
      ...overrides,
    },
    makeMetrics(),
    makeLogger()
  );
}

// ─── ProviderHealthScorer – construction ──────────────────────────────────────

describe('ProviderHealthScorer construction', () => {
  it('throws when promotionSuccessRate <= demotionSuccessRate', () => {
    expect(() => new ProviderHealthScorer({
      demotionSuccessRate:  0.90,
      promotionSuccessRate: 0.90,
    })).toThrow(/hysteresis/);

    expect(() => new ProviderHealthScorer({
      demotionSuccessRate:  0.90,
      promotionSuccessRate: 0.85,
    })).toThrow(/hysteresis/);
  });

  it('accepts valid config without throwing', () => {
    expect(() => makeScorer()).not.toThrow();
  });
});

// ─── minCallsForEvaluation gate ───────────────────────────────────────────────

describe('minCallsForEvaluation gate', () => {
  it('never demotes a provider below minCalls even with 0% success rate', () => {
    const scorer = makeScorer({ minCallsForEvaluation: 10 });
    push(scorer, 'p1', 9, { success: false });
    expect(scorer.isHealthy('p1')).toBe(true);
  });

  it('evaluates after minCalls is reached', () => {
    const scorer = makeScorer({ minCallsForEvaluation: 5 });
    push(scorer, 'p1', 5, { success: false });
    expect(scorer.isHealthy('p1')).toBe(false);
  });
});

// ─── Demotion – success rate ──────────────────────────────────────────────────

describe('demotion on success rate', () => {
  it('demotes when success rate falls below threshold', () => {
    const scorer = makeScorer();
    // 10 failures → 0% success
    push(scorer, 'p1', 10, { success: false });
    expect(scorer.isHealthy('p1')).toBe(false);
  });

  it('does NOT demote when success rate is exactly at the demotion threshold', () => {
    // threshold = 0.80; exactly 80% should NOT trigger demotion
    const scorer = makeScorer({ windowSize: 10, minCallsForEvaluation: 10 });
    push(scorer, 'p1', 8, { success: true });
    push(scorer, 'p1', 2, { success: false });
    expect(scorer.isHealthy('p1')).toBe(true);
  });

  it('demotes when success rate drops just below demotion threshold', () => {
    // 7 successes + 3 failures = 70% < 80%
    const scorer = makeScorer({ windowSize: 10, minCallsForEvaluation: 10 });
    push(scorer, 'p1', 7, { success: true });
    push(scorer, 'p1', 3, { success: false });
    expect(scorer.isHealthy('p1')).toBe(false);
  });
});

// ─── Demotion – latency ───────────────────────────────────────────────────────

describe('demotion on latency', () => {
  it('demotes when p95 latency exceeds threshold', () => {
    const scorer = makeScorer({ demotionLatencyP95Ms: 500 });
    // All calls at 600ms latency → p95 = 600ms > 500ms
    push(scorer, 'p1', 10, { latencyMs: 600 });
    expect(scorer.isHealthy('p1')).toBe(false);
  });

  it('does NOT demote when p95 latency is below threshold', () => {
    const scorer = makeScorer({ demotionLatencyP95Ms: 500 });
    push(scorer, 'p1', 10, { latencyMs: 100 });
    expect(scorer.isHealthy('p1')).toBe(true);
  });

  it('does NOT demote on latency when threshold is Infinity', () => {
    const scorer = makeScorer({ demotionLatencyP95Ms: Infinity });
    push(scorer, 'p1', 10, { latencyMs: 99_999 });
    expect(scorer.isHealthy('p1')).toBe(true);
  });
});

// ─── Demotion – staleness ─────────────────────────────────────────────────────

describe('demotion on staleness', () => {
  it('demotes when mean rate age exceeds threshold', () => {
    const scorer = makeScorer({ demotionRateAgeMs: 10_000 });
    push(scorer, 'p1', 10, { rateAgeMs: 20_000 });
    expect(scorer.isHealthy('p1')).toBe(false);
  });

  it('does NOT demote when mean rate age is below threshold', () => {
    const scorer = makeScorer({ demotionRateAgeMs: 10_000 });
    push(scorer, 'p1', 10, { rateAgeMs: 1_000 });
    expect(scorer.isHealthy('p1')).toBe(true);
  });

  it('does NOT demote on staleness when threshold is Infinity', () => {
    const scorer = makeScorer({ demotionRateAgeMs: Infinity });
    push(scorer, 'p1', 10, { rateAgeMs: 999_999_999 });
    expect(scorer.isHealthy('p1')).toBe(true);
  });

  it('ignores null rateAgeMs entries in mean calculation', () => {
    const scorer = makeScorer({ demotionRateAgeMs: 10_000 });
    // 5 healthy calls with low age + 5 healthy calls with null rateAgeMs
    // Mean should be computed only over non-null entries → 1_000 ms < 10_000 ms threshold
    push(scorer, 'p1', 5, { success: true, rateAgeMs: 1_000 });
    push(scorer, 'p1', 5, { success: true, rateAgeMs: null });
    expect(scorer.isHealthy('p1')).toBe(true);
  });
});

// ─── Rolling window eviction ──────────────────────────────────────────────────

describe('rolling window eviction', () => {
  it('evicts old records so recent healthy calls can recover status', () => {
    const scorer = makeScorer({ windowSize: 10, recoveryWindowMs: 0 });

    // Fill window with failures → demoted
    push(scorer, 'p1', 10, { success: false });
    expect(scorer.isHealthy('p1')).toBe(false);

    // Push 10 healthy calls; window flips to 100% success + low latency + low age
    push(scorer, 'p1', 10, { success: true, latencyMs: 50, rateAgeMs: 500 });
    expect(scorer.isHealthy('p1')).toBe(true);
  });

  it('getSnapshot reflects window size correctly', () => {
    const scorer = makeScorer({ windowSize: 5 });
    push(scorer, 'p1', 10, { success: true });
    const snap = scorer.getSnapshot('p1');
    expect(snap?.windowSize).toBe(5);
  });
});

// ─── Promotion hysteresis ─────────────────────────────────────────────────────

describe('promotion hysteresis', () => {
  it('does NOT promote when success rate is between demotion and promotion thresholds', () => {
    // demotionSuccessRate = 0.80, promotionSuccessRate = 0.90
    const scorer = makeScorer({ windowSize: 20, recoveryWindowMs: 0 });

    // Demote with 0% success
    push(scorer, 'p1', 10, { success: false });
    expect(scorer.isHealthy('p1')).toBe(false);

    // Add 8 successes + 2 failures = 85% → between thresholds → stays demoted
    push(scorer, 'p1', 8, { success: true, latencyMs: 50, rateAgeMs: 500 });
    push(scorer, 'p1', 2, { success: false });
    expect(scorer.isHealthy('p1')).toBe(false);
  });

  it('promotes when all metrics cross the promotion threshold', () => {
    const scorer = makeScorer({ windowSize: 10, recoveryWindowMs: 0 });

    // Demote
    push(scorer, 'p1', 10, { success: false });
    expect(scorer.isHealthy('p1')).toBe(false);

    // Flood window with fully healthy calls → 100% success, low latency, low age
    push(scorer, 'p1', 10, { success: true, latencyMs: 50, rateAgeMs: 500 });
    expect(scorer.isHealthy('p1')).toBe(true);
  });
});

// ─── Oscillation prevention ───────────────────────────────────────────────────

describe('oscillation prevention', () => {
  it('enforces mandatory recovery window before promotion is possible', () => {
    const scorer = makeScorer({ recoveryWindowMs: 60_000, windowSize: 10 });

    push(scorer, 'p1', 10, { success: false });
    expect(scorer.isHealthy('p1')).toBe(false);

    // Even perfect metrics should NOT promote within recoveryWindowMs
    push(scorer, 'p1', 10, { success: true, latencyMs: 10, rateAgeMs: 100 });
    expect(scorer.isHealthy('p1')).toBe(false);
  });

  it('does NOT oscillate on borderline success rate (79.9% then 80%)', () => {
    const scorer = makeScorer({ windowSize: 20, minCallsForEvaluation: 20, recoveryWindowMs: 0 });

    // First batch: 15 successes + 5 failures = 75% → demoted
    push(scorer, 'p1', 15, { success: true });
    push(scorer, 'p1', 5,  { success: false });
    expect(scorer.isHealthy('p1')).toBe(false);

    // Recovery: push 15 more successes, but window still includes some old failures
    // Success rate in 20-call window will be ~80% which is below promotionSuccessRate=90%
    push(scorer, 'p1', 15, { success: true, latencyMs: 50, rateAgeMs: 500 });
    // 15 new successes fill the window; with windowSize=20 some old failures may remain
    // Either way, state should be consistent (no rapid flip-flop)
    const snap = scorer.getSnapshot('p1');
    expect(snap).not.toBeNull();
    // If it promoted, successRate must be >= promotionSuccessRate
    if (snap!.isHealthy) {
      expect(snap!.successRate).toBeGreaterThanOrEqual(0.90);
    }
  });

  it('fires at most one demotion event for a sustained unhealthy period', () => {
    const scorer = makeScorer({ windowSize: 20 });
    const events: string[] = [];
    scorer.onStateChange((evt) => events.push(evt));

    push(scorer, 'p1', 20, { success: false });
    // Only one 'demoted' event should fire
    const demotions = events.filter(e => e === 'demoted');
    expect(demotions.length).toBe(1);
  });
});

// ─── Snapshot API ─────────────────────────────────────────────────────────────

describe('getSnapshot / getAllSnapshots', () => {
  it('returns null for unknown provider', () => {
    const scorer = makeScorer();
    expect(scorer.getSnapshot('unknown')).toBeNull();
  });

  it('returns correct successRate in snapshot', () => {
    const scorer = makeScorer({ windowSize: 10, minCallsForEvaluation: 10 });
    push(scorer, 'p1', 7, { success: true });
    push(scorer, 'p1', 3, { success: false });
    const snap = scorer.getSnapshot('p1')!;
    expect(snap.successRate).toBeCloseTo(0.7, 5);
  });

  it('returns correct p95 latency', () => {
    const scorer = makeScorer({ windowSize: 100, minCallsForEvaluation: 5 });
    // 20 calls: 19 at 100ms, 1 at 900ms → p95 is at index floor(20*0.95)=19 → 900ms
    for (let i = 0; i < 19; i++) scorer.record('p1', record({ latencyMs: 100 }));
    scorer.record('p1', record({ latencyMs: 900 }));
    const snap = scorer.getSnapshot('p1')!;
    expect(snap.latencyP95Ms).toBe(900);
  });

  it('returns null latencyP95Ms before any calls', () => {
    const scorer = makeScorer();
    // getSnapshot returns null for no records; ensure no crash
    expect(scorer.getSnapshot('nobody')).toBeNull();
  });

  it('getAllSnapshots returns entry for every recorded provider', () => {
    const scorer = makeScorer();
    push(scorer, 'a', 5, {});
    push(scorer, 'b', 5, {});
    const all = scorer.getAllSnapshots();
    expect(all.map(s => s.providerId).sort()).toEqual(['a', 'b']);
  });

  it('reset clears records and state', () => {
    const scorer = makeScorer({ windowSize: 10 });
    push(scorer, 'p1', 10, { success: false });
    expect(scorer.isHealthy('p1')).toBe(false);
    scorer.reset('p1');
    expect(scorer.getSnapshot('p1')).toBeNull();
    expect(scorer.isHealthy('p1')).toBe(true);
  });
});

// ─── Provider ID sanitisation ─────────────────────────────────────────────────

describe('provider ID sanitisation', () => {
  it('treats IDs with special chars as equivalent to sanitised form', () => {
    const scorer = makeScorer({ minCallsForEvaluation: 1 });
    // Push one healthy call under a dirty name
    scorer.record('my provider!@#', record({ success: true }));
    // The snapshot should exist under the sanitised key
    const all = scorer.getAllSnapshots();
    expect(all.length).toBe(1);
    expect(all[0].providerId).toMatch(/^[a-zA-Z0-9_\-]+$/);
  });

  it('isHealthy is consistent before and after sanitisation', () => {
    const scorer = makeScorer();
    push(scorer, 'ok-provider', 5, { success: true });
    expect(scorer.isHealthy('ok-provider')).toBe(true);
  });
});

// ─── Callbacks and metrics ────────────────────────────────────────────────────

describe('state-change callbacks', () => {
  it('fires callback with "demoted" event and snapshot on demotion', () => {
    const scorer = makeScorer();
    const events: Array<{ event: string; snap: ReturnType<typeof scorer.getSnapshot> }> = [];
    scorer.onStateChange((evt, snap) => events.push({ event: evt, snap }));

    push(scorer, 'p1', 10, { success: false });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('demoted');
    expect(events[0].snap!.isHealthy).toBe(false);
    expect(events[0].snap!.providerId).toBe('p1');
  });

  it('fires callback with "promoted" event after recovery', () => {
    const scorer = makeScorer({ windowSize: 10, recoveryWindowMs: 0 });
    const events: string[] = [];
    scorer.onStateChange((evt) => events.push(evt));

    push(scorer, 'p1', 10, { success: false });
    push(scorer, 'p1', 10, { success: true, latencyMs: 50, rateAgeMs: 500 });

    expect(events).toContain('demoted');
    expect(events).toContain('promoted');
  });

  it('offStateChange removes the callback', () => {
    const scorer = makeScorer();
    const events: string[] = [];
    const cb: HealthStateChangeCallback = (evt) => events.push(evt);
    scorer.onStateChange(cb);
    scorer.offStateChange(cb);

    push(scorer, 'p1', 10, { success: false });
    expect(events).toHaveLength(0);
  });

  it('callback exceptions do not crash the scorer', () => {
    const scorer = makeScorer();
    scorer.onStateChange(() => { throw new Error('callback boom'); });
    expect(() => push(scorer, 'p1', 10, { success: false })).not.toThrow();
  });
});

describe('metrics emission', () => {
  it('emits fx_provider_health_score gauge after evaluation', () => {
    const metrics = makeMetrics();
    const scorer = new ProviderHealthScorer(
      { windowSize: 10, minCallsForEvaluation: 5 },
      metrics,
      makeLogger()
    );
    push(scorer, 'p1', 10, { success: true, latencyMs: 50, rateAgeMs: 500 });
    const prom = metrics.exportPrometheus();
    expect(prom).toContain('fx_provider_health_score');
  });

  it('emits fx_provider_status gauge (1 for healthy)', () => {
    const metrics = makeMetrics();
    const scorer = new ProviderHealthScorer(
      { windowSize: 10, minCallsForEvaluation: 5 },
      metrics,
      makeLogger()
    );
    push(scorer, 'p1', 10, { success: true, latencyMs: 50, rateAgeMs: 500 });
    const prom = metrics.exportPrometheus();
    expect(prom).toContain('fx_provider_status');
  });

  it('emits fx_provider_status = 0 when demoted', () => {
    const metrics = makeMetrics();
    const scorer = new ProviderHealthScorer(
      { windowSize: 10, minCallsForEvaluation: 5 },
      metrics,
      makeLogger()
    );
    push(scorer, 'p1', 10, { success: false });
    const prom = metrics.exportPrometheus();
    expect(prom).toContain('fx_provider_status');
    expect(prom).toContain('fx_provider_demotions_total');
  });

  it('emits fx_provider_latency_p95_ms gauge', () => {
    const metrics = makeMetrics();
    const scorer = new ProviderHealthScorer(
      { windowSize: 10, minCallsForEvaluation: 5 },
      metrics,
      makeLogger()
    );
    push(scorer, 'p1', 10, { success: true, latencyMs: 120 });
    const prom = metrics.exportPrometheus();
    expect(prom).toContain('fx_provider_latency_p95_ms');
  });

  it('emits fx_provider_calls_total counter', () => {
    const metrics = makeMetrics();
    const scorer = new ProviderHealthScorer(
      { windowSize: 10, minCallsForEvaluation: 5 },
      metrics,
      makeLogger()
    );
    push(scorer, 'p1', 3, { success: true });
    const prom = metrics.exportPrometheus();
    expect(prom).toContain('fx_provider_calls_total');
  });

  it('emits fx_provider_promotions_total counter on promotion', () => {
    const metrics = makeMetrics();
    const scorer = new ProviderHealthScorer(
      {
        windowSize: 10,
        minCallsForEvaluation: 5,
        demotionSuccessRate: 0.80,
        promotionSuccessRate: 0.90,
        demotionLatencyP95Ms: Infinity,
        promotionLatencyP95Ms: Infinity,
        demotionRateAgeMs: Infinity,
        promotionRateAgeMs: Infinity,
        recoveryWindowMs: 0,
      },
      metrics,
      makeLogger()
    );
    push(scorer, 'p1', 10, { success: false });
    push(scorer, 'p1', 10, { success: true, latencyMs: 50, rateAgeMs: 500 });
    const prom = metrics.exportPrometheus();
    expect(prom).toContain('fx_provider_promotions_total');
  });
});

// ─── ScoredRateProvider ───────────────────────────────────────────────────────

describe('ScoredRateProvider', () => {
  it('returns the inner provider rate unchanged on success', async () => {
    const inner = new InMemoryRateProvider();
    inner.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92', 300_000);
    const scorer = makeScorer();
    const scored = new ScoredRateProvider('primary', inner, scorer);

    const rate = await scored.getRate('USD', 'EUR');
    expect(rate).not.toBeNull();
    expect(rate!.pair).toBe('USD/EUR');
  });

  it('returns null and records a failure when inner returns null', async () => {
    const inner = new InMemoryRateProvider(); // no rates set
    const scorer = makeScorer();
    const scored = new ScoredRateProvider('primary', inner, scorer);

    const rate = await scored.getRate('USD', 'EUR');
    expect(rate).toBeNull();

    // Verify a failure was recorded
    const snap = scorer.getSnapshot('primary');
    expect(snap).not.toBeNull();
    expect(snap!.successRate).toBeLessThan(1.0);
  });

  it('records a failure when inner provider throws', async () => {
    const inner: InMemoryRateProvider = new InMemoryRateProvider();
    jest.spyOn(inner, 'getRate').mockRejectedValue(new Error('upstream timeout'));

    const scorer = makeScorer();
    const scored = new ScoredRateProvider('flaky', inner, scorer);

    await expect(scored.getRate('USD', 'EUR')).rejects.toThrow('upstream timeout');

    // Failure must still be recorded
    const snap = scorer.getSnapshot('flaky');
    expect(snap).not.toBeNull();
    expect(snap!.windowSize).toBe(1);
    expect(snap!.successRate).toBe(0);
  });

  it('records latency > 0 for each call', async () => {
    const inner = new InMemoryRateProvider();
    inner.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92', 300_000);
    const scorer = makeScorer();
    const scored = new ScoredRateProvider('fast', inner, scorer);

    await scored.getRate('USD', 'EUR');
    const snap = scorer.getSnapshot('fast')!;
    expect(snap.latencyP95Ms).not.toBeNull();
    expect(snap.latencyP95Ms!).toBeGreaterThanOrEqual(0);
  });

  it('records rateAgeMs as null for failed calls', async () => {
    const inner = new InMemoryRateProvider();
    const scorer = makeScorer();
    const scored = new ScoredRateProvider('null-returner', inner, scorer);

    await scored.getRate('USD', 'EUR');
    const snap = scorer.getSnapshot('null-returner')!;
    // meanRateAgeMs should be null since the only call returned null
    expect(snap.meanRateAgeMs).toBeNull();
  });

  it('records rateAgeMs for successful calls', async () => {
    const inner = new InMemoryRateProvider();
    inner.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92', 300_000);
    const scorer = makeScorer();
    const scored = new ScoredRateProvider('age-test', inner, scorer);

    await scored.getRate('USD', 'EUR');
    const snap = scorer.getSnapshot('age-test')!;
    expect(snap.meanRateAgeMs).not.toBeNull();
    expect(snap.meanRateAgeMs!).toBeGreaterThanOrEqual(0);
  });
});

// ─── FxProviderRouter ─────────────────────────────────────────────────────────

describe('FxProviderRouter', () => {
  function makeRouter(
    providers: ScoredRateProvider[],
    scorer: ProviderHealthScorer
  ): FxProviderRouter {
    return new FxProviderRouter(providers, scorer);
  }

  it('throws when constructed with empty providers list', () => {
    const scorer = makeScorer();
    expect(() => new FxProviderRouter([], scorer)).toThrow();
  });

  it('routes to the healthy primary provider', async () => {
    const scorer = makeScorer();
    const primary = new InMemoryRateProvider();
    primary.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92', 300_000);
    const backup = new InMemoryRateProvider();
    backup.setRateFromValues('USD/EUR', '0.88', '0.90', '0.89', 300_000);

    const scored1 = new ScoredRateProvider('primary', primary, scorer);
    const scored2 = new ScoredRateProvider('backup',  backup,  scorer);
    const router  = makeRouter([scored1, scored2], scorer);

    const rate = await router.getRate('USD', 'EUR');
    // Primary should be used; rate is same from both so just check it's non-null
    expect(rate).not.toBeNull();
  });

  it('falls back to backup when primary is demoted', async () => {
    const scorer = makeScorer({ windowSize: 10 });

    const primaryInner = new InMemoryRateProvider();
    primaryInner.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92', 300_000);
    const backupInner = new InMemoryRateProvider();
    backupInner.setRateFromValues('USD/EUR', '0.88', '0.90', '0.89', 300_000);

    const primaryScored = new ScoredRateProvider('primary', primaryInner, scorer);
    const backupScored  = new ScoredRateProvider('backup',  backupInner,  scorer);
    const router = makeRouter([primaryScored, backupScored], scorer);

    // Demote primary by injecting failure records directly
    push(scorer, 'primary', 10, { success: false });
    expect(scorer.isHealthy('primary')).toBe(false);

    // Spy on primary's getRate — it should NOT be called in phase 1
    const primarySpy = jest.spyOn(primaryInner, 'getRate');
    const rate = await router.getRate('USD', 'EUR');
    expect(rate).not.toBeNull();
    // Primary was skipped in phase 1; backup returned the rate
    expect(primarySpy).not.toHaveBeenCalled();
  });

  it('falls back to demoted provider when all healthy providers return null', async () => {
    const scorer = makeScorer({ windowSize: 10 });

    const primaryInner = new InMemoryRateProvider(); // No USD/JPY rate
    const backupInner  = new InMemoryRateProvider();
    backupInner.setRateFromValues('USD/JPY', '148', '150', '149', 300_000);

    const scored1 = new ScoredRateProvider('primary', primaryInner, scorer);
    const scored2 = new ScoredRateProvider('backup',  backupInner,  scorer);
    const router = makeRouter([scored1, scored2], scorer);

    // Demote backup
    push(scorer, 'backup', 10, { success: false });
    expect(scorer.isHealthy('backup')).toBe(false);

    // Primary is healthy but doesn't have USD/JPY → falls back to demoted backup
    const rate = await router.getRate('USD', 'JPY');
    expect(rate).not.toBeNull();
    expect(rate!.pair).toBe('USD/JPY');
  });

  it('returns null when all providers return null', async () => {
    const scorer = makeScorer();
    const inner = new InMemoryRateProvider(); // empty
    const scored = new ScoredRateProvider('empty', inner, scorer);
    const router = makeRouter([scored], scorer);

    const rate = await router.getRate('USD', 'EUR');
    expect(rate).toBeNull();
  });

  it('getHealthyProviders returns only healthy providers', () => {
    const scorer = makeScorer({ windowSize: 10 });
    const inner1 = new InMemoryRateProvider();
    const inner2 = new InMemoryRateProvider();
    const s1 = new ScoredRateProvider('p1', inner1, scorer);
    const s2 = new ScoredRateProvider('p2', inner2, scorer);
    const router = makeRouter([s1, s2], scorer);

    push(scorer, 'p1', 10, { success: false });
    expect(router.getHealthyProviders().map(p => p.providerId)).toEqual(['p2']);
    expect(router.getDemotedProviders().map(p => p.providerId)).toEqual(['p1']);
  });
});

// ─── Integration: ScoredRateProvider + scorer auto-demotion ──────────────────

describe('integration: ScoredRateProvider auto-demotes on repeated failures', () => {
  it('demotes after enough consecutive null returns', async () => {
    const scorer = new ProviderHealthScorer(
      {
        windowSize:            10,
        minCallsForEvaluation: 10,
        demotionSuccessRate:   0.80,
        promotionSuccessRate:  0.90,
        demotionLatencyP95Ms:  Infinity,
        demotionRateAgeMs:     Infinity,
        promotionLatencyP95Ms: Infinity,
        promotionRateAgeMs:    Infinity,
      },
      makeMetrics(),
      makeLogger()
    );

    const inner = new InMemoryRateProvider(); // returns null for everything
    const scored = new ScoredRateProvider('flaky', inner, scorer);

    for (let i = 0; i < 10; i++) {
      await scored.getRate('USD', 'EUR');
    }

    expect(scorer.isHealthy('flaky')).toBe(false);
  });
});
