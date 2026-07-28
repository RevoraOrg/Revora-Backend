/**
 * Pressure Gauge: Backpressure Signal Management
 *
 * Provides a thread-safe mechanism to signal backpressure to producers when
 * system capacity is exceeded. Implements escalating severity tiers (info, warning, critical)
 * for monitoring and alerting.
 *
 * Security Assumptions:
 * - Gauge state is process-local; in multi-replica deployments each replica
 *   maintains its own pressure state. Synchronize via external coordination if needed.
 * - Pressure release should be checked regularly and transitions validated.
 *
 * @module lib/pressureGauge
 */

export enum PressureTier {
  /** Normal operation: no pressure. */
  NORMAL = 'normal',
  /** Info level: lag is building, monitor closely. */
  INFO = 'info',
  /** Warning level: significant lag, producers should slow down. */
  WARNING = 'warning',
  /** Critical level: severe lag, producers must pause. */
  CRITICAL = 'critical',
}

/**
 * Configuration for pressure gauge thresholds and behavior.
 */
export interface PressureGaugeConfig {
  /** Seconds of lag that triggers INFO tier. Default: 30. */
  infoThresholdSeconds?: number;
  /** Seconds of lag that triggers WARNING tier. Default: 60. */
  warningThresholdSeconds?: number;
  /** Seconds of lag that triggers CRITICAL tier. Default: 120. */
  criticalThresholdSeconds?: number;
  /** Seconds of lag recovery before tier downgrade. Default: 15. */
  recoveryBufferSeconds?: number;
}

export interface PressureState {
  /** Current tier of backpressure. */
  tier: PressureTier;
  /** Age of oldest unsent record in seconds (or -1 if no pending records). */
  lagSeconds: number;
  /** Timestamp when tier last changed. */
  tierChangedAt: Date;
  /** Number of tier transitions since startup. */
  transitionCount: number;
}

/**
 * Callback invoked when pressure state changes.
 * @param oldState Previous pressure state.
 * @param newState New pressure state.
 */
export type PressureStateChangeCallback = (oldState: PressureState, newState: PressureState) => void;

/**
 * PressureGauge: Monitors and signals backpressure based on configured thresholds.
 *
 * Usage:
 * ```typescript
 * const gauge = new PressureGauge();
 * gauge.onStateChange((oldState, newState) => {
 *   console.log(`Pressure: ${oldState.tier} → ${newState.tier}`);
 *   if (newState.tier === PressureTier.CRITICAL) {
 *     pauseProducers();
 *   }
 * });
 *
 * // Periodically update with current lag
 * const oldestRow = await outboxRepo.getOldestPending();
 * const lagSeconds = oldestRow ? (Date.now() - oldestRow.created_at.getTime()) / 1000 : -1;
 * gauge.updateLag(lagSeconds);
 * ```
 */
export class PressureGauge {
  private readonly infoThreshold: number;
  private readonly warningThreshold: number;
  private readonly criticalThreshold: number;
  private readonly recoveryBuffer: number;
  private state: PressureState;
  private stateChangeCallbacks: PressureStateChangeCallback[] = [];

  constructor(config: PressureGaugeConfig = {}) {
    this.infoThreshold = config.infoThresholdSeconds ?? 30;
    this.warningThreshold = config.warningThresholdSeconds ?? 60;
    this.criticalThreshold = config.criticalThresholdSeconds ?? 120;
    this.recoveryBuffer = config.recoveryBufferSeconds ?? 15;

    this.state = {
      tier: PressureTier.NORMAL,
      lagSeconds: -1,
      tierChangedAt: new Date(),
      transitionCount: 0,
    };
  }

  /**
   * Register a callback to be invoked when pressure state changes.
   * @param callback Function to invoke on state transitions.
   */
  onStateChange(callback: PressureStateChangeCallback): void {
    this.stateChangeCallbacks.push(callback);
  }

  /**
   * Remove a callback from state change listeners.
   * @param callback Function to remove.
   */
  offStateChange(callback: PressureStateChangeCallback): void {
    const index = this.stateChangeCallbacks.indexOf(callback);
    if (index !== -1) {
      this.stateChangeCallbacks.splice(index, 1);
    }
  }

