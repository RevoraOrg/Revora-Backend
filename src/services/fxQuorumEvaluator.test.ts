/**
 * Tests for the FX Quorum / Variance Guard (FxQuorumEvaluator, FxQuorumFailedError,
 * FxQuorumAlerting).
 *
 * Coverage targets:
 * - Quorum satisfied returns aggregated consensus rate (median bid/ask/mid)
 * - Divergence beyond tolerance blocks the run + page + metric + audit
 * - Single provider outage still meets quorum when N-1 within tolerance
 * - Total outage (all null) blocks
 * - k > n / k > valid rateability blocked
 * - tolerance = 0 requiring exact agreement
 * - median vs mean reference behaviour
 * - config validation (k, tolerance, reference)
 * - allowReducedQuorum flag semantics
 * - metric emissions (evaluated / passed / failed / in-consensus / divergence)
 * - pager invoked with divergent rates; pager exceptions never crash caller
 * - FxQuorumAlerting: pages ops and writes audit event (incl. divergent rates)
 * - assess() is non-throwing; evaluate() throws FxQuorumFailedError
 * - provider-id / pair sanitisation for labels
 */

import { Decimal } from '../lib/decimal';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';
import { SecurityAuditRepository } from '../security/types';
import { ExchangeRate } from './fxConversionEngine';
import {
  FxQuorumEvaluator,
  FxQuorumFailedError,
  FxQuorumAlerting,
  METRIC_QUORUM_EVALUATED,
  METRIC_QUORUM_PASSED,
  METRIC_QUORUM_FAILED,
  METRIC_QUORUM_IN_CONSENSUS,
  METRIC_QUORUM_DIVERGENCE,
  FxQuorumProviderInput,
} from './fxQuorumEvaluator';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRate(mid: string, opts: { bid?: string; ask?: string; ageMs?: number; ttlMs?: number } = {}): ExchangeRate {
  const m = new Decimal(mid);
  return {
    pair: 'USD/EUR',
    bid: new Decimal(opts.bid ?? mid),
    ask: new Decimal(opts.ask ?? mid),
    mid: m,
    timestamp: new Date(Date.now() - (opts.ageMs ?? 0)),
    ttlMs: opts.ttlMs ?? 300_000,
  };
}

function makeMetrics(): MetricsCollector {
  return new MetricsCollector({ enabled: true, enablePIIDetection: false });
}

function makeLogger(): Logger {
  return new Logger();
}

/** Sum the values of a metric across all label dimensions in the export. */
function countMetric(prom: string, name: string): number {
  const re = new RegExp(`^${name}(\\{|\\s)`, 'm');
  const lines = prom.split('\n').filter((l) => re.test(l) && !l.startsWith('#'));
  if (lines.length === 0) return 0;
  return lines.reduce((acc, l) => {
    // Prometheus data line format: name{labels} value timestamp
    const value = parseFloat(l.trim().split(/\s+/)[1] ?? '0');
    return acc + (Number.isNaN(value) ? 0 : value);
  }, 0);
}

/** Numeric comparison helper (Decimal.toString may pad to 18 decimals). */
function mid(rate: ExchangeRate): number {
  return parseFloat(rate.mid.toString());
}

// ─── Construction / config validation ─────────────────────────────────────────

