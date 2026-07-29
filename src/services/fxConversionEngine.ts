import { Decimal } from '../lib/decimal';
import { Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';
import { SecurityAuditRepository } from '../security/types';

export type ConversionPathType = 'direct' | 'inverse' | 'triangulated';

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

export interface FxConversionResult {
  inputAmount: Decimal;
  inputCurrency: string;
  outputAmount: Decimal;
  outputCurrency: string;
  rate: ExchangeRate;
  path: ConversionPath;
  roundedToIncrement: boolean;
}

export interface RateProvider {
  getRate(from: string, to: string): Promise<ExchangeRate | null>;
}

export enum FxFallbackReason {
  STALE_RATE_TOLERATED = 'STALE_RATE_TOLERATED',
  SUBSTITUTE_PROVIDER_USED = 'SUBSTITUTE_PROVIDER_USED'
}

const METRIC_STALE_RATE_REJECTED = 'fx_stale_rate_rejected_total';
const METRIC_CONVERSIONS_TOTAL = 'fx_conversions_total';
const METRIC_TRIANGULATIONS_TOTAL = 'fx_triangulations_total';
const METRIC_STALE_FALLBACK_STALENESS = 'fx_stale_fallback_staleness_ms';

export class FxConversionEngine {
  private readonly defaultBucketIncrement: Decimal;
  private readonly metrics?: MetricsCollector;
  private readonly auditRepository?: SecurityAuditRepository;
  private readonly fallbackRateProvider?: RateProvider;

  constructor(
    private readonly rateProvider: RateProvider,
    options?: {
      defaultBucketIncrement?: string;
      metrics?: MetricsCollector;
      auditRepository?: SecurityAuditRepository;
      fallbackRateProvider?: RateProvider;
    }
  ) {
    this.defaultBucketIncrement = new Decimal(options?.defaultBucketIncrement ?? '0.01');
    this.metrics = options?.metrics;
    this.auditRepository = options?.auditRepository;
    this.fallbackRateProvider = options?.fallbackRateProvider;
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
    }
  ): Promise<FxConversionResult> {
    if (amount.isZero()) {
      throw Errors.badRequest('Cannot convert zero amount', { from, to });
    }
    if (amount.isNegative()) {
      throw Errors.badRequest('Cannot convert negative amount', { from, to });
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
      };
    }

    const pair = `${from}/${to}`;
    const inversePair = `${to}/${from}`;

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

    const maxAge = options?.maxRateAgeMs ?? 300000;
    
    let isStale = this.isRateStale(rate, maxAge);
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
        rate = fRate;
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
      this.metrics?.incrementCounter(METRIC_STALE_RATE_REJECTED, { pair: rate.pair });
      throw Errors.serviceUnavailable(
        `Exchange rate for ${rate.pair} is stale (age: ${this.rateAgeMs(rate)}ms, max: ${maxAge}ms)`,
        { pair: rate.pair, ageMs: this.rateAgeMs(rate), maxAgeMs: maxAge }
      );
    }

    if (fallbackUsed && fallbackReason) {
      const maxStalenessObserved = this.rateAgeMs(rate);
      
      // Emit gauge
      this.metrics?.recordGauge(METRIC_STALE_FALLBACK_STALENESS, maxStalenessObserved, { reason: fallbackReason });
      
      // Append to audit chain
      if (this.auditRepository) {
        await this.auditRepository.record({
          id: `fx_fallback_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          type: 'VALIDATION',
          userId: options?.auditUserId,
          sessionId: options?.auditSessionId,
          action: 'FX_STALE_RATE_FALLBACK',
          resource: 'FxConversionEngine',
          outcome: 'SUCCESS',
          details: {
            reason: fallbackReason,
            substituteRateId: rate.id || rate.pair,
            maxStalenessObserved,
            pair: rate.pair
          },
          securityContext: {
            requestId: 'fx-conversion',
            ipAddress: 'internal',
            userAgent: 'fxConversionEngine',
            timestamp: new Date()
          },
          timestamp: new Date()
        });
      }
    }

    const effectiveRate = this.resolveSide(rate, options?.side ?? 'mid');

    const rawOutput = amount.multiply(effectiveRate);

    const bucketInc = options?.bucketIncrement ?? this.defaultBucketIncrement;
    const outputAmount = this.roundToBucketIncrement(rawOutput, bucketInc);
    const rounded = outputAmount.toString() !== rawOutput.toString();

    this.metrics?.incrementCounter(METRIC_CONVERSIONS_TOTAL, {
      from,
      to,
      side: options?.side ?? 'mid',
    });

    return {
      inputAmount: amount,
      inputCurrency: from,
      outputAmount,
      outputCurrency: to,
      rate,
      path: { type: 'direct', description: `${from}/${to}` },
      roundedToIncrement: rounded,
    };
  }

  async triangulate(
    amount: Decimal,
    from: string,
    to: string,
    baseCurrency: string,
    options?: {
      bucketIncrement?: Decimal;
      side?: 'bid' | 'ask' | 'mid';
      maxRateAgeMs?: number;
    }
  ): Promise<FxConversionResult> {
    if (from === baseCurrency || to === baseCurrency) {
      return this.convert(amount, from, to, options);
    }

    const leg1 = await this.convert(amount, from, baseCurrency, {
      ...options,
      bucketIncrement: undefined,
    });

    const leg2 = await this.convert(leg1.outputAmount, baseCurrency, to, options);

    this.metrics?.incrementCounter(METRIC_TRIANGULATIONS_TOTAL, {
      from,
      to,
      baseCurrency,
    });

    const combinedRate = leg2.outputAmount.divide(amount);

    return {
      inputAmount: amount,
      inputCurrency: from,
      outputAmount: leg2.outputAmount,
      outputCurrency: to,
      rate: {
        pair: `${from}/${to} (via ${baseCurrency})`,
        bid: combinedRate,
        ask: combinedRate,
        mid: combinedRate,
        timestamp: new Date(),
        ttlMs: Math.min(leg1.rate.ttlMs, leg2.rate.ttlMs),
      },
      path: {
        type: 'triangulated',
        description: `${from}→${baseCurrency}→${to}`,
      },
      roundedToIncrement: leg1.roundedToIncrement || leg2.roundedToIncrement,
    };
  }

  roundToBucketIncrement(amount: Decimal, increment: Decimal): Decimal {
    if (increment.isZero() || increment.isNegative()) {
      throw Errors.badRequest('Bucket increment must be positive', { increment: increment.toString() });
    }

    const amountStr = amount.toString();
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
