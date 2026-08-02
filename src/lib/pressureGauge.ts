/**
 * PressureGauge — monitors outbox lag and signals backpressure via tiered thresholds.
 *
 * Tracks the age of the oldest unsent outbox record and transitions through
 * escalating pressure tiers (NORMAL → INFO → WARNING → CRITICAL) as lag
 * increases. Registered callbacks fire on every tier transition, allowing
 * the dispatcher and external consumers to react (e.g. emit alerts, pause
 * producers).
 *
 * @see ../../docs/architecture/distribution-reconciliation.md
 * @see ../docs/webhook-queue-backpressure.md
 * @see ../services/outboxDispatcher.ts
 */

/**
 * Escalating pressure tiers ordered by severity.
 * Producers should pause when the tier reaches WARNING or above.
 */
export enum PressureTier {
  /** No backpressure – lag within normal range (or empty outbox). */
  NORMAL = 'normal',
  /** Mild backpressure – lag is elevated but manageable. */
  INFO = 'info',
  /** Significant backpressure – producers should consider slowing down. */
  WARNING = 'warning',
  /** Critical backpressure – producers MUST pause. */
  CRITICAL = 'critical',
}

/** Ordinal ranking for tier comparisons. */
const TIER_ORDER: Record<PressureTier, number> = {
  [PressureTier.NORMAL]: 0,
  [PressureTier.INFO]: 1,
  [PressureTier.WARNING]: 2,
  [PressureTier.CRITICAL]: 3,
};

/**
 * Configuration for pressure gauge thresholds (in seconds).
 */
export interface PressureGaugeConfig {
  /**
   * Lag (seconds) above which the tier escalates to INFO.
   * Default: 60 (1 minute).
   */
  infoThresholdSeconds?: number;

  /**
   * Lag (seconds) above which the tier escalates to WARNING.
   * Default: 300 (5 minutes).
   */
  warningThresholdSeconds?: number;

  /**
   * Lag (seconds) above which the tier escalates to CRITICAL.
   * Default: 900 (15 minutes).
   */
  criticalThresholdSeconds?: number;
}

/** Default thresholds in seconds. */
const DEFAULT_INFO_THRESHOLD = 60;
const DEFAULT_WARNING_THRESHOLD = 300;
const DEFAULT_CRITICAL_THRESHOLD = 900;

/**
 * Snapshot of the current pressure gauge state.
 */
export interface PressureState {
  /** Current pressure tier. */
  tier: PressureTier;
  /** Current lag in seconds, or -1 if the outbox is empty. */
  lagSeconds: number;
}

/**
 * Callback invoked whenever the pressure tier changes.
 * Receives the old state and the new state so consumers can
 * inspect the transition direction and magnitude.
 */
export type PressureStateChangeCallback = (
  oldState: PressureState,
  newState: PressureState
) => void;

/**
 * Monitors outbox lag and signals backpressure via tiered thresholds.
 *
 * ## Usage
 * ```ts
 * const gauge = new PressureGauge({
 *   infoThresholdSeconds: 60,
 *   warningThresholdSeconds: 300,
 *   criticalThresholdSeconds: 900,
 * });
 *
 * gauge.onStateChange((oldState, newState) => {
 *   console.log(`Tier changed: ${oldState.tier} → ${newState.tier}`);
 * });
 *
 * gauge.updateLag(400);  // Lag is 400s → WARNING
 * ```
 */
export class PressureGauge {
  private readonly infoThreshold: number;
  private readonly warningThreshold: number;
  private readonly criticalThreshold: number;

  private state: PressureState = { tier: PressureTier.NORMAL, lagSeconds: -1 };
  private listeners: PressureStateChangeCallback[] = [];

  constructor(config: PressureGaugeConfig = {}) {
    this.infoThreshold = config.infoThresholdSeconds ?? DEFAULT_INFO_THRESHOLD;
    this.warningThreshold = config.warningThresholdSeconds ?? DEFAULT_WARNING_THRESHOLD;
    this.criticalThreshold = config.criticalThresholdSeconds ?? DEFAULT_CRITICAL_THRESHOLD;

    // Validate thresholds are in ascending order
    if (this.infoThreshold <= 0) {
      throw new Error('infoThresholdSeconds must be > 0');
    }
    if (this.warningThreshold <= this.infoThreshold) {
      throw new Error('warningThresholdSeconds must be > infoThresholdSeconds');
    }
    if (this.criticalThreshold <= this.warningThreshold) {
      throw new Error('criticalThresholdSeconds must be > warningThresholdSeconds');
    }
  }

  /**
   * Determine the pressure tier for a given lag value.
   * A lag of -1 (no pending records) always maps to NORMAL.
   */
  private computeTier(lagSeconds: number): PressureTier {
    if (lagSeconds < 0) {
      return PressureTier.NORMAL;
    }
    if (lagSeconds >= this.criticalThreshold) {
      return PressureTier.CRITICAL;
    }
    if (lagSeconds >= this.warningThreshold) {
      return PressureTier.WARNING;
    }
    if (lagSeconds >= this.infoThreshold) {
      return PressureTier.INFO;
    }
    return PressureTier.NORMAL;
  }

  /**
   * Update the gauge with the current outbox lag.
   *
   * @param lagSeconds Age of the oldest unsent record in seconds,
   *   or -1 when the outbox is empty.
   */
  updateLag(lagSeconds: number): void {
    const newTier = this.computeTier(lagSeconds);
    const oldState = { ...this.state };

    if (oldState.tier === newTier && oldState.lagSeconds === lagSeconds) {
      // No change — nothing to do
      return;
    }

    const newState: PressureState = { tier: newTier, lagSeconds };
    this.state = newState;

    // Only fire listeners on tier transitions
    if (oldState.tier !== newTier) {
      this.fireListeners(oldState, newState);
    }
  }

  /**
   * Register a callback to be invoked on every tier transition.
   */
  onStateChange(callback: PressureStateChangeCallback): void {
    this.listeners.push(callback);
  }

  /**
   * Remove a previously registered callback.
   */
  removeListener(callback: PressureStateChangeCallback): void {
    this.listeners = this.listeners.filter((l) => l !== callback);
  }

  /**
   * Get the current pressure state snapshot.
   */
  getState(): PressureState {
    return { ...this.state };
  }

  /**
   * Get the current pressure tier.
   */
  getTier(): PressureTier {
    return this.state.tier;
  }

  /**
   * Check whether the current pressure is at or above a given tier.
   *
   * @param tier Tier to compare against.
   * @returns `true` if the current tier is at least as severe as `tier`.
   */
  isAtLeast(tier: PressureTier): boolean {
    return TIER_ORDER[this.state.tier] >= TIER_ORDER[tier];
  }

  /**
   * Reset the gauge to its initial state (useful for testing).
   */
  reset(): void {
    this.state = { tier: PressureTier.NORMAL, lagSeconds: -1 };
  }

  private fireListeners(
    oldState: PressureState,
    newState: PressureState
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(oldState, newState);
      } catch (error) {
        // Swallow listener errors — they shouldn't break the gauge
        console.error('[PressureGauge] Listener error:', error);
      }
    }
  }
}