describe('FxQuorumEvaluator construction', () => {
  it('throws when k < 1', () => {
    expect(() => new FxQuorumEvaluator({ k: 0, tolerance: 0.01 })).toThrow(/k must be an integer/);
  });

  it('throws when k is not an integer', () => {
    expect(() => new FxQuorumEvaluator({ k: 1.5, tolerance: 0.01 })).toThrow(/k must be an integer/);
  });

  it('throws when tolerance is negative', () => {
    expect(() => new FxQuorumEvaluator({ k: 2, tolerance: -0.01 })).toThrow(/tolerance/);
  });

  it('throws when tolerance is NaN/Infinity', () => {
    expect(() => new FxQuorumEvaluator({ k: 2, tolerance: NaN })).toThrow(/tolerance/);
    expect(() => new FxQuorumEvaluator({ k: 2, tolerance: Infinity })).toThrow(/tolerance/);
  });

  it('throws when reference is invalid', () => {
    expect(() => new FxQuorumEvaluator({ k: 2, tolerance: 0.01, reference: 'mode' as any })).toThrow(/reference/);
  });

  it('accepts a valid config and exposes it via getConfig()', () => {
    const e = new FxQuorumEvaluator({ k: 3, tolerance: 0.01, reference: 'mean', minValidProviders: 3, allowReducedQuorum: false });
    expect(e.getConfig()).toEqual({ k: 3, tolerance: 0.01, reference: 'mean', minValidProviders: 3, allowReducedQuorum: false });
  });
});

// ─── Quorum satisfied ─────────────────────────────────────────────────────────

describe('FxQuorumEvaluator: quorum satisfied', () => {
  const cfg = { k: 2, tolerance: 0.005 };

  it('returns the aggregated consensus rate when providers agree', () => {
    const e = new FxQuorumEvaluator(cfg, { metrics: makeMetrics(), logger: makeLogger() });
    const inputs: FxQuorumProviderInput[] = [
      { providerId: 'prime', rate: makeRate('1.0000') },
      { providerId: 'backup', rate: makeRate('1.0005') },
      { providerId: 'fix', rate: makeRate('1.0010') },
    ];
    const rate = e.evaluate('USD/EUR', inputs);
    // median of [1.0000, 1.0005, 1.0010] = 1.0005
    expect(rate.mid.toString()).toBe('1.0005');
    expect(rate.bid.toString()).toBe('1.0005');
    expect(rate.ask.toString()).toBe('1.0005');
  });

  it('assess() reports agreement without throwing', () => {
    const e = new FxQuorumEvaluator(cfg);
    const r = e.assess('USD/EUR', [
      { providerId: 'a', rate: makeRate('2.0000') },
      { providerId: 'b', rate: makeRate('2.0001') },
    ]);
    expect(r.agreed).toBe(true);
    expect(r.inConsensus).toBe(2);
    expect(r.valid).toBe(2);
    expect(r.total).toBe(2);
  });

  it('emits evaluated + passed counters and an in-consensus gauge', () => {
    const metrics = makeMetrics();
    const e = new FxQuorumEvaluator(cfg, { metrics });
    e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0') },
      { providerId: 'b', rate: makeRate('1.0') },
    ]);
    const prom = metrics.exportPrometheus();
    expect(countMetric(prom, METRIC_QUORUM_EVALUATED)).toBeGreaterThanOrEqual(1);
    expect(countMetric(prom, METRIC_QUORUM_PASSED)).toBeGreaterThanOrEqual(1);
    expect(countMetric(prom, METRIC_QUORUM_FAILED)).toBe(0);
    expect(countMetric(prom, METRIC_QUORUM_IN_CONSENSUS)).toBeGreaterThanOrEqual(2);
  });
});

// ─── Divergence / blocking ────────────────────────────────────────────────────

