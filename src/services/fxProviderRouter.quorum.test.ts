/**
 * Integration tests: FX Quorum guard wired into the FxProviderRouter rate-fetch
 * pipeline.
 *
 * These verify that:
 * - With a quorum evaluator, the router gathers every provider's quote and
 *   returns the aggregated consensus rate when providers agree.
 * - When providers diverge beyond tolerance the run is BLOCKED (getRate throws
 *   FxQuorumFailedError) instead of silently returning one quote.
 * - A single provider outage (null or throwing) still meets quorum if the
 *   remaining N-1 are within tolerance.
 * - The router rejects a misconfiguration where k > number of providers.
 * - Legacy behaviour (no quorum supplied) is unchanged.
 */

import {
  ProviderHealthScorer,
  ScoredRateProvider,
  FxProviderRouter,
} from './providerHealthScorer';
import { FxQuorumEvaluator, FxQuorumFailedError } from './fxQuorumEvaluator';
import { InMemoryRateProvider, RateProvider } from './fxConversionEngine';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';

function makeMetrics(): MetricsCollector {
  return new MetricsCollector({ enabled: true, enablePIIDetection: false });
}
function makeLogger(): Logger {
  return new Logger();
}
function makeScorer(): ProviderHealthScorer {
  return new ProviderHealthScorer(
    {
      windowSize: 20,
      minCallsForEvaluation: 5,
      demotionSuccessRate: 0.8,
      promotionSuccessRate: 0.9,
      recoveryWindowMs: 0,
    },
    makeMetrics(),
    makeLogger(),
  );
}

/** A provider that always throws (simulates a hard outage / bug). */
class ThrowingProvider implements RateProvider {
  async getRate(): Promise<never> {
    throw new Error('provider exploded');
  }
}

function providerWith(id: string, mid: string, scorer: ProviderHealthScorer): ScoredRateProvider {
  const inner = new InMemoryRateProvider();
  inner.setRateFromValues('USD/EUR', mid, mid, mid);
  return new ScoredRateProvider(id, inner, scorer);
}

const QUORUM_CFG = { k: 2, tolerance: 0.005 };

describe('FxProviderRouter + FxQuorumEvaluator', () => {
  it('returns the consensus rate when providers agree', async () => {
    const scorer = makeScorer();
    const router = new FxProviderRouter(
      [providerWith('a', '1.0000', scorer), providerWith('b', '1.0005', scorer), providerWith('c', '1.0010', scorer)],
      scorer,
      new FxQuorumEvaluator(QUORUM_CFG, { metrics: makeMetrics(), logger: makeLogger() }),
    );

    const rate = await router.getRate('USD', 'EUR');
    expect(rate).not.toBeNull();
    // median of [1.0000, 1.0005, 1.0010] = 1.0005
    expect(parseFloat(rate!.mid.toString())).toBeCloseTo(1.0005, 6);
  });

  it('BLOCKS the run when providers diverge beyond tolerance', async () => {
    const scorer = makeScorer();
    const router = new FxProviderRouter(
      [providerWith('a', '1.0000', scorer), providerWith('rogue', '1.2000', scorer)],
      scorer,
      new FxQuorumEvaluator(QUORUM_CFG),
    );

    await expect(router.getRate('USD', 'EUR')).rejects.toThrow(FxQuorumFailedError);
  });

  it('SINGLE PROVIDER OUTAGE still meets quorum if N-1 within tolerance', async () => {
    const scorer = makeScorer();
    // c is an outage (no rate configured -> returns null)
    const c = new ScoredRateProvider('c', new InMemoryRateProvider(), scorer);
    const router = new FxProviderRouter(
      [providerWith('a', '1.0000', scorer), providerWith('b', '1.0003', scorer), c],
      scorer,
      new FxQuorumEvaluator(QUORUM_CFG, { metrics: makeMetrics(), logger: makeLogger() }),
    );

    const rate = await router.getRate('USD', 'EUR');
    expect(rate).not.toBeNull();
    expect(parseFloat(rate!.mid.toString())).toBeCloseTo(1.00015, 6);
  });

  it('a THROWING provider counts as an outage and quorum still passes on N-1', async () => {
    const scorer = makeScorer();
    const router = new FxProviderRouter(
      [providerWith('a', '1.0000', scorer), providerWith('b', '1.0002', scorer), new ScoredRateProvider('broken', new ThrowingProvider(), scorer)],
      scorer,
      new FxQuorumEvaluator(QUORUM_CFG),
    );

    const rate = await router.getRate('USD', 'EUR');
    expect(rate).not.toBeNull();
    expect(parseFloat(rate!.mid.toString())).toBeCloseTo(1.0001, 6);
  });

  it('throws at construction when quorum k exceeds provider count', () => {
    const scorer = makeScorer();
    expect(
      () =>
        new FxProviderRouter(
          [providerWith('a', '1.0000', scorer), providerWith('b', '1.0000', scorer)],
          scorer,
          new FxQuorumEvaluator({ k: 3, tolerance: 0.005 }),
        ),
    ).toThrow(/quorum requires k=3/);
  });

  it('emits fx_quorum_failed_total via the router on divergence', async () => {
    const scorer = makeScorer();
    const metrics = makeMetrics();
    const router = new FxProviderRouter(
      [providerWith('a', '1.0000', scorer), providerWith('rogue', '1.3000', scorer)],
      scorer,
      new FxQuorumEvaluator(QUORUM_CFG, { metrics }),
    );

    await expect(router.getRate('USD', 'EUR')).rejects.toThrow(FxQuorumFailedError);
    const prom = metrics.exportPrometheus();
    expect(prom).toMatch(/fx_quorum_failed_total/);
  });
});

describe('FxProviderRouter legacy behaviour (no quorum)', () => {
  it('still returns the first healthy provider when no quorum is configured', async () => {
    const scorer = makeScorer();
    // b is demoted so a should be chosen first
    const a = providerWith('a', '1.0000', scorer);
    const bInner = new InMemoryRateProvider();
    bInner.setRateFromValues('USD/EUR', '9.9999', '9.9999', '9.9999');
    const b = new ScoredRateProvider('b', bInner, scorer);
    scorer.record('b', { success: false, latencyMs: 10, rateAgeMs: null, timestamp: new Date() });
    scorer.record('b', { success: false, latencyMs: 10, rateAgeMs: null, timestamp: new Date() });
    scorer.record('b', { success: false, latencyMs: 10, rateAgeMs: null, timestamp: new Date() });
    scorer.record('b', { success: false, latencyMs: 10, rateAgeMs: null, timestamp: new Date() });
    scorer.record('b', { success: false, latencyMs: 10, rateAgeMs: null, timestamp: new Date() });
    scorer.record('b', { success: false, latencyMs: 10, rateAgeMs: null, timestamp: new Date() });

    const router = new FxProviderRouter([a, b], scorer);
    const rate = await router.getRate('USD', 'EUR');
    expect(rate).not.toBeNull();
    expect(parseFloat(rate!.mid.toString())).toBeCloseTo(1.0, 6);
  });
});
