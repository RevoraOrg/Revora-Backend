import { PressureGauge, PressureTier } from '../pressureGauge';

/**
 * Regression suite for the `PressureGaugeConfig` failure handling in
 * `src/lib/pressureGauge.ts`.
 *
 * Branch evidence (constructor validation):
 *   - line ~138: `throw new Error('infoThresholdSeconds must be > 0')`
 *   - line ~141: `throw new Error('warningThresholdSeconds must be > infoThresholdSeconds')`
 *   - line ~144: `throw new Error('criticalThresholdSeconds must be > warningThresholdSeconds')`
 *
 * The broader gauge behaviour is covered by `__tests__/pressureGauge.test.ts`.
 * This file pins the *error contract* those branches expose — exact message,
 * `Error` type, evaluation order when several thresholds are invalid at once,
 * the off-by-one boundaries either side of each guard, and the neighbouring
 * happy path that must keep constructing — so a silent change to the failure
 * mode is caught.
 */

const INFO_ERROR = 'infoThresholdSeconds must be > 0';
const WARNING_ERROR = 'warningThresholdSeconds must be > infoThresholdSeconds';
const CRITICAL_ERROR = 'criticalThresholdSeconds must be > warningThresholdSeconds';

function captureError(build: () => unknown): Error {
  try {
    build();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected constructor to throw');
}

describe('PressureGauge config failure contract', () => {
  describe('infoThresholdSeconds guard', () => {
    it.each([0, -1, -5, Number.MIN_SAFE_INTEGER])(
      'rejects infoThresholdSeconds = %p with the documented message',
      (infoThresholdSeconds) => {
        const error = captureError(() => new PressureGauge({ infoThresholdSeconds }));

        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe(INFO_ERROR);
      },
    );

    it('accepts the smallest positive threshold (boundary just above the guard)', () => {
      expect(() => new PressureGauge({ infoThresholdSeconds: 1 })).not.toThrow();
    });
  });

  describe('warningThresholdSeconds guard', () => {
    it.each([
      [60, 60],
      [60, 40],
      [1, 1],
      [5, 0],
    ])('rejects warning <= info (%p, %p) with the documented message', (info, warning) => {
      const error = captureError(
        () => new PressureGauge({ infoThresholdSeconds: info, warningThresholdSeconds: warning }),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(WARNING_ERROR);
    });

    it('accepts warning = info + 1 (boundary just above the guard)', () => {
      expect(
        () => new PressureGauge({ infoThresholdSeconds: 10, warningThresholdSeconds: 11 }),
      ).not.toThrow();
    });

    it('validates the derived default warning threshold against a raised info threshold', () => {
      // info (120) is raised past the default warning (60), so the guard must fire.
      const error = captureError(() => new PressureGauge({ infoThresholdSeconds: 120 }));

      expect(error.message).toBe(WARNING_ERROR);
    });
  });

  describe('criticalThresholdSeconds guard', () => {
    it.each([
      [300, 300],
      [300, 200],
      [31, 31],
    ])('rejects critical <= warning (%p, %p) with the documented message', (warning, critical) => {
      const error = captureError(
        () =>
          new PressureGauge({
            warningThresholdSeconds: warning,
            criticalThresholdSeconds: critical,
          }),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(CRITICAL_ERROR);
    });

    it('accepts critical = warning + 1 (boundary just above the guard)', () => {
      expect(
        () => new PressureGauge({ warningThresholdSeconds: 300, criticalThresholdSeconds: 301 }),
      ).not.toThrow();
    });

    it('validates a raised warning threshold against the default critical threshold', () => {
      const error = captureError(() => new PressureGauge({ warningThresholdSeconds: 180 }));

      expect(error.message).toBe(CRITICAL_ERROR);
    });
  });

  describe('evaluation order and determinism', () => {
    it('reports the first failing guard when several thresholds are invalid', () => {
      const error = captureError(
        () =>
          new PressureGauge({
            infoThresholdSeconds: 0,
            warningThresholdSeconds: 0,
            criticalThresholdSeconds: 0,
          }),
      );

      expect(error.message).toBe(INFO_ERROR);
    });

    it('reports the warning guard ahead of the critical guard', () => {
      const error = captureError(
        () =>
          new PressureGauge({
            infoThresholdSeconds: 60,
            warningThresholdSeconds: 60,
            criticalThresholdSeconds: 10,
          }),
      );

      expect(error.message).toBe(WARNING_ERROR);
    });

    it('throws the same message on every construction attempt', () => {
      const first = captureError(() => new PressureGauge({ infoThresholdSeconds: -1 }));
      const second = captureError(() => new PressureGauge({ infoThresholdSeconds: -1 }));

      expect(first.message).toBe(second.message);
      expect(first.constructor).toBe(second.constructor);
    });
  });

  describe('neighbouring normal paths', () => {
    it('constructs with no config using the documented defaults', () => {
      const gauge = new PressureGauge();

      expect(gauge.getTier()).toBe(PressureTier.NORMAL);
      expect(gauge.getState().lagSeconds).toBe(-1);
      expect(gauge.getState().transitionCount).toBe(0);
    });

    it('constructs with an ascending custom config and classifies against it', () => {
      const gauge = new PressureGauge({
        infoThresholdSeconds: 120,
        warningThresholdSeconds: 300,
        criticalThresholdSeconds: 900,
        recoveryBufferSeconds: 30,
      });

      gauge.updateLag(119);
      expect(gauge.getTier()).toBe(PressureTier.NORMAL);

      gauge.updateLag(120);
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      gauge.updateLag(300);
      expect(gauge.getTier()).toBe(PressureTier.WARNING);

      gauge.updateLag(900);
      expect(gauge.getTier()).toBe(PressureTier.CRITICAL);
    });

    it('accepts a minimal strictly-ascending config (1, 2, 3)', () => {
      const gauge = new PressureGauge({
        infoThresholdSeconds: 1,
        warningThresholdSeconds: 2,
        criticalThresholdSeconds: 3,
      });

      gauge.updateLag(1);
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      gauge.updateLag(2);
      expect(gauge.getTier()).toBe(PressureTier.WARNING);

      gauge.updateLag(3);
      expect(gauge.getTier()).toBe(PressureTier.CRITICAL);
    });

    it('treats a partial config as defaults for the omitted thresholds', () => {
      const gauge = new PressureGauge({ infoThresholdSeconds: 5 });

      gauge.updateLag(5);
      expect(gauge.getTier()).toBe(PressureTier.INFO);

      // Default warning (60) / critical (120) remain in force.
      gauge.updateLag(60);
      expect(gauge.getTier()).toBe(PressureTier.WARNING);

      gauge.updateLag(120);
      expect(gauge.getTier()).toBe(PressureTier.CRITICAL);
    });
  });
});
