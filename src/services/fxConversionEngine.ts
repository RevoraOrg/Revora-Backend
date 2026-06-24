import { Decimal } from '../lib/decimal';
import { Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';

export type ConversionPathType = 'direct' | 'inverse' | 'triangulated';

export interface ConversionPath {
  type: ConversionPathType;
  description: string;
}

export interface ExchangeRate {
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

const METRIC_STALE_RATE_REJECTED = 'fx_stale_rate_rejected_total';
const METRIC_CONVERSIONS_TOTAL = 'fx_conversions_total';
const METRIC_TRIANGULATIONS_TOTAL = 'fx_triangulations_total';

export class FxConversionEngine {
  private readonly defaultBucketIncrement: Decimal;
  private readonly metrics?: MetricsCollector;

  constructor(
    private readonly rateProvider: RateProvider,
    options?: {
      defaultBucketIncrement?: string;
      metrics?: MetricsCollector;
    }
  ) {
    this.defaultBucketIncrement = new Decimal(options?.defaultBucketIncrement ?? '0.01');
    this.metrics = options?.metrics;
  }

  async convert(
    amount: Decimal,
    from: string,
    to: string,
    options?: {
      bucketIncrement?: Decimal;
      side?: 'bid' | 'ask' | 'mid';
      maxRateAgeMs?: number;
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
    if (this.isRateStale(rate, maxAge)) {
      this.metrics?.incrementCounter(METRIC_STALE_RATE_REJECTED, { pair: rate.pair });
      throw Errors.serviceUnavailable(
        `Exchange rate for ${rate.pair} is stale (age: ${this.rateAgeMs(rate)}ms, max: ${maxAge}ms)`,
        { pair: rate.pair, ageMs: this.rateAgeMs(rate), maxAgeMs: maxAge }
      );
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
    ttlMs: number = 300000
  ): void {
    const now = new Date();
    this.rates.set(pair, {
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
    ttlMs: number = 300000
  ): void {
    this.rates.set(pair, {
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
