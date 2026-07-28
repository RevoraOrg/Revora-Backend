/**
 * Tests for PressureGauge: pressure tier transitions, hysteresis, and backpressure signaling.
 *
 * Focus: Test only the implemented behavior
 * - Tier transitions based on lag thresholds
 * - Hysteresis: using recovery buffers to prevent oscillation
 * - State change callbacks
 * - Pressure tier queries (getTier, isAtLeast)
 */

import { PressureGauge, PressureTier, PressureState, PressureGaugeConfig } from '../pressureGauge';

describe('PressureGauge', () => {
  describe('initialization', () => {
    it('starts in NORMAL tier with -1 lag (no pending records)', () => {
      const gauge = new PressureGauge();
      const state = gauge.getState();

      expect(state.tier).toBe(PressureTier.NORMAL);
      expect(state.lagSeconds).toBe(-1);
      expect(state.transitionCount).toBe(0);
    });

    it('applies custom thresholds from config', () => {
      const config: PressureGaugeConfig = {
        infoThresholdSeconds: 10,
        warningThresholdSeconds: 20,
        criticalThresholdSeconds: 40,
      };
      const gauge = new PressureGauge(config);
      
      // Verify custom thresholds work
      gauge.updateLag(9);
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);

      gauge.updateLag(10);
      expect(gauge.getTier()).toBe(PressureTier.INFO);
    });
  });

  describe('tier transitions - climbing up (normal thresholds)', () => {
    it('transitions NORMAL → INFO when lag exceeds info threshold', () => {
      const gauge = new PressureGauge({
        infoThresholdSeconds: 30,
        warningThresholdSeconds: 60,
        criticalThresholdSeconds: 120,
      });

      expect(gauge.getTier()).toBe(PressureTier.NORMAL);

      gauge.updateLag(30);
      expect(gauge.getTier()).toBe(PressureTier.INFO);
    });

    it('transitions INFO → WARNING when lag exceeds warning threshold', () => {
      const gauge = new PressureGauge({
        infoThresholdSeconds: 30,
        warningThresholdSeconds: 60,
        criticalThresholdSeconds: 120,
      });

      gauge.updateLag(45); // Climb to INFO
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      gauge.updateLag(60); // Climb to WARNING
      expect(gauge.getTier()).toBe(PressureTier.WARNING);
    });

    it('transitions WARNING → CRITICAL when lag exceeds critical threshold', () => {
      const gauge = new PressureGauge({
        infoThresholdSeconds: 30,
        warningThresholdSeconds: 60,
        criticalThresholdSeconds: 120,
      });

      gauge.updateLag(90); // Climb to WARNING
      expect(gauge.getTier()).toBe(PressureTier.WARNING);

      gauge.updateLag(120); // Climb to CRITICAL
      expect(gauge.getTier()).toBe(PressureTier.CRITICAL);
    });
  });

  describe('tier transitions - descending down (with hysteresis)', () => {
    it('stays in INFO tier when descending but above recovery threshold', () => {
      const gauge = new PressureGauge({
        infoThresholdSeconds: 30,
        warningThresholdSeconds: 60,
        recoveryBufferSeconds: 10,
      });

      gauge.updateLag(45); // Climb to INFO
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      // Drop to 25 (below climb threshold of 30, but above descent threshold of 20)
      gauge.updateLag(25);
      expect(gauge.getTier()).toBe(PressureTier.INFO); // Stays INFO due to hysteresis
    });

    it('descends INFO → NORMAL when lag drops below recovery threshold', () => {
      const gauge = new PressureGauge({
        infoThresholdSeconds: 30,
        warningThresholdSeconds: 60,
        recoveryBufferSeconds: 10,
      });

      gauge.updateLag(45); // Climb to INFO
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      // Drop to 19 (below descent threshold of 20)
      gauge.updateLag(19);
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
    });

    it('stays in WARNING tier when descending but above recovery threshold', () => {
      const gauge = new PressureGauge({
        warningThresholdSeconds: 60,
        criticalThresholdSeconds: 120,
        recoveryBufferSeconds: 10,
      });

      gauge.updateLag(90); // Climb to WARNING
      expect(gauge.getTier()).toBe(PressureTier.WARNING);

      // Drop to 55 (below climb threshold of 60, but above descent threshold of 50)
      gauge.updateLag(55);
      expect(gauge.getTier()).toBe(PressureTier.WARNING); // Stays WARNING
    });

    it('descends WARNING → INFO when lag drops below recovery threshold', () => {
      const gauge = new PressureGauge({
        warningThresholdSeconds: 60,
        criticalThresholdSeconds: 120,
        recoveryBufferSeconds: 10,
      });

      gauge.updateLag(90); // Climb to WARNING
      expect(gauge.getTier()).toBe(PressureTier.WARNING);

      // Drop to 49 (below descent threshold of 50)
      gauge.updateLag(49);
      expect(gauge.getTier()).toBe(PressureTier.INFO);
    });
  });

  describe('no pending records', () => {
    it('returns to NORMAL when lag is -1 (no pending records)', () => {
      const gauge = new PressureGauge();

      gauge.updateLag(45); // Climb to INFO
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      gauge.updateLag(-1); // No pending records
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
      expect(gauge.getState().lagSeconds).toBe(-1);
    });
  });

  describe('state change callbacks', () => {
    it('invokes callback when tier transitions', () => {
      const gauge = new PressureGauge();
      const callback = jest.fn();
      gauge.onStateChange(callback);

      gauge.updateLag(31);

      expect(callback).toHaveBeenCalledTimes(1);
      const [oldState, newState] = callback.mock.calls[0];
      expect(oldState.tier).toBe(PressureTier.NORMAL);
      expect(newState.tier).toBe(PressureTier.INFO);
    });

    it('does not invoke callback when lag updates within same tier', () => {
      const gauge = new PressureGauge({
        infoThresholdSeconds: 30,
        recoveryBufferSeconds: 10,
      });
      const callback = jest.fn();
      gauge.onStateChange(callback);

      gauge.updateLag(31); // Transition to INFO
      callback.mockClear();

      gauge.updateLag(35); // Still INFO
      gauge.updateLag(40); // Still INFO

      expect(callback).not.toHaveBeenCalled();
    });

    it('supports multiple callbacks', () => {
      const gauge = new PressureGauge();
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      gauge.onStateChange(callback1);
      gauge.onStateChange(callback2);

      gauge.updateLag(31);

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('allows removing callbacks with offStateChange', () => {
      const gauge = new PressureGauge();
      const callback = jest.fn();
      gauge.onStateChange(callback);

      gauge.updateLag(31);
      expect(callback).toHaveBeenCalledTimes(1);

      gauge.offStateChange(callback);
      gauge.updateLag(61);

      expect(callback).toHaveBeenCalledTimes(1); // Not called again
    });

    it('increments transition count on each tier change', () => {
      const gauge = new PressureGauge();
      const callback = jest.fn();
      gauge.onStateChange(callback);

      gauge.updateLag(31); // NORMAL → INFO
      gauge.updateLag(61); // INFO → WARNING
      gauge.updateLag(-1); // WARNING → NORMAL

      expect(callback).toHaveBeenCalledTimes(3);
      expect(callback.mock.calls[0][1].transitionCount).toBe(1);
      expect(callback.mock.calls[1][1].transitionCount).toBe(2);
      expect(callback.mock.calls[2][1].transitionCount).toBe(3);
    });
  });

  describe('tier comparison (isAtLeast)', () => {
    it('returns true when tier equals threshold', () => {
      const gauge = new PressureGauge();
      gauge.updateLag(31); // Move to INFO

      expect(gauge.isAtLeast(PressureTier.INFO)).toBe(true);
    });

    it('returns true when tier exceeds threshold', () => {
      const gauge = new PressureGauge();
      gauge.updateLag(61); // Move to WARNING

      expect(gauge.isAtLeast(PressureTier.INFO)).toBe(true);
      expect(gauge.isAtLeast(PressureTier.WARNING)).toBe(true);
    });

    it('returns false when tier is below threshold', () => {
      const gauge = new PressureGauge();
      gauge.updateLag(31); // Move to INFO

      expect(gauge.isAtLeast(PressureTier.WARNING)).toBe(false);
      expect(gauge.isAtLeast(PressureTier.CRITICAL)).toBe(false);
    });

    it('isAtLeast NORMAL is always true', () => {
      const gauge = new PressureGauge();

      expect(gauge.isAtLeast(PressureTier.NORMAL)).toBe(true);

      gauge.updateLag(150); // Move to CRITICAL
      expect(gauge.isAtLeast(PressureTier.NORMAL)).toBe(true);
    });
  });

  describe('edge cases and boundary conditions', () => {
    it('handles zero lag (no pending records but explicitly set to 0)', () => {
      const gauge = new PressureGauge();
      gauge.updateLag(0);
      // 0 is not < 0, so it's treated as normal operation with 0 seconds lag
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
      expect(gauge.getState().lagSeconds).toBe(0);
    });

    it('handles very large lag values', () => {
      const gauge = new PressureGauge();
      gauge.updateLag(999999);
      expect(gauge.getTier()).toBe(PressureTier.CRITICAL);
    });

    it('handles rapid state transitions with hysteresis', () => {
      const gauge = new PressureGauge({
        infoThresholdSeconds: 30,
        warningThresholdSeconds: 60,
        recoveryBufferSeconds: 5,
      });

      // Simulate rapid fluctuations
      gauge.updateLag(35); // NORMAL → INFO
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      gauge.updateLag(25); // Stay in INFO due to buffer (descent threshold = 25)
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      gauge.updateLag(24); // Drop below descent threshold
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);

      gauge.updateLag(35); // Climb back to INFO
      expect(gauge.getTier()).toBe(PressureTier.INFO);
    });
  });

  describe('state immutability', () => {
    it('returns immutable copy of state', () => {
      const gauge = new PressureGauge();
      gauge.updateLag(31);

      const state1 = gauge.getState();
      const state2 = gauge.getState();

      expect(state1).toEqual(state2);
      expect(state1).not.toBe(state2); // Different objects

      // Mutating returned state should not affect gauge
      state1.lagSeconds = 999;
      expect(gauge.getState().lagSeconds).toBeCloseTo(31, 0);
    });
  });

  describe('default configuration', () => {
    it('uses default thresholds when not specified', () => {
      const gauge = new PressureGauge(); // No config

      // Default: infoThreshold = 30
      gauge.updateLag(29);
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);

      gauge.updateLag(30);
      expect(gauge.getTier()).toBe(PressureTier.INFO);
    });

    it('uses default recovery buffer', () => {
      const gauge = new PressureGauge({
        infoThresholdSeconds: 30,
        // Default recovery buffer = 15
      });

      gauge.updateLag(35); // Climb to INFO
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      // Descent threshold = 30 - 15 = 15
      gauge.updateLag(16); // Still above descent threshold
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      gauge.updateLag(14); // Below descent threshold
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
    });
  });
});