describe('FxQuorumEvaluator: divergence blocks the run', () => {
  const cfg = { k: 2, tolerance: 0.005 };

  it('throws FxQuorumFailedError when providers diverge beyond tolerance', () => {
    const e = new FxQuorumEvaluator(cfg);
    const inputs: FxQuorumProviderInput[] = [
      { providerId: 'prime', rate: makeRate('1.0000') },
      { providerId: 'backup', rate: makeRate('1.0500') }, // +5% -> out of 0.5% tol
    ];
    expect(() => e.evaluate('USD/EUR', inputs)).toThrow(FxQuorumFailedError);
  });

  it('the thrown error carries divergent rates and is a 503', () => {
    const e = new FxQuorumEvaluator(cfg);
    try {
      // Two providers, both outside the 0.5% tolerance of each other -> quorum fails.
      e.evaluate('USD/EUR', [
        { providerId: 'prime', rate: makeRate('1.0000') },
        { providerId: 'rogue', rate: makeRate('1.2000') },
      ]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FxQuorumFailedError);
      const fe = err as FxQuorumFailedError;
      expect(fe.statusCode).toBe(503);
      expect(fe.code).toBe('SERVICE_UNAVAILABLE');
      expect(fe.details.agreed).toBe(false);
      expect(fe.details.inConsensus).toBe(0); // neither within tolerance of the median
      expect(fe.details.k).toBe(2);
      expect(fe.details.divergent.map((d) => d.providerId).sort()).toEqual(['prime', 'rogue']);
      const rogue = fe.details.divergent.find((d) => d.providerId === 'rogue')!;
      expect(rogue.value).toBe('1.2000');
      expect(rogue.deviation).toBeGreaterThan(0.005);
    }
  });

  it('emits fx_quorum_failed_total and a divergence gauge', () => {
    const metrics = makeMetrics();
    const e = new FxQuorumEvaluator(cfg, { metrics });
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.1000') },
    ])).toThrow(FxQuorumFailedError);
    const prom = metrics.exportPrometheus();
    expect(countMetric(prom, METRIC_QUORUM_FAILED)).toBeGreaterThanOrEqual(1);
    expect(countMetric(prom, METRIC_QUORUM_PASSED)).toBe(0);
    expect(countMetric(prom, METRIC_QUORUM_DIVERGENCE)).toBeGreaterThan(0);
  });

  it('pages ops with divergent rates on failure', () => {
    const paged: any[] = [];
    const e = new FxQuorumEvaluator(cfg, { pager: (f) => { paged.push(f); } });
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.2') },
    ])).toThrow(FxQuorumFailedError);
    expect(paged).toHaveLength(1);
    expect(paged[0].agreed).toBe(false);
    expect(paged[0].divergent.map((d: any) => d.providerId)).toContain('b');
  });

  it('a throwing pager never crashes the caller (failure still thrown)', () => {
    const e = new FxQuorumEvaluator(cfg, {
      pager: () => { throw new Error('pager down'); },
    });
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.2') },
    ])).toThrow(FxQuorumFailedError);
  });

  it('a rejecting (async) pager is swallowed', async () => {
    const e = new FxQuorumEvaluator(cfg, {
      pager: async () => { throw new Error('async pager down'); },
    });
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.2') },
    ])).toThrow(FxQuorumFailedError);
    // allow the fire-and-forget promise to settle
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('FxQuorumEvaluator: edge cases', () => {
  it('SINGLE PROVIDER OUTAGE still meets quorum if N-1 within tolerance', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005 });
    const rate = e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.0005') }, // 0.05% off -> in tolerance
      { providerId: 'c', rate: null },              // outage
    ]);
    // median of the two valid mids [1.0000, 1.0005] = 1.00025
    expect(mid(rate)).toBeCloseTo(1.00025, 6);
  });

  it('outage + remaining divergence does NOT meet quorum (correctly blocked)', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005 });
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.1000') }, // 10% off
      { providerId: 'c', rate: null },
    ])).toThrow(FxQuorumFailedError);
  });

  it('TOTAL outage (all null) blocks the run', () => {
    const paged: any[] = [];
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005 }, { pager: (f) => { paged.push(f); } });
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'a', rate: null },
      { providerId: 'b', rate: null },
    ])).toThrow(FxQuorumFailedError);
    expect(paged[0].valid).toBe(0);
    expect(paged[0].inConsensus).toBe(0);
  });

  it('k > number of valid providers blocks (misconfiguration surfaced)', () => {
    const e = new FxQuorumEvaluator({ k: 3, tolerance: 0.005 });
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.0001') },
    ])).toThrow(FxQuorumFailedError);
  });

  it('tolerance = 0 requires exact agreement; a single mismatch fails', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0 });
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.0001') },
    ])).toThrow(FxQuorumFailedError);
    // identical rates pass at tolerance 0
    const ok = new FxQuorumEvaluator({ k: 2, tolerance: 0 });
    expect(() => ok.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.0000') },
    ])).not.toThrow();
  });

  it('minValidProviders floor blocks when too many providers are down', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005, minValidProviders: 3 });
    // 2 valid & in-consensus, but minValidProviders=3 -> blocked
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.0001') },
      { providerId: 'c', rate: null },
    ])).toThrow(FxQuorumFailedError);
  });

  it('median reference ignores a lone outlier (k=2 of 3 agree)', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005, reference: 'median' });
    const rate = e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.0001') },
      { providerId: 'c', rate: makeRate('1.2000') }, // lone outlier, ignored by median
    ]);
    // in-consensus = {a, b}; consensus mid = median of [1.0000, 1.0001] = 1.00005
    expect(mid(rate)).toBeCloseTo(1.00005, 6);
  });

  it('mean reference can fail where median passes (reference matters)', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.02, reference: 'mean' });
    // mean of [1, 1, 1.1] = 1.0333 -> deviations of the two '1's ~3.2% > 2%
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('1.0000') },
      { providerId: 'b', rate: makeRate('1.0000') },
      { providerId: 'c', rate: makeRate('1.1000') },
    ])).toThrow(FxQuorumFailedError);
  });

  it('allowReducedQuorum=true trusts a single configured provider', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005, allowReducedQuorum: true });
    const rate = e.evaluate('USD/EUR', [{ providerId: 'only', rate: makeRate('1.2345') }]);
    expect(rate.mid.toString()).toBe('1.2345');
  });

  it('allowReducedQuorum=false blocks when quorum is impossible with one provider', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005, allowReducedQuorum: false });
    expect(() => e.evaluate('USD/EUR', [{ providerId: 'only', rate: makeRate('1.2345') }]))
      .toThrow(FxQuorumFailedError);
  });

  it('aggregates bid/ask/mid medians and takes the most-recent timestamp / smallest ttl', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005 });
    const older = makeRate('1.0000', { bid: '0.9990', ask: '1.0010', ageMs: 5000, ttlMs: 300_000 });
    const newer = makeRate('1.0002', { bid: '0.9992', ask: '1.0012', ageMs: 1000, ttlMs: 120_000 });
    const rate = e.evaluate('USD/EUR', [
      { providerId: 'a', rate: older },
      { providerId: 'b', rate: newer },
    ]);
    expect(parseFloat(rate.bid.toString())).toBeCloseTo(0.9991, 6); // median of 0.9990, 0.9992
    expect(parseFloat(rate.ask.toString())).toBeCloseTo(1.0011, 6); // median of 1.0010, 1.0012
    expect(rate.timestamp.getTime()).toBe(newer.timestamp.getTime());
    expect(rate.ttlMs).toBe(120_000);
  });

  it('handles a zero reference (all providers quote 0) without NaN/Infinity blowing up', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005 });
    // both zero -> reference 0, both value.isZero() -> deviation 0 -> in consensus
    const rate = e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('0') },
      { providerId: 'b', rate: makeRate('0') },
    ]);
    expect(mid(rate)).toBe(0);
  });

  it('a non-zero quote against a zero median reference is flagged divergent (Infinity) but zero quotes still reach quorum', () => {
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005 });
    // median of [0, 0, 1.0] is 0; the '1.0' quote is divergent (Infinity) but the
    // two zero quotes are in consensus, so quorum is still met with consensus mid 0.
    const rate = e.evaluate('USD/EUR', [
      { providerId: 'a', rate: makeRate('0') },
      { providerId: 'b', rate: makeRate('0') },
      { providerId: 'c', rate: makeRate('1.0000') },
    ]);
    expect(mid(rate)).toBe(0);
  });
});

