/**
 * Event-loop lag monitor with sampling profile and capacity saturation alerts.
 *
 * Measures scheduling delay (time between intended and actual execution)
 * and raises alerts when lag exceeds configured thresholds.
 */
import { logger } from '../logging';

/** A single lag measurement. */
export interface LagSample {
  timestamp: number;
  intendedAt: number;
  actualAt: number;
  lagMs: number;
}

/** Configuration for lag sampling behaviour. */
export interface SamplingProfile {
  /** Max samples to retain. */
  windowSize: number;
  /** How often to sample (seconds). */
  sampleIntervalS: number;
  /** Lag threshold for warning alert (ms). */
  alertThresholdMs: number;
  /** Lag threshold for critical alert (ms). */
  criticalThresholdMs: number;
  /** Lag threshold for saturation alarm (ms). */
  saturationThresholdMs: number;
  /** Consecutive high-lag samples before alert fires. */
  maxConsecutiveDegraded: number;
}

export const DEFAULT_PROFILE: SamplingProfile = {
  windowSize: 100,
  sampleIntervalS: 1.0,
  alertThresholdMs: 100,
  criticalThresholdMs: 500,
  saturationThresholdMs: 1000,
  maxConsecutiveDegraded: 5,
};

/** Aggregated statistics from lag samples. */
export interface LagStats {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  degradedCount: number;
  criticalCount: number;
  saturationCount: number;
}

export type AlertCallback = (stats: LagStats) => void;

/**
 * Monitors event-loop lag with configurable sampling and alerting.
 *
 * @example
 * ```typescript
 * const monitor = new EventLoopLagMonitor();
 * monitor.start();
 *
 * // In your event loop:
 * monitor.record();
 *
 * // Check stats periodically:
 * const stats = monitor.getStats();
 * if (stats.p95Ms > 100) {
 *   logger.warn('Event loop lag: p95=%.1fms', stats.p95Ms);
 * }
 * ```
 */
export class EventLoopLagMonitor {
  private readonly profile: SamplingProfile;
  private samples: LagSample[] = [];
  private lastSampleAt: number = 0;
  private consecutiveDegraded: number = 0;
  private running: boolean = false;
  private readonly onWarning?: AlertCallback;
  private readonly onCritical?: AlertCallback;
  private readonly onSaturation?: AlertCallback;

  constructor(
    profile: Partial<SamplingProfile> = {},
    callbacks?: {
      onWarning?: AlertCallback;
      onCritical?: AlertCallback;
      onSaturation?: AlertCallback;
    }
  ) {
    this.profile = { ...DEFAULT_PROFILE, ...profile };
    this.onWarning = callbacks?.onWarning;
    this.onCritical = callbacks?.onCritical;
    this.onSaturation = callbacks?.onSaturation;
  }

  /** Begin monitoring (clears any previous samples). */
  start(): void {
    this.samples = [];
    this.consecutiveDegraded = 0;
    this.lastSampleAt = Date.now();
    this.running = true;
  }

  /** Stop monitoring. */
  stop(): void {
    this.running = false;
  }

  /**
   * Record a lag measurement.
   * Call this from your event loop iteration.
   */
  record(intendedAt?: number): LagSample | null {
    if (!this.running) return null;

    const now = Date.now();
    const intended = intendedAt ?? this.lastSampleAt + this.profile.sampleIntervalS * 1000;
    const effectiveIntended = Math.min(intended, now);

    const lag = now - effectiveIntended;
    const sample: LagSample = {
      timestamp: now,
      intendedAt: effectiveIntended,
      actualAt: now,
      lagMs: Math.max(0, lag),
    };

    this.samples.push(sample);
    if (this.samples.length > this.profile.windowSize) {
      this.samples.shift();
    }
    this.lastSampleAt = now;

    this.evaluateAlerts(sample);
    return sample;
  }

  private evaluateAlerts(sample: LagSample): void {
    if (sample.lagMs > this.profile.alertThresholdMs) {
      this.consecutiveDegraded++;
    } else {
      this.consecutiveDegraded = 0;
      return;
    }

    if (this.consecutiveDegraded < this.profile.maxConsecutiveDegraded) return;

    const stats = this.computeStats();

    if (sample.lagMs > this.profile.saturationThresholdMs && this.onSaturation) {
      this.onSaturation(stats);
    } else if (sample.lagMs > this.profile.criticalThresholdMs && this.onCritical) {
      this.onCritical(stats);
    } else if (this.onWarning) {
      this.onWarning(stats);
    }
  }

  /** Return aggregated statistics from collected samples. */
  getStats(): LagStats {
    return this.computeStats();
  }

  private computeStats(): LagStats {
    if (this.samples.length === 0) {
      return {
        count: 0, minMs: 0, maxMs: 0, avgMs: 0,
        p50Ms: 0, p95Ms: 0, p99Ms: 0,
        degradedCount: 0, criticalCount: 0, saturationCount: 0,
      };
    }

    const lags = this.samples.map(s => s.lagMs).sort((a, b) => a - b);
    const n = lags.length;

    const percentile = (pct: number): number => {
      const idx = Math.min(Math.floor(n * pct / 100), n - 1);
      return lags[idx];
    };

    const { alertThresholdMs, criticalThresholdMs, saturationThresholdMs } = this.profile;

    return {
      count: n,
      minMs: lags[0],
      maxMs: lags[n - 1],
      avgMs: lags.reduce((s, v) => s + v, 0) / n,
      p50Ms: percentile(50),
      p95Ms: percentile(95),
      p99Ms: percentile(99),
      degradedCount: lags.filter(v => v > alertThresholdMs).length,
      criticalCount: lags.filter(v => v > criticalThresholdMs).length,
      saturationCount: lags.filter(v => v > saturationThresholdMs).length,
    };
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  get isDegraded(): boolean {
    return this.consecutiveDegraded >= this.profile.maxConsecutiveDegraded;
  }

  /** Clear all samples and reset degradation counter. */
  reset(): void {
    this.samples = [];
    this.consecutiveDegraded = 0;
  }
}

/** Default warning callback: logs at WARN level. */
export function defaultWarningCallback(stats: LagStats): void {
  logger.warn(
    'Event-loop lag WARNING: p95=%.1fms, max=%.1fms, degraded=%d/%d samples',
    stats.p95Ms, stats.maxMs, stats.degradedCount, stats.count
  );
}

/** Default critical callback: logs at ERROR level. */
export function defaultCriticalCallback(stats: LagStats): void {
  logger.error(
    'Event-loop lag CRITICAL: p95=%.1fms, p99=%.1fms, max=%.1fms',
    stats.p95Ms, stats.p99Ms, stats.maxMs
  );
}

/** Default saturation callback: logs at CRITICAL level with alarm phrasing. */
export function defaultSaturationCallback(stats: LagStats): void {
  logger.critical(
    'Event-loop SATURATION ALARM: avg=%.1fms, p99=%.1fms, saturation_count=%d',
    stats.avgMs, stats.p99Ms, stats.saturationCount
  );
}
