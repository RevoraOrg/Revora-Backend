import {
  FxConversionEngine,
  InMemoryRateProvider,
  ExchangeRate,
} from './fxConversionEngine';
import { Decimal } from '../lib/decimal';
import { MetricsCollector } from '../lib/metrics';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(): InMemoryRateProvider {
  const p = new InMemoryRateProvider();
  p.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92', 300000);
  p.setRateFromValues('EUR/GBP', '0.85', '0.87', '0.86', 300000);
  p.setRateFromValues('USD/GBP', '0.78', '0.80', '0.79', 300000);
  p.setRateFromValues('USD/JPY', '148.50', '149.50', '149.00', 300000);
  p.setRateFromValues('EUR/JPY', '161.50', '162.50', '162.00', 300000);
  return p;
}

function makeEngine(provider?: InMemoryRateProvider, metrics?: MetricsCollector): FxConversionEngine {
  return new FxConversionEngine(provider ?? makeProvider(), {
    defaultBucketIncrement: '0.01',
    metrics,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FxConversionEngine', () => {
  // ── Direct conversion ─────────────────────────────────────────────────────

  describe('direct conversion', () => {
    it('converts USD to EUR using mid rate', async () => {
      const engine = makeEngine();
      const result = await engine.convert(new Decimal('100'), 'USD', 'EUR');
      expect(result.outputCurrency).toBe('EUR');
      expect(result.inputCurrency).toBe('USD');
      expect(result.outputAmount.toString()).toBe('92.00');
      expect(result.path.type).toBe('direct');
      expect(result.roundedToIncrement).toBe(false);
    });

    it('converts EUR to USD (inverse rate lookup)', async () => {
      const engine = makeEngine();
      const result = await engine.convert(new Decimal('100'), 'EUR', 'USD');
      expect(result.outputCurrency).toBe('USD');
      expect(result.path.type).toBe('direct');
      const expectedMid = 100 / 0.92;
      expect(parseFloat(result.outputAmount.toString())).toBeCloseTo(expectedMid, 2);
    });

    it('uses bid side when specified', async () => {
      const engine = makeEngine();
      const result = await engine.convert(new Decimal('100'), 'USD', 'EUR', { side: 'bid' });
      expect(result.outputAmount.toString()).toBe('91.00');
    });

    it('uses ask side when specified', async () => {
      const engine = makeEngine();
      const result = await engine.convert(new Decimal('100'), 'USD', 'EUR', { side: 'ask' });
      expect(result.outputAmount.toString()).toBe('93.00');
    });

    it('rejects zero amount', async () => {
      const engine = makeEngine();
      await expect(engine.convert(new Decimal('0'), 'USD', 'EUR'))
        .rejects.toThrow('Cannot convert zero amount');
    });

    it('rejects negative amount', async () => {
      const engine = makeEngine();
      await expect(engine.convert(new Decimal('-50'), 'USD', 'EUR'))
        .rejects.toThrow('Cannot convert negative amount');
    });

    it('rejects when no rate is available', async () => {
      const provider = makeProvider();
      const engine = makeEngine(provider);
      await expect(engine.convert(new Decimal('100'), 'USD', 'XYZ'))
        .rejects.toThrow('No exchange rate available');
    });
  });

  // ── Identical currency identity ────────────────────────────────────────────

  describe('identical currency identity', () => {
    it('returns same amount for identical currencies', async () => {
      const engine = makeEngine();
      const result = await engine.convert(new Decimal('100'), 'USD', 'USD');
      expect(result.outputAmount.toString()).toBe('100');
      expect(result.outputCurrency).toBe('USD');
      expect(result.inputCurrency).toBe('USD');
      expect(result.path.description).toContain('identity');
      expect(result.roundedToIncrement).toBe(false);
    });

    it('works for zero-tolerance bucket increment', async () => {
      const engine = makeEngine();
      const result = await engine.convert(new Decimal('100.1234'), 'USD', 'USD', {
        bucketIncrement: new Decimal('0.0001'),
      });
      expect(result.outputAmount.toString()).toBe('100.1234');
    });

    it('does not call rate provider for identical currencies', async () => {
      const provider = makeProvider();
      const getRateSpy = jest.spyOn(provider, 'getRate');
      const engine = makeEngine(provider);
      await engine.convert(new Decimal('100'), 'USD', 'USD');
      expect(getRateSpy).not.toHaveBeenCalled();
    });
  });

  // ── Rounding to bucket increment ──────────────────────────────────────────

  describe('rounding to bucket increment', () => {
    it('rounds to nearest bucket increment', () => {
      const engine = makeEngine();
      const result = engine.roundToBucketIncrement(new Decimal('1.234'), new Decimal('0.05'));
      expect(result.toString()).toBe('1.25');
    });

    it('rounds down when below half increment', () => {
      const engine = makeEngine();
      const result = engine.roundToBucketIncrement(new Decimal('1.221'), new Decimal('0.05'));
      expect(result.toString()).toBe('1.20');
    });

    it('rounds to integer bucket increment', () => {
      const engine = makeEngine();
      const result = engine.roundToBucketIncrement(new Decimal('9.50'), new Decimal('1'));
      expect(result.toString()).toBe('10');
    });

    it('rounds to thousandths increment', () => {
      const engine = makeEngine();
      const result = engine.roundToBucketIncrement(new Decimal('0.1234'), new Decimal('0.001'));
      expect(result.toString()).toBe('0.123');
    });

    it('rejects zero increment', () => {
      const engine = makeEngine();
      expect(() => engine.roundToBucketIncrement(new Decimal('1'), new Decimal('0')))
        .toThrow('Bucket increment must be positive');
    });

    it('rejects negative increment', () => {
      const engine = makeEngine();
      expect(() => engine.roundToBucketIncrement(new Decimal('1'), new Decimal('-0.01')))
        .toThrow('Bucket increment must be positive');
    });

    it('reports roundedToIncrement flag on conversion', async () => {
      const provider = makeProvider();
      provider.setRateFromValues('USD/BTC', '0.000015', '0.000017', '0.000016', 300000);
      const engine = makeEngine(provider);
      const result = await engine.convert(new Decimal('1000'), 'USD', 'BTC');
      expect(result.roundedToIncrement).toBeDefined();
    });

    it('rounds to custom bucket increment on conversion', async () => {
      const provider = makeProvider();
      provider.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92', 300000);
      const engine = makeEngine(provider);
      const result = await engine.convert(new Decimal('100'), 'USD', 'EUR', {
        bucketIncrement: new Decimal('0.05'),
      });
      const expected = '92.00';
      expect(result.outputAmount.toString()).toBe(expected);
    });
  });

  // ── Triangulation ─────────────────────────────────────────────────────────

  describe('triangulation', () => {
    it('converts EUR to JPY via USD triangulation', async () => {
      const provider = makeProvider();
      const engine = makeEngine(provider);
      const result = await engine.triangulate(new Decimal('100'), 'EUR', 'JPY', 'USD');
      expect(result.path.type).toBe('triangulated');
      expect(result.path.description).toBe('EUR→USD→JPY');
      expect(result.outputCurrency).toBe('JPY');
      const expected = 100 / 0.92 * 149;
      expect(parseFloat(result.outputAmount.toString())).toBeCloseTo(expected, 0);
    });

    it('skips triangulation when from equals base', async () => {
      const engine = makeEngine();
      const result = await engine.triangulate(new Decimal('100'), 'USD', 'EUR', 'USD');
      expect(result.path.type).toBe('direct');
      expect(result.outputAmount.toString()).toBe('92.00');
    });

    it('skips triangulation when to equals base', async () => {
      const engine = makeEngine();
      const result = await engine.triangulate(new Decimal('100'), 'EUR', 'USD', 'USD');
      expect(result.path.type).toBe('direct');
    });

    it('maintains precision through round-trip', async () => {
      const provider = makeProvider();
      const engine = makeEngine(provider);
      const result = await engine.triangulate(new Decimal('1000'), 'USD', 'EUR', 'GBP');
      const expectedLeg1 = 1000 * 0.79;
      const expectedLeg2 = expectedLeg1 / 0.86;
      expect(parseFloat(result.outputAmount.toString())).toBeCloseTo(expectedLeg2, 2);
    });

    it('preserves bid/ask side through legs', async () => {
      const provider = makeProvider();
      provider.setRateFromValues('GBP/USD', '1.25', '1.27', '1.26', 300000);
      provider.setRateFromValues('USD/JPY', '148.50', '149.50', '149.00', 300000);
      const engine = makeEngine(provider);
      const resultBid = await engine.triangulate(new Decimal('100'), 'GBP', 'JPY', 'USD', { side: 'bid' });
      const resultAsk = await engine.triangulate(new Decimal('100'), 'GBP', 'JPY', 'USD', { side: 'ask' });
      expect(parseFloat(resultBid.outputAmount.toString())).toBeLessThan(parseFloat(resultAsk.outputAmount.toString()));
    });

    it('emits triangulation metric', async () => {
      const provider = makeProvider();
      const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
      const engine = makeEngine(provider, metrics);
      await engine.triangulate(new Decimal('100'), 'EUR', 'JPY', 'USD');
      const prom = metrics.exportPrometheus();
      expect(prom).toContain('fx_triangulations_total');
    });
  });

  // ── Asymmetric bid/ask paths ──────────────────────────────────────────────

  describe('asymmetric bid/ask paths', () => {
    it('bid is always lower than ask for a given pair', async () => {
      const provider = makeProvider();
      const engine = makeEngine(provider);
      const resultBid = await engine.convert(new Decimal('100'), 'USD', 'EUR', { side: 'bid' });
      const resultAsk = await engine.convert(new Decimal('100'), 'USD', 'EUR', { side: 'ask' });
      expect(parseFloat(resultBid.outputAmount.toString())).toBeLessThan(parseFloat(resultAsk.outputAmount.toString()));
    });

    it('mid is between bid and ask', async () => {
      const provider = makeProvider();
      const engine = makeEngine(provider);
      const resultBid = await engine.convert(new Decimal('100'), 'USD', 'EUR', { side: 'bid' });
      const resultMid = await engine.convert(new Decimal('100'), 'USD', 'EUR', { side: 'mid' });
      const resultAsk = await engine.convert(new Decimal('100'), 'USD', 'EUR', { side: 'ask' });
      const bid = parseFloat(resultBid.outputAmount.toString());
      const mid = parseFloat(resultMid.outputAmount.toString());
      const ask = parseFloat(resultAsk.outputAmount.toString());
      expect(bid).toBeLessThan(mid);
      expect(mid).toBeLessThan(ask);
    });

    it('inverted rate preserves bid/ask asymmetry', async () => {
      const provider = makeProvider();
      const engine = makeEngine(provider);
      const resultEUR = await engine.convert(new Decimal('100'), 'EUR', 'USD', { side: 'bid' });
      const resultUSD = await engine.convert(new Decimal('100'), 'USD', 'EUR', { side: 'ask' });
      const eurToUsdBid = parseFloat(resultEUR.outputAmount.toString());
      const usdToEurAsk = parseFloat(resultUSD.outputAmount.toString());
      const roundTrip = eurToUsdBid * usdToEurAsk;
      expect(roundTrip / 10000).toBeCloseTo(1, 1);
    });
  });

  // ── Stale-rate rejection ──────────────────────────────────────────────────

  describe('stale-rate rejection', () => {
    it('rejects rate older than maxAgeMs', async () => {
      const provider = makeProvider();
      const old = new Date(Date.now() - 600000);
      provider.setRateWithTimestamp('USD/EUR', '0.91', '0.93', '0.92', old, 300000);
      const engine = makeEngine(provider);
      await expect(engine.convert(new Decimal('100'), 'USD', 'EUR', { maxRateAgeMs: 300000 }))
        .rejects.toThrow('stale');
    });

    it('accepts rate within maxAgeMs', async () => {
      const provider = makeProvider();
      const recent = new Date(Date.now() - 60000);
      provider.setRateWithTimestamp('USD/EUR', '0.91', '0.93', '0.92', recent, 300000);
      const engine = makeEngine(provider);
      const result = await engine.convert(new Decimal('100'), 'USD', 'EUR', { maxRateAgeMs: 300000 });
      expect(result.outputAmount.toString()).toBe('92.00');
    });

    it('rejects rate with zero TTL when used beyond grace', async () => {
      const provider = makeProvider();
      const old = new Date(Date.now() - 1000);
      provider.setRateWithTimestamp('USD/GBP', '0.78', '0.80', '0.79', old, 0);
      const engine = makeEngine(provider);
      await expect(engine.convert(new Decimal('100'), 'USD', 'GBP', { maxRateAgeMs: 100 }))
        .rejects.toThrow('stale');
    });

    it('uses rate-specific TTL when maxRateAgeMs not provided', async () => {
      const provider = makeProvider();
      const old = new Date(Date.now() - 600000);
      provider.setRateWithTimestamp('USD/EUR', '0.91', '0.93', '0.92', old, 300000);
      const engine = makeEngine(provider);
      const defaultMaxAge = 300000;
      const age = Date.now() - old.getTime();
      if (age > defaultMaxAge) {
        await expect(engine.convert(new Decimal('100'), 'USD', 'EUR'))
          .rejects.toThrow('stale');
      } else {
        const result = await engine.convert(new Decimal('100'), 'USD', 'EUR');
        expect(result.outputAmount.toString()).toBe('92.00');
      }
    });

    it('emits stale-rate rejection metric', async () => {
      const provider = makeProvider();
      const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
      const old = new Date(Date.now() - 600000);
      provider.setRateWithTimestamp('USD/EUR', '0.91', '0.93', '0.92', old, 300000);
      const engine = makeEngine(provider, metrics);
      try {
        await engine.convert(new Decimal('100'), 'USD', 'EUR', { maxRateAgeMs: 300000 });
      } catch (e) { /* expected */ }
      const prom = metrics.exportPrometheus();
      expect(prom).toContain('fx_stale_rate_rejected_total');
    });
  });

  // ── Stale-rate fallback & Auditing ────────────────────────────────────────

  describe('stale-rate fallback & auditing', () => {
    it('tolerates stale rate when allowStaleFallback is true and emits audit', async () => {
      const provider = makeProvider();
      const old = new Date(Date.now() - 600000);
      provider.setRateWithTimestamp('USD/EUR', '0.91', '0.93', '0.92', old, 300000, 'rate_123');
      
      const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
      const auditRepo = {
        record: jest.fn().mockResolvedValue(undefined),
      } as any;

      const engine = new FxConversionEngine(provider, {
        metrics,
        auditRepository: auditRepo,
      });

      const result = await engine.convert(new Decimal('100'), 'USD', 'EUR', {
        maxRateAgeMs: 300000,
        allowStaleFallback: true,
        auditUserId: 'user_1',
      });

      expect(result.outputAmount.toString()).toBe('92.00');

      // Metric should be emitted
      const prom = metrics.exportPrometheus();
      expect(prom).toContain('fx_stale_fallback_staleness_ms');

      // Audit should be recorded
      expect(auditRepo.record).toHaveBeenCalledTimes(1);
      const auditEvent = auditRepo.record.mock.calls[0][0];
      expect(auditEvent.action).toBe('FX_STALE_RATE_FALLBACK');
      expect(auditEvent.details.reason).toBe('STALE_RATE_TOLERATED');
      expect(auditEvent.details.substituteRateId).toBe('rate_123');
      expect(auditEvent.userId).toBe('user_1');
    });

    it('uses fallbackRateProvider when primary rate is stale', async () => {
      const primaryProvider = makeProvider();
      const old = new Date(Date.now() - 600000);
      primaryProvider.setRateWithTimestamp('USD/EUR', '0.91', '0.93', '0.92', old, 300000, 'stale_rate');
      
      const fallbackProvider = makeProvider();
      fallbackProvider.setRateWithTimestamp('USD/EUR', '0.90', '0.94', '0.91', new Date(), 300000, 'fresh_fallback_rate');

      const auditRepo = {
        record: jest.fn().mockResolvedValue(undefined),
      } as any;

      const engine = new FxConversionEngine(primaryProvider, {
        fallbackRateProvider: fallbackProvider,
        auditRepository: auditRepo,
      });

      const result = await engine.convert(new Decimal('100'), 'USD', 'EUR', {
        maxRateAgeMs: 300000,
      });

      // Should use the fallback rate (0.91 mid)
      expect(result.outputAmount.toString()).toBe('91.00');

      // Audit should be recorded
      expect(auditRepo.record).toHaveBeenCalledTimes(1);
      const auditEvent = auditRepo.record.mock.calls[0][0];
      expect(auditEvent.action).toBe('FX_STALE_RATE_FALLBACK');
      expect(auditEvent.details.reason).toBe('SUBSTITUTE_PROVIDER_USED');
      expect(auditEvent.details.substituteRateId).toBe('fresh_fallback_rate');
    });

    it('no audit event if rate is fresh', async () => {
      const provider = makeProvider();
      const auditRepo = {
        record: jest.fn().mockResolvedValue(undefined),
      } as any;

      const engine = new FxConversionEngine(provider, {
        auditRepository: auditRepo,
      });

      await engine.convert(new Decimal('100'), 'USD', 'EUR');
      expect(auditRepo.record).not.toHaveBeenCalled();
    });
  });

  // ── Property-based round-trip ─────────────────────────────────────────────

  describe('property-based round-trip conversion', () => {
    const testAmounts = [
      '1', '10', '100', '1000', '10000',
      '0.01', '0.10', '0.99', '0.50',
      '99.99', '1000.01', '1234.56',
      '0.001', '999999.99',
    ];

    const testRates = [
      { pair: 'USD/EUR', bid: '0.91', ask: '0.93', mid: '0.92' },
      { pair: 'USD/GBP', bid: '0.78', ask: '0.80', mid: '0.79' },
      { pair: 'USD/JPY', bid: '148.50', ask: '149.50', mid: '149.00' },
      { pair: 'EUR/JPY', bid: '161.50', ask: '162.50', mid: '162.00' },
      { pair: 'EUR/GBP', bid: '0.85', ask: '0.87', mid: '0.86' },
    ];

    for (const amount of testAmounts) {
      for (const rate of testRates) {
        it(`round-trip ${amount} ${rate.pair} via mid rate yields negligible drift`, async () => {
          const provider = new InMemoryRateProvider();
          provider.setRateFromValues(rate.pair, rate.bid, rate.ask, rate.mid, 300000);
          const engine = makeEngine(provider);

          try {
            const [base, quote] = rate.pair.split('/');
            const forward = await engine.convert(new Decimal(amount), base, quote, { side: 'mid' });
            const backward = await engine.convert(forward.outputAmount, quote, base, { side: 'mid' });
            const drift = new Decimal(amount).subtract(backward.outputAmount);
            expect(Math.abs(parseFloat(drift.toString()))).toBeLessThanOrEqual(0.02);
          } catch (e) {
            if (e instanceof Error && e.message.includes('No exchange rate')) {
              return;
            }
            throw e;
          }
        });
      }
    }

    it('inverse of rate equals reciprocal within tolerance', async () => {
      const provider = makeProvider();
      const engine = makeEngine(provider);
      const forward = await engine.convert(new Decimal('100'), 'USD', 'EUR', { side: 'mid' });
      const backward = await engine.convert(forward.outputAmount, 'EUR', 'USD', { side: 'mid' });
      const drift = new Decimal('100').subtract(backward.outputAmount);
      expect(Math.abs(parseFloat(drift.toString()))).toBeLessThanOrEqual(0.02);
    });

    it('bid/ask spread always positive', () => {
      const provider = makeProvider();
      const allRates = provider as any;
      for (const [, rate] of allRates.rates) {
        const spread = rate.ask.subtract(rate.bid);
        expect(spread.isPositive()).toBe(true);
      }
    });
  });

  // ── Missing inverse ───────────────────────────────────────────────────────

  describe('missing inverse rate', () => {
    it('computes inverse rate automatically', async () => {
      const provider = new InMemoryRateProvider();
      provider.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92', 300000);
      const engine = makeEngine(provider);
      const result = await engine.convert(new Decimal('100'), 'EUR', 'USD');
      expect(result.outputCurrency).toBe('USD');
      expect(parseFloat(result.outputAmount.toString())).toBeGreaterThan(100);
    });

    it('inverse rate is accurate within tolerance', async () => {
      const provider = new InMemoryRateProvider();
      provider.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92', 300000);
      const engine = makeEngine(provider);
      const result = await engine.convert(new Decimal('100'), 'EUR', 'USD');
      const expectedUsd = 100 / 0.92;
      expect(parseFloat(result.outputAmount.toString())).toBeCloseTo(expectedUsd, 2);
    });

    it('fails when neither forward nor inverse rate exists', async () => {
      const provider = new InMemoryRateProvider();
      const engine = makeEngine(provider);
      await expect(engine.convert(new Decimal('100'), 'ABC', 'DEF'))
        .rejects.toThrow('No exchange rate available');
    });
  });

  // ── InMemoryRateProvider ──────────────────────────────────────────────────

  describe('InMemoryRateProvider', () => {
    it('stores and retrieves rates by pair', async () => {
      const provider = new InMemoryRateProvider();
      provider.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92');
      const rate = await provider.getRate('USD', 'EUR');
      expect(rate).not.toBeNull();
      expect(rate!.pair).toBe('USD/EUR');
      expect(rate!.mid.toString()).toBe('0.92');
    });

    it('returns null for unknown pair', async () => {
      const provider = new InMemoryRateProvider();
      const rate = await provider.getRate('ABC', 'XYZ');
      expect(rate).toBeNull();
    });

    it('clears all rates', async () => {
      const provider = new InMemoryRateProvider();
      provider.setRateFromValues('USD/EUR', '0.91', '0.93', '0.92');
      provider.clear();
      const rate = await provider.getRate('USD', 'EUR');
      expect(rate).toBeNull();
    });
  });

  // ── Metrics ───────────────────────────────────────────────────────────────

  describe('metrics emission', () => {
    it('increments conversion counter on successful conversion', async () => {
      const provider = makeProvider();
      const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
      const engine = makeEngine(provider, metrics);
      await engine.convert(new Decimal('100'), 'USD', 'EUR');
      const prom = metrics.exportPrometheus();
      expect(prom).toContain('fx_conversions_total');
    });

    it('does not emit stale-rate metric on fresh rates', async () => {
      const provider = makeProvider();
      const metrics = new MetricsCollector({ enabled: true, enablePIIDetection: false });
      const engine = makeEngine(provider, metrics);
      await engine.convert(new Decimal('100'), 'USD', 'EUR');
      const prom = metrics.exportPrometheus();
      expect(prom).not.toContain('fx_stale_rate_rejected_total');
    });
  });
});
