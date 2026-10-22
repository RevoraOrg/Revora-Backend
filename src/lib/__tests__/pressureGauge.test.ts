import {
  PressureGauge,
  PressureTier,
  PressureState,
} from '../pressureGauge';

describe('PressureGauge', () => {
  let gauge: PressureGauge;

  beforeEach(() => {
    gauge = new PressureGauge();
  });

  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------
  describe('initial state', () => {
    it('starts at NORMAL tier with lag -1', () => {
      const state = gauge.getState();
      expect(state.tier).toBe(PressureTier.NORMAL);
      expect(state.lagSeconds).toBe(-1);
    });

    it('getTier returns NORMAL', () => {
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
    });
  });

  // ---------------------------------------------------------------------------
  // updateLag – tier transitions
  // ---------------------------------------------------------------------------
  describe('updateLag', () => {
    it('stays NORMAL when lag is 0 (fresh records)', () => {
      gauge.updateLag(0);
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
    });

    it('stays NORMAL when lag is below info threshold', () => {
      gauge.updateLag(30);
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
    });

    it('transitions to INFO when lag crosses info threshold', () => {
      gauge.updateLag(60);
      expect(gauge.getTier()).toBe(PressureTier.INFO);
    });

    it('transitions to WARNING when lag crosses warning threshold', () => {
      gauge.updateLag(300);
      expect(gauge.getTier()).toBe(PressureTier.WARNING);
    });

    it('transitions to CRITICAL when lag crosses critical threshold', () => {
      gauge.updateLag(900);
      expect(gauge.getTier()).toBe(PressureTier.CRITICAL);
    });

    it('downgrades from CRITICAL to NORMAL when lag drops', () => {
      gauge.updateLag(900);
      expect(gauge.getTier()).toBe(PressureTier.CRITICAL);
      gauge.updateLag(10);
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
    });

    it('returns to NORMAL when lag becomes -1 (empty outbox)', () => {
      gauge.updateLag(900);
      expect(gauge.getTier()).toBe(PressureTier.CRITICAL);
      gauge.updateLag(-1);
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
    });

    it('does not fire listeners when tier stays the same', () => {
      const callback = jest.fn();
      gauge.onStateChange(callback);
      gauge.updateLag(10);
      gauge.updateLag(20); // Still NORMAL
      expect(callback).toHaveBeenCalledTimes(0);
    });

    it('does not fire listeners when lag value stays identical in same tier', () => {
      const callback = jest.fn();
      gauge.onStateChange(callback);
      gauge.updateLag(10);
      gauge.updateLag(10); // Same value
      expect(callback).toHaveBeenCalledTimes(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Custom thresholds
  // ---------------------------------------------------------------------------
  describe('custom thresholds', () => {
    it('uses provided info threshold', () => {
      const g = new PressureGauge({ infoThresholdSeconds: 120 });
      g.updateLag(100);
      expect(g.getTier()).toBe(PressureTier.NORMAL);
      g.updateLag(120);
      expect(g.getTier()).toBe(PressureTier.INFO);
    });

    it('uses provided warning threshold', () => {
      const g = new PressureGauge({ warningThresholdSeconds: 600 });
      g.updateLag(500);
      expect(g.getTier()).toBe(PressureTier.INFO);
      g.updateLag(600);
      expect(g.getTier()).toBe(PressureTier.WARNING);
    });

    it('uses provided critical threshold', () => {
      const g = new PressureGauge({ criticalThresholdSeconds: 1800 });
      g.updateLag(1500);
      expect(g.getTier()).toBe(PressureTier.WARNING);
      g.updateLag(1800);
      expect(g.getTier()).toBe(PressureTier.CRITICAL);
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  describe('constructor validation', () => {
    it('throws when infoThresholdSeconds <= 0', () => {
      expect(() => new PressureGauge({ infoThresholdSeconds: 0 })).toThrow();
      expect(() => new PressureGauge({ infoThresholdSeconds: -5 })).toThrow();
    });

    it('throws when warningThresholdSeconds <= infoThresholdSeconds', () => {
      expect(
        () => new PressureGauge({ infoThresholdSeconds: 60, warningThresholdSeconds: 60 })
      ).toThrow();
      expect(
        () => new PressureGauge({ infoThresholdSeconds: 60, warningThresholdSeconds: 40 })
      ).toThrow();
    });

    it('throws when criticalThresholdSeconds <= warningThresholdSeconds', () => {
      expect(
        () => new PressureGauge({ warningThresholdSeconds: 300, criticalThresholdSeconds: 300 })
      ).toThrow();
      expect(
        () => new PressureGauge({ warningThresholdSeconds: 300, criticalThresholdSeconds: 200 })
      ).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // State change callbacks
  // ---------------------------------------------------------------------------
  describe('state change callbacks', () => {
    it('fires callback on tier transition', () => {
      const callback = jest.fn();
      gauge.onStateChange(callback);
      gauge.updateLag(60);
      expect(callback).toHaveBeenCalledTimes(1);

      const [oldState, newState] = callback.mock.calls[0] as [PressureState, PressureState];
      expect(oldState.tier).toBe(PressureTier.NORMAL);
      expect(newState.tier).toBe(PressureTier.INFO);
      expect(newState.lagSeconds).toBe(60);
    });

    it('fires callback for each consecutive transition', () => {
      const callback = jest.fn();
      gauge.onStateChange(callback);
      gauge.updateLag(60);   // NORMAL → INFO
      gauge.updateLag(300);  // INFO → WARNING
      gauge.updateLag(900);  // WARNING → CRITICAL
      expect(callback).toHaveBeenCalledTimes(3);
    });

    it('fires multiple registered callbacks', () => {
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      gauge.onStateChange(cb1);
      gauge.onStateChange(cb2);
      gauge.updateLag(60);
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    it('does not break when a callback throws', () => {
      const badCallback = jest.fn(() => {
        throw new Error('boom');
      });
      const goodCallback = jest.fn();
      gauge.onStateChange(badCallback);
      gauge.onStateChange(goodCallback);
      gauge.updateLag(60);
      expect(badCallback).toHaveBeenCalledTimes(1);
      expect(goodCallback).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // removeListener
  // ---------------------------------------------------------------------------
  describe('removeListener', () => {
    it('removes a registered callback', () => {
      const callback = jest.fn();
      gauge.onStateChange(callback);
      gauge.removeListener(callback);
      gauge.updateLag(60);
      expect(callback).toHaveBeenCalledTimes(0);
    });

    it('does not affect other listeners when removing one', () => {
      const cb1 = jest.fn();
      const cb2 = jest.fn();
      gauge.onStateChange(cb1);
      gauge.onStateChange(cb2);
      gauge.removeListener(cb1);
      gauge.updateLag(60);
      expect(cb1).toHaveBeenCalledTimes(0);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // isAtLeast
  // ---------------------------------------------------------------------------
  describe('isAtLeast', () => {
    it('returns true when tier is at least the given tier', () => {
      gauge.updateLag(900); // CRITICAL
      expect(gauge.isAtLeast(PressureTier.NORMAL)).toBe(true);
      expect(gauge.isAtLeast(PressureTier.INFO)).toBe(true);
      expect(gauge.isAtLeast(PressureTier.WARNING)).toBe(true);
      expect(gauge.isAtLeast(PressureTier.CRITICAL)).toBe(true);
    });

    it('returns false when tier is below the given tier', () => {
      gauge.updateLag(30); // NORMAL
      expect(gauge.isAtLeast(PressureTier.INFO)).toBe(false);
      expect(gauge.isAtLeast(PressureTier.WARNING)).toBe(false);
      expect(gauge.isAtLeast(PressureTier.CRITICAL)).toBe(false);
    });

    it('returns true for NORMAL when tier is INFO', () => {
      gauge.updateLag(60); // INFO
      expect(gauge.isAtLeast(PressureTier.NORMAL)).toBe(true);
      expect(gauge.isAtLeast(PressureTier.INFO)).toBe(true);
      expect(gauge.isAtLeast(PressureTier.WARNING)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getState snapshot isolation
  // ---------------------------------------------------------------------------
  describe('getState', () => {
    it('returns a copy, not a reference', () => {
      const state1 = gauge.getState();
      state1.lagSeconds = 999;
      const state2 = gauge.getState();
      expect(state2.lagSeconds).toBe(-1);
    });
  });

  // ---------------------------------------------------------------------------
  // reset
  // ---------------------------------------------------------------------------
  describe('reset', () => {
    it('resets to NORMAL with lag -1', () => {
      gauge.updateLag(900);
      expect(gauge.getTier()).toBe(PressureTier.CRITICAL);
      gauge.reset();
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
      expect(gauge.getState().lagSeconds).toBe(-1);
    });
  });
});