  /**
   * Update the gauge with current outbox lag.
   * Automatically computes and transitions to appropriate pressure tier.
   *
   * @param lagSeconds Age of oldest pending record in seconds.
   *                   Use -1 if no pending records (pressure releases).
   */
  updateLag(lagSeconds: number): void {
    const newTier = this.computeTier(lagSeconds);
    const oldState = { ...this.state };

    if (newTier !== this.state.tier) {
      this.state.tier = newTier;
      this.state.tierChangedAt = new Date();
      this.state.transitionCount++;

      // Create immutable copies before passing to callbacks
      const callbackNewState = { ...this.state };

      // Notify all listeners of the state change
      this.stateChangeCallbacks.forEach((callback) => {
        callback(oldState, callbackNewState);
      });
    }

    this.state.lagSeconds = lagSeconds;
  }

  /**
   * Get the current pressure state.
   * @returns Copy of current pressure state.
   */
  getState(): PressureState {
    return { ...this.state };
  }

  /**
   * Get the current pressure tier.
   * @returns Current tier.
   */
  getTier(): PressureTier {
    return this.state.tier;
  }

  /**
   * Check if pressure is at or above a given tier.
   * @param tier Tier to check.
   * @returns True if current tier equals or exceeds the given tier.
   */
  isAtLeast(tier: PressureTier): boolean {
    const tierOrder = [PressureTier.NORMAL, PressureTier.INFO, PressureTier.WARNING, PressureTier.CRITICAL];
    const currentIndex = tierOrder.indexOf(this.state.tier);
    const targetIndex = tierOrder.indexOf(tier);
    return currentIndex >= targetIndex;
  }

  /**
   * Compute pressure tier based on lag seconds.
   * Implements hysteresis to prevent rapid tier oscillations.
   *
   * Hysteresis works by using different thresholds for climbing vs. descending:
   * - Climbing (NORMAL→INFO→WARNING→CRITICAL): uses full thresholds
   * - Descending: uses recovery thresholds (threshold - buffer) for downgrade
   *
   * @param lagSeconds Current outbox lag in seconds.
   * @returns Appropriate pressure tier.
   */
  private computeTier(lagSeconds: number): PressureTier {
    // No pending records → always NORMAL
    if (lagSeconds < 0) {
      return PressureTier.NORMAL;
    }

    // Check CRITICAL tier (highest severity)
    // Descend from CRITICAL only if lag drops below (criticalThreshold - buffer)
    // Climb to CRITICAL if lag exceeds criticalThreshold
    const criticalClimbThreshold = this.criticalThreshold;
    const criticalDescentThreshold = this.criticalThreshold - this.recoveryBuffer;

    if (this.state.tier === PressureTier.CRITICAL) {
      // Already CRITICAL: use descent threshold to downgrade
      if (lagSeconds < criticalDescentThreshold) {
        return PressureTier.WARNING;
      }
      return PressureTier.CRITICAL;
    }

    if (lagSeconds >= criticalClimbThreshold) {
      return PressureTier.CRITICAL;
    }

    // Check WARNING tier
    const warningClimbThreshold = this.warningThreshold;
    const warningDescentThreshold = this.warningThreshold - this.recoveryBuffer;

    if (this.state.tier === PressureTier.WARNING) {
      // Already WARNING: use descent threshold to downgrade
      if (lagSeconds < warningDescentThreshold) {
        return PressureTier.INFO;
      }
      return PressureTier.WARNING;
    }

    if (lagSeconds >= warningClimbThreshold) {
      return PressureTier.WARNING;
    }

    // Check INFO tier
    const infoClimbThreshold = this.infoThreshold;
    const infoDescentThreshold = this.infoThreshold - this.recoveryBuffer;

    if (this.state.tier === PressureTier.INFO) {
      // Already INFO: use descent threshold to downgrade
      if (lagSeconds < infoDescentThreshold) {
        return PressureTier.NORMAL;
      }
      return PressureTier.INFO;
    }

    if (lagSeconds >= infoClimbThreshold) {
      return PressureTier.INFO;
    }

    // Default to NORMAL
    return PressureTier.NORMAL;
  }
}
