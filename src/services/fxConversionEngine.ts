import { randomUUID } from 'crypto';
import { Decimal } from '../lib/decimal';
import { Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';
import { AuditEvent, SecurityAuditRepository } from '../security/types';

export type ConversionPathType = 'direct' | 'inverse' | 'triangulated';

/**
 * @notice Reasons why a stale rate was tolerated or a fallback was used.
 * @dev    Recorded in audit events so auditors can trace rate provenance.
 */
export enum FxFallbackReason {
  /** The primary rate was fresh enough — no fallback needed. */
  NONE = 'NONE',
  /** A substitute rate provider supplied a fresh rate. */
  SUBSTITUTE_PROVIDER_USED = 'SUBSTITUTE_PROVIDER_USED',
  /** The primary rate was stale but tolerance was enabled. */
  STALE_RATE_TOLERATED = 'STALE_RATE_TOLERATED',
}

export interface ConversionPath {
  type: ConversionPathType;
  description: string;
}

export interface ExchangeRate {
  id?: string;
  pair: string;
  bid: Decimal;
  ask: Decimal;
  mid: Decimal;
  timestamp: Date;
  ttlMs: number;
}

/**
 * @notice A single hop in a triangulation chain.
 * @dev    Per-hop records are attached to FxConversionResult.hops so auditors
 *         can trace the full rate derivation: which provider supplied each rate,
 *         which side (bid/ask/mid) was used, the raw rate value, and whether the
 *         intermediate amount was rounded at that leg.
 */
export interface FxHop {
  /** Source currency of this leg (e.g. "EUR"). */
  from: string;
  /** Destination currency of this leg (e.g. "USD"). */
  to: string;
  /** The effective per-unit rate applied at this leg (mid, bid, or ask). */
  effectiveRate: Decimal;
  /** Which side of the spread was used. */
  side: 'bid' | 'ask' | 'mid';
  /** The ExchangeRate object as returned by the provider for this leg. */
  rawRate: ExchangeRate;
  /** Input amount into this leg. */
  inputAmount: Decimal;
  /** Output amount out of this leg (before final bucket rounding). */
  outputAmount: Decimal;
  /** Whether intermediate rounding was applied at this leg. */
  rounded: boolean;
  /**
   * Zero-based index of this hop in the chain.
   * hop 0 = first leg (from → via), hop 1 = second leg (via → to), etc.
   */
  hopIndex: number;
}

export interface FxConversionResult {
  inputAmount: Decimal;
  inputCurrency: string;
  outputAmount: Decimal;
  outputCurrency: string;
  rate: ExchangeRate;
  path: ConversionPath;
  roundedToIncrement: boolean;
  /**
   * Per-hop audit trail.  Non-empty only for triangulated conversions.
   * Direct/inverse conversions have an empty array.
   */
  hops: FxHop[];
  /**
   * The SHA-256 hash of the Horizon fixture URL used for this conversion.
   * Only populated if a fixture was used.
   */
  fixtureHash?: string;
}

export interface RateProvider {
  getRate(from: string, to: string): Promise<ExchangeRate | null>;
}

const METRIC_STALE_RATE_REJECTED    = 'fx_stale_rate_rejected_total';
const METRIC_CONVERSIONS_TOTAL      = 'fx_conversions_total';
const METRIC_TRIANGULATIONS_TOTAL   = 'fx_triangulations_total';
const METRIC_TRIANGULATION_HOPS     = 'fx_triangulation_hops';
const METRIC_STALE_FALLBACK_STALENESS_MS = 'fx_stale_fallback_staleness_ms';

/** Default maximum number of intermediate hops allowed in a triangulation chain. */
const DEFAULT_MAX_HOPS = 2;

export class FxConversionEngine {
  private readonly defaultBucketIncrement: Decimal;
  private readonly metrics?: MetricsCollector;
  private readonly auditRepository?: SecurityAuditRepository;
  private readonly fallbackRateProvider?: RateProvider;
  /**
   * Maximum number of intermediate hops permitted in a triangulation chain.
   * A two-currency triangulation (A→B→C) has 2 hops.
   * Exceeding this causes an actionable error so operators know which pair to
   * add to the rate provider.
   */
  private readonly maxHops: number;

  constructor(
    private readonly rateProvider: RateProvider,
    options?: {
      defaultBucketIncrement?: string;
      metrics?: MetricsCollector;
      fallbackRateProvider?: RateProvider;
      /**
       * Maximum hops allowed in a triangulation chain (default: 2).
       * Must be a positive integer ≥ 1.
       */
      maxHops?: number;
      /** Optional audit repository for recording rate-fallback events. */
      auditRepository?: SecurityAuditRepository;
    }
  ) {
    this.defaultBucketIncrement = new Decimal(options?.defaultBucketIncrement ?? '0.01');
    this.metrics = options?.metrics;
    this.auditRepository = options?.auditRepository;
    this.fallbackRateProvider = options?.fallbackRateProvider;

    const maxHops = options?.maxHops ?? DEFAULT_MAX_HOPS;
    if (!Number.isInteger(maxHops) || maxHops < 1) {
      throw new Error('maxHops must be a positive integer ≥ 1');
    }
    this.maxHops = maxHops;
  }

  async convert(
    amount: Decimal,
    from: string,
    to: string,
    options?: {
      bucketIncrement?: Decimal;
      side?: 'bid' | 'ask' | 'mid';
      maxRateAgeMs?: number;
      allowStaleFallback?: boolean;
      auditUserId?: string;
      auditSessionId?: string;
      fixtureHash?: string;
      frozenContext?: string;
    }
  ): Promise<FxConversionResult> {
    if (amount.isZero()) {
      throw Errors.badRequest('Cannot convert zero amount', { from, to });
    }
    if (amount.isNegative()) {
      throw Errors.badRequest('Cannot convert negative amount', { from, to });
    }
    if (options?.frozenContext) {
      const frozen = this.getFrozenRate(options.frozenContext);
      if (frozen) {
        const side = options?.side ?? 'mid';
        const effectiveRate = this.resolveSide(frozen, side);
        const rawOutput = amount.multiply(effectiveRate);
        const bucketInc = options?.bucketIncrement ?? this.defaultBucketIncrement;
        const outputAmount = this.roundToBucketIncrement(rawOutput, bucketInc);
        const rounded = outputAmount.toString() !== rawOutput.toString();
        return {
          inputAmount: amount,
          inputCurrency: from,
          outputAmount,
          outputCurrency: to,
          rate: frozen,
          path: { type: 'direct', description: `frozen:${options.frozenContext}` },
          roundedToIncrement: rounded,
          hops: [],
        };
      }
    }
    if (from === to) {
      return {
        inputAmount: amount,
        inputCurrency: from,
        outputAmount: amount,
        outputCurrency: to,
        rate: {
          pair: `${from}/${to}`,
          bid: new Decimal('1'),
          ask: new Decimal('1'),
          mid: new Decimal('1'),
          timestamp: new Date(),
          ttlMs: 0,
        },
        path: { type: 'direct', description: `${from}=${to} (identity)` },
        roundedToIncrement: false,
        hops: [],
      };
    }

    let rate = await this.rateProvider.getRate(from, to);

    if (!rate) {
      rate = await this.rateProvider.getRate(to, from);
      if (rate) {
        rate = this.invertRate(rate);
      }
    }

    if (!rate) {
      throw Errors.serviceUnavailable(
        `No exchange rate available for ${from}/${to}`,
        { from, to }
      );
    }

    let activeRate: ExchangeRate = rate;
    const maxAge = options?.maxRateAgeMs ?? 300000;
    
    let isStale = this.isRateStale(activeRate, maxAge);
    let fallbackUsed = false;
    let fallbackReason: FxFallbackReason | undefined;
    
    // First, try fallback provider if rate is stale and a fallback provider is configured
    if (isStale && this.fallbackRateProvider) {
      let fRate = await this.fallbackRateProvider.getRate(from, to);
      if (!fRate) {
        fRate = await this.fallbackRateProvider.getRate(to, from);
        if (fRate) {
          fRate = this.invertRate(fRate);
        }
      }
      if (fRate && !this.isRateStale(fRate, maxAge)) {
        activeRate = fRate;
        isStale = false;
        fallbackUsed = true;
        fallbackReason = FxFallbackReason.SUBSTITUTE_PROVIDER_USED;
      }
    }
    
    // Next, if still stale, but we allow stale fallbacks on the primary rate
    if (isStale && options?.allowStaleFallback) {
      fallbackUsed = true;
      fallbackReason = FxFallbackReason.STALE_RATE_TOLERATED;
    } else if (isStale) {
      this.metrics?.incrementCounter(METRIC_STALE_RATE_REJECTED, { pair: activeRate.pair });
      throw Errors.serviceUnavailable(
        `Exchange rate for ${activeRate.pair} is stale (age: ${this.rateAgeMs(activeRate)}ms, max: ${maxAge}ms)`,
        { pair: activeRate.pair, ageMs: this.rateAgeMs(activeRate), maxAgeMs: maxAge }
      );
    }

    // Record audit event and metrics when a fallback was used
    if (fallbackUsed && fallbackReason) {
      this.metrics?.recordHistogram(METRIC_STALE_FALLBACK_STALENESS_MS, this.rateAgeMs(rate), { from, to });

      if (this.auditRepository) {
        const auditEvent: AuditEvent = {
          id: randomUUID(),
          type: 'SECURITY_VIOLATION',
          userId: options?.auditUserId ?? 'system',
          action: 'FX_STALE_RATE_FALLBACK',
          resource: `fx_conversion:${from}/${to}`,
          outcome: 'SUCCESS',
          details: {
            pair: `${from}/${to}`,
            reason: fallbackReason,
            substituteRateId: rate.id,
            rateAgeMs: this.rateAgeMs(rate),
            maxAgeMs: maxAge,
          },
          securityContext: {
            requestId: options?.auditSessionId ?? 'fx-conversion-engine',
            ipAddress: '0.0.0.0',
            userAgent: 'fx-conversion-engine/1.0',
            timestamp: new Date(),
          },
          timestamp: new Date(),
        };

        await this.auditRepository.record(auditEvent).catch((err) => {
          // Best-effort: log but don't fail the conversion
          console.error('[FxConversionEngine] Failed to record audit event:', err);
        });
      }
    }

    const side = options?.side ?? 'mid';
    const effectiveRate = this.resolveSide(activeRate, side);
    const rawOutput = amount.multiply(effectiveRate);

    const bucketInc = options?.bucketIncrement ?? this.defaultBucketIncrement;
    const outputAmount = this.roundToBucketIncrement(rawOutput, bucketInc);
    const rounded = outputAmount.toString() !== rawOutput.toString();

    this.metrics?.incrementCounter(METRIC_CONVERSIONS_TOTAL, {
      from,
      to,
      side,
    });

    return {
      inputAmount: amount,
      inputCurrency: from,
      outputAmount,
      outputCurrency: to,
      rate: activeRate,
      path: { type: 'direct', description: `${from}/${to}` },
      roundedToIncrement: rounded,
      hops: [],
      fixtureHash: options?.fixtureHash,
    };
  }

  /**
   * @notice Convert `amount` from `from` to `to` by routing through one or more
   *         intermediate (reference) currencies.
   * @dev    Each intermediate currency is tried in order. The first one for which
   *         both legs are available wins.  If none succeeds, an actionable error
   *         is thrown listing which pairs were missing.
   *
   *         Per-hop provenance is recorded in `FxConversionResult.hops` so
   *         auditors can trace the full derivation.  The `fx_triangulation_hops`
   *         histogram is emitted with the actual hop count.
   *
   * @param amount          Amount in `from` currency.
   * @param from            Source currency code (e.g. "EUR").
   * @param to              Target currency code (e.g. "JPY").
   * @param viaOrVias       A single reference currency or an ordered list of
   *                        candidates.  The first that resolves both legs is used.
   * @param options         Same options as `convert`.
   */
  async triangulate(
    amount: Decimal,
    from: string,
    to: string,
    viaOrVias: string | string[],
    options?: {
      bucketIncrement?: Decimal;
      side?: 'bid' | 'ask' | 'mid';
      maxRateAgeMs?: number;
      fixtureHash?: string;
    }
  ): Promise<FxConversionResult> {
    const vias = Array.isArray(viaOrVias) ? viaOrVias : [viaOrVias];

    // If source or target IS one of the reference currencies, do a direct conversion.
    for (const via of vias) {
      if (from === via || to === via) {
        return this.convert(amount, from, to, options);
      }
    }

    // Enforce hop budget.  Each triangulation uses ONE via currency,
    // which adds 2 legs → 2 hops.  Multiple vias are alternatives,
    // not chained — we try each until one succeeds.
    const hopCount = 2;
    if (hopCount > this.maxHops) {
      throw Errors.badRequest(
        `Triangulation requires ${hopCount} hops but maxHops is ${this.maxHops}. ` +
        `Add a direct rate for ${from}/${to} or increase maxHops.`,
        { from, to, vias, hopCount, maxHops: this.maxHops }
      );
    }

    const side = options?.side ?? 'mid';
    const missingPairs: string[] = [];

    // Try each candidate reference currency in order.
    for (const via of vias) {
      const leg1Result = await this._singleLeg(amount, from, via, side, options);
      if (!leg1Result) {
        missingPairs.push(`${from}/${via}`);
        continue;
      }

      const leg2Result = await this._singleLeg(leg1Result.outputAmount, via, to, side, options);
      if (!leg2Result) {
        missingPairs.push(`${via}/${to}`);
        continue;
      }

      // ── Hop provenance ─────────────────────────────────────────────────────
      const hop0: FxHop = {
        from,
        to: via,
        effectiveRate: this.resolveSide(leg1Result.rate, side),
        side,
        rawRate: leg1Result.rate,
        inputAmount: amount,
        outputAmount: leg1Result.outputAmount,
        rounded: leg1Result.roundedToIncrement,
        hopIndex: 0,
      };

      const hop1: FxHop = {
        from: via,
        to,
        effectiveRate: this.resolveSide(leg2Result.rate, side),
        side,
        rawRate: leg2Result.rate,
        inputAmount: leg1Result.outputAmount,
        outputAmount: leg2Result.outputAmount,
        rounded: leg2Result.roundedToIncrement,
        hopIndex: 1,
      };

      const hops: FxHop[] = [hop0, hop1];
      const actualHopCount = hops.length;

      // ── Metrics ────────────────────────────────────────────────────────────
      this.metrics?.incrementCounter(METRIC_TRIANGULATIONS_TOTAL, { from, to, via });
      this.metrics?.recordHistogram(METRIC_TRIANGULATION_HOPS, actualHopCount, { from, to, via });

      // ── Combined synthetic rate ────────────────────────────────────────────
      const combinedRate = leg2Result.outputAmount.divide(amount);

      return {
        inputAmount: amount,
        inputCurrency: from,
        outputAmount: leg2Result.outputAmount,
        outputCurrency: to,
        rate: {
          pair: `${from}/${to} (via ${via})`,
          bid: combinedRate,
          ask: combinedRate,
          mid: combinedRate,
          timestamp: new Date(),
          ttlMs: Math.min(leg1Result.rate.ttlMs, leg2Result.rate.ttlMs),
        },
        path: {
          type: 'triangulated',
          description: `${from}→${via}→${to}`,
        },
        roundedToIncrement: leg1Result.roundedToIncrement || leg2Result.roundedToIncrement,
        hops,
        fixtureHash: options?.fixtureHash,
      };
    }

    // All candidates exhausted.
    throw Errors.serviceUnavailable(
      `No triangulation path found for ${from}/${to}. ` +
      `Tried via: [${vias.join(', ')}]. Missing pairs: [${missingPairs.join(', ')}]. ` +
      `Add one of these rates to the provider or configure an alternate reference currency.`,
      { from, to, vias, missingPairs }
    );
  }

  /**
   * Attempt a single leg conversion without throwing on missing rates.
   * Returns null if no rate is available, throws on stale rates.
   */
  private async _singleLeg(
    amount: Decimal,
    from: string,
    to: string,
    side: 'bid' | 'ask' | 'mid',
    options?: { bucketIncrement?: Decimal; maxRateAgeMs?: number }
  ): Promise<FxConversionResult | null> {
    try {
      return await this.convert(amount, from, to, { ...options, side, bucketIncrement: undefined });
    } catch (err: unknown) {
      // Surface stale-rate errors — they are operator-actionable.
      if (err instanceof Error && err.message.includes('stale')) throw err;
      // Missing rate → signal to try next candidate.
      return null;
    }
  }

  roundToBucketIncrement(amount: Decimal, increment: Decimal): Decimal {
    if (increment.isZero() || increment.isNegative()) {
      throw Errors.badRequest('Bucket increment must be positive', { increment: increment.toString() });
    }

    const incStr = increment.toString();
    const incParts = incStr.split('.');
    const incDecimalPlaces = incParts[1] ? incParts[1].length : 0;

    const scaledAmount = amount.toSorobanI128(incDecimalPlaces, 'round');
    return Decimal.fromScaledBigInt(scaledAmount, incDecimalPlaces);
  }

  isRateStale(rate: ExchangeRate, maxAgeMs: number): boolean {
    return this.rateAgeMs(rate) > maxAgeMs;
  }

  private rateAgeMs(rate: ExchangeRate): number {
    return Date.now() - rate.timestamp.getTime();
  }

  private invertRate(rate: ExchangeRate): ExchangeRate {
    const one = new Decimal('1');
    return {
      id: rate.id ? `${rate.id}_inv` : undefined,
      pair: this.invertPair(rate.pair),
      bid: one.divide(rate.ask),
      ask: one.divide(rate.bid),
      mid: one.divide(rate.mid),
      timestamp: rate.timestamp,
      ttlMs: rate.ttlMs,
    };
  }

  private invertPair(pair: string): string {
    const parts = pair.split('/');
    if (parts.length !== 2) return pair;
    return `${parts[1]}/${parts[0]}`;
  }

  private resolveSide(rate: ExchangeRate, side: 'bid' | 'ask' | 'mid'): Decimal {
    switch (side) {
      case 'bid': return rate.bid;
      case 'ask': return rate.ask;
      case 'mid': return rate.mid;
    }
  }

  /** Frozen-rate store: context -> ExchangeRate remap. */
  private readonly frozenRates = new Map<string, ExchangeRate>();

  async freezeRate(
    context: string,
    from: string,
    to: string,
    side?: 'bid' | 'ask' | 'mid'
  ): Promise<ExchangeRate> {
    const existing = this.frozenRates.get(context);
    if (existing) {
      this.metrics?.incrementCounter('fx_rate_frozen_reused', { context });
      return existing;
    }
    const result = await this.convert(new Decimal('1'), from, to, { side: side ?? 'mid' });
    const frozen: ExchangeRate = {
      ...result.rate,
      id: result.rate.id ?? 'frozen-' + context + '-' + Date.now(),
    };
    this.frozenRates.set(context, frozen);
    this.metrics?.incrementCounter('fx_rate_frozen_total', { context, from, to, side: side ?? 'mid' });
    return frozen;
  }

  getFrozenRate(context: string): ExchangeRate | null {
    return this.frozenRates.get(context) ?? null;
  }

  setFrozenRate(context: string, rate: ExchangeRate): void {
    this.frozenRates.set(context, rate);
  }

  clearFrozenRate(context: string): void {
    this.frozenRates.delete(context);
  }
}

export class InMemoryRateProvider implements RateProvider {
  private rates = new Map<string, ExchangeRate>();

  setRate(pair: string, rate: ExchangeRate): void {
    this.rates.set(pair, rate);
  }

  setRateFromValues(
    pair: string,
    bid: string,
    ask: string,
    mid: string,
    ttlMs: number = 300000,
    id?: string
  ): void {
    const now = new Date();
    this.rates.set(pair, {
      id,
      pair,
      bid: new Decimal(bid),
      ask: new Decimal(ask),
      mid: new Decimal(mid),
      timestamp: now,
      ttlMs,
    });
  }

  setRateWithTimestamp(
    pair: string,
    bid: string,
    ask: string,
    mid: string,
    timestamp: Date,
    ttlMs: number = 300000,
    id?: string
  ): void {
    this.rates.set(pair, {
      id,
      pair,
      bid: new Decimal(bid),
      ask: new Decimal(ask),
      mid: new Decimal(mid),
      timestamp,
      ttlMs,
    });
  }

  async getRate(from: string, to: string): Promise<ExchangeRate | null> {
    const pair = `${from}/${to}`;
    return this.rates.get(pair) ?? null;
  }

  clear(): void {
    this.rates.clear();
  }
}
