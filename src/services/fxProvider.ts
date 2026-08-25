import { EventEmitter } from 'events';

export interface ProviderSample {
  success: boolean;
  latencyMs: number;
  stalenessMs: number;
  timestamp: number;
}

export interface HealthMetrics {
  successRate: number;
  averageLatencyMs: number;
  staleness: number;
  score: number;
  healthy: boolean;
}

export type ProviderDemotionEvent = {
  providerId: string;
  metrics: HealthMetrics;
  reason: string;
};

export type ProviderPromotionEvent = ProviderDemotionEvent;

export const DEFAULT_OPTIONS = {
  windowSize: 100,
  successWeight: 0.6,
  latencyWeight: 0.2,
  stalenessWeight: 0.2,
  demotionThreshold: 50,
  promotionThreshold: 70,
  recoveryWindowMs: 60000,
  maxLatencyMs: 2000,
  maxStalenessMs: 30000,
};

export class ProviderHealthScorer extends EventEmitter {
  private options = { ...DEFAULT_OPTIONS };
  private samples = new Map<string, ProviderSample[]>();
  private demotedAt = new Map<string, number>();
  private healthy = new Map<string, boolean>();

  constructor(overrides: Partial<typeof DEFAULT_OPTIONS> = {}) {
    super();
    Object.assign(this.options, overrides);
    this.validate();
  }

  private validate() {
    const o = this.options;
    if (o.windowSize <= 0) throw new Error('windowSize must be positive');
    if (o.promotionThreshold <= o.demotionThreshold) throw new Error('promotion threshold must exceed demotion threshold');
    const sum = o.successWeight + o.latencyWeight + o.stalenessWeight;
    if (Math.abs(sum - 1) > 1e-6) throw new Error('weights must sum to 1');
  }

  recordSample(providerId: string, sample: ProviderSample): void {
    const list = this.samples.get(providerId) ?? [];
    list.push(sample);
    if (list.length > this.options.windowSize) list.shift();
    this.samples.set(providerId, list);
    this.evaluate(providerId);
  }

  getMetrics(providerId: string): HealthMetrics | undefined {
    const list = this.samples.get(providerId);
    if (!list || list.length === 0) return undefined;
    const successCount = list.filter(s => s.success).length;
    const successRate = successCount / list.length;
    const avgLatency = list.reduce((a, s) => a + s.latencyMs, 0) / list.length;
    const staleness = Math.max(...list.map(s => s.stalenessMs));
    const latencyScore = Math.max(0, 1 - (avgLatency / this.options.maxLatencyMs));
    const stalenessScore = Math.max(0, 1 - (staleness / this.options.maxStalenessMs));
    const score = Math.round((successRate * this.options.successWeight + latencyScore * this.options.latencyWeight + stalenessScore * this.options.stalenessWeight) * 10000) / 100;
    return {
      successRate,
      averageLatencyMs: avgLatency,
      staleness,
      score,
      healthy: this.healthy.get(providerId) ?? true,
    };
  }

  private evaluate(providerId: string): void {
    const metrics = this.getMetrics(providerId);
    if (!metrics) return;
    const currentlyHealthy = this.healthy.get(providerId) ?? true;
    let nextHealthy = currentlyHealthy;
    let reason: string;

    if (currentlyHealthy && metrics.score < this.options.demotionThreshold) {
      nextHealthy = false;
      reason = `Score ${metrics.score} below demotion threshold ${this.options.demotionThreshold}`;
    } else if (!currentlyHealthy) {
      const sinceDemotion = Date.now() - (this.demotedAt.get(providerId) ?? 0);
      if (sinceDemotion >= this.options.recoveryWindowMs && metrics.score >= this.options.promotionThreshold) {
        nextHealthy = true;
        reason = `Score ${metrics.score} above promotion threshold after recovery window`;
      } else {
        return;
      }
    } else {
      return;
    }

    this.healthy.set(providerId, nextHealthy);
    if (nextHealthy) {
      this.demotedAt.delete(providerId);
      this.emit('promotion', { providerId, metrics, reason });
    } else {
      this.demotedAt.set(providerId, Date.now());
      this.emit('demotion', { providerId, metrics, reason });
    }
  }

  getSnapshot(): Record<string, HealthMetrics> {
    const result: Record<string, HealthMetrics> = {};
    for (const id of this.samples.keys()) {
      const m = this.getMetrics(id);
      if (m) result[id] = m;
    }
    return result;
  }
}