// ─── Security: sanitisation ───────────────────────────────────────────────────

describe('FxQuorumEvaluator: label sanitisation', () => {
  it('sanitises provider ids and pairs used in metric labels', () => {
    const metrics = makeMetrics();
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005 }, { metrics });
    expect(() => e.evaluate('USD/EUR', [
      { providerId: 'evil"provider', rate: makeRate('1.0000') },
      { providerId: 'normal.prov', rate: makeRate('1.2') },
    ])).toThrow(FxQuorumFailedError);
    const prom = metrics.exportPrometheus();
    // pair slash sanitised to underscore; quotes stripped
    expect(prom).toContain('USD_EUR');
    expect(prom).not.toContain('USD/EUR');
  });
});

// ─── FxQuorumAlerting (pager + audit) ─────────────────────────────────────────

describe('FxQuorumAlerting', () => {
  it('pages ops and writes an audit event including divergent rates', async () => {
    const paged: any[] = [];
    const auditEvents: any[] = [];
    const auditRepo: SecurityAuditRepository = {
      record: async (e) => { auditEvents.push(e); },
      findByUserId: async () => [],
      findBySessionId: async () => [],
      findSecurityViolations: async () => [],
    };

    const alerting = new FxQuorumAlerting(
      (f) => { paged.push(f); },
      auditRepo,
      { tenantId: 't-1', actorId: 'ops-7' },
    );

    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005 }, { pager: (f) => alerting.handle(f) });
    try {
      e.evaluate('USD/EUR', [
        { providerId: 'a', rate: makeRate('1.0000') },
        { providerId: 'b', rate: makeRate('1.2') },
      ]);
    } catch { /* expected */ }

    // handler is async; give it a tick
    await new Promise((r) => setTimeout(r, 10));

    expect(paged).toHaveLength(1);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].type).toBe('SECURITY_VIOLATION');
    expect(auditEvents[0].outcome).toBe('BLOCKED');
    expect(auditEvents[0].action).toBe('fx_quorum_failed');
    expect(auditEvents[0].userId).toBe('ops-7');
    expect(auditEvents[0].details.tenant_id).toBe('t-1');
    expect(auditEvents[0].details.divergent.map((d: any) => d.providerId)).toContain('b');
  });

  it('writes no audit event when no auditRepo is supplied (page only)', async () => {
    const paged: any[] = [];
    const alerting = new FxQuorumAlerting((f) => { paged.push(f); });
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005 }, { pager: (f) => alerting.handle(f) });
    try {
      e.evaluate('USD/EUR', [
        { providerId: 'a', rate: makeRate('1.0000') },
        { providerId: 'b', rate: makeRate('1.2') },
      ]);
    } catch { /* expected */ }
    await new Promise((r) => setTimeout(r, 10));
    expect(paged).toHaveLength(1);
  });

  it('survives a throwing pageOps and still records the audit event', async () => {
    const auditEvents: any[] = [];
    const auditRepo: SecurityAuditRepository = {
      record: async (e) => { auditEvents.push(e); },
      findByUserId: async () => [],
      findBySessionId: async () => [],
      findSecurityViolations: async () => [],
    };
    const alerting = new FxQuorumAlerting(
      () => { throw new Error('pager boom'); },
      auditRepo,
      { tenantId: 't-1' },
    );
    const e = new FxQuorumEvaluator({ k: 2, tolerance: 0.005 }, { pager: (f) => alerting.handle(f) });
    try {
      e.evaluate('USD/EUR', [
        { providerId: 'a', rate: makeRate('1.0000') },
        { providerId: 'b', rate: makeRate('1.2') },
      ]);
    } catch { /* expected */ }
    await new Promise((r) => setTimeout(r, 10));
    // Audit write must still happen even though paging failed.
    expect(auditEvents).toHaveLength(1);
  });
});
