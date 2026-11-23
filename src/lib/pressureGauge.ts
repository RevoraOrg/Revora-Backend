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
   * Default: 30.
   */
  infoThresholdSeconds?: number;

  /**
   * Lag (seconds) above which the tier escalates to WARNING.
   * Default: 60.
   */
  warningThresholdSeconds?: number;

  /**
   * Lag (seconds) above which the tier escalates to CRITICAL.
   * Default: 120.
   */
  criticalThresholdSeconds?: number;

  /**
   * Hysteresis window in seconds. When a tier would be downgraded, the gauge
   * holds the current tier until the lag drops `recoveryBufferSeconds` below
   * that tier's threshold, preventing rapid oscillation at a boundary.
   * Default: 0 (no hysteresis).
   */
  recoveryBufferSeconds?: number;
}

/** Default thresholds in seconds. */
const DEFAULT_INFO_THRESHOLD = 30;
const DEFAULT_WARNING_THRESHOLD = 60;
const DEFAULT_CRITICAL_THRESHOLD = 120;

/**
 * Snapshot of the current pressure gauge state.
 */
export interface PressureState {
  /** Current pressure tier. */
  tier: PressureTier;
  /** Current lag in seconds, or -1 if the outbox is empty. */
  lagSeconds: number;
  /** Epoch ms when the current tier was entered (unset before the first transition). */
  tierChangedAt?: number;
  /** Number of tier transitions observed since construction / reset. */
  transitionCount?: number;
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
  private readonly recoveryBuffer: number;

  private state: PressureState = {
    tier: PressureTier.NORMAL,
    lagSeconds: -1,
    tierChangedAt: undefined,
    transitionCount: 0,
  };
  private listeners: PressureStateChangeCallback[] = [];

  constructor(config: PressureGaugeConfig = {}) {
    this.infoThreshold = config.infoThresholdSeconds ?? DEFAULT_INFO_THRESHOLD;
    this.warningThreshold = config.warningThresholdSeconds ?? DEFAULT_WARNING_THRESHOLD;
    this.criticalThreshold = config.criticalThresholdSeconds ?? DEFAULT_CRITICAL_THRESHOLD;
    this.recoveryBuffer = config.recoveryBufferSeconds ?? 0;

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
  /**
   * Returns the lower lag boundary for a given tier, used to apply the
   * recovery buffer when deciding whether to downgrade.
   */
  private thresholdForTier(tier: PressureTier): number {
    switch (tier) {
      case PressureTier.INFO:
        return this.infoThreshold;
      case PressureTier.WARNING:
        return this.warningThreshold;
      case PressureTier.CRITICAL:
        return this.criticalThreshold;
      default:
        return 0;
    }
  }

  updateLag(lagSeconds: number): void {
    const proposed = this.computeTier(lagSeconds);
    const current = this.state.tier;

    // Hysteresis: hold the current tier when recovering until lag drops
    // `recoveryBufferSeconds` below the tier's threshold.
    let newTier = proposed;
    if (
      proposed !== current &&
      TIER_ORDER[proposed] < TIER_ORDER[current] &&
      this.recoveryBuffer > 0
    ) {
      const lowerBound = this.thresholdForTier(current);
      if (lagSeconds >= lowerBound - this.recoveryBuffer) {
        newTier = current;
      }
    }

    if (newTier === current && lagSeconds === this.state.lagSeconds) {
      // No change — nothing to do
      return;
    }

    const oldState = { ...this.state };

    if (newTier !== current) {
      this.state = {
        tier: newTier,
        lagSeconds,
        tierChangedAt: Date.now(),
        transitionCount: (this.state.transitionCount ?? 0) + 1,
      };
      this.fireListeners(oldState, { ...this.state });
    } else {
      // Same tier — only the lag observation changed.
      this.state = { ...this.state, lagSeconds };
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
    this.state = {
      tier: PressureTier.NORMAL,
      lagSeconds: -1,
      tierChangedAt: undefined,
      transitionCount: 0,
    };
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
