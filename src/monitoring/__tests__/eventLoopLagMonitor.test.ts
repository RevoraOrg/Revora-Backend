import { EventLoopLagMonitor, SamplingProfile, DEFAULT_PROFILE, LagStats } from '../src/monitoring/eventLoopLagMonitor';

describe('EventLoopLagMonitor', () => {
  describe('initial state', () => {
    it('should have zero samples when created', () => {
      const monitor = new EventLoopLagMonitor();
      expect(monitor.sampleCount).toBe(0);
      expect(monitor.isDegraded).toBe(false);

      const stats = monitor.getStats();
      expect(stats.count).toBe(0);
    });
  });

  describe('start and record', () => {
    it('should record samples when started', () => {
      const monitor = new EventLoopLagMonitor({ sampleIntervalS: 0.01 });
      monitor.start();

      for (let i = 0; i < 5; i++) {
        const sample = monitor.record();
        expect(sample).not.toBeNull();
        expect(sample!.lagMs).toBeGreaterThanOrEqual(0);
      }
      expect(monitor.sampleCount).toBe(5);
    });

    it('should return null when stopped', () => {
      const monitor = new EventLoopLagMonitor();
      monitor.start();
      monitor.stop();
      expect(monitor.record()).toBeNull();
    });
  });

  describe('lag detection', () => {
    it('should detect lag via intendedAt parameter', () => {
      const monitor = new EventLoopLagMonitor({ sampleIntervalS: 0.1 });
      monitor.start();

      // On-time sample
      const now = Date.now();
      const s1 = monitor.record(now);
      expect(s1!.lagMs).toBeLessThan(50);

      // Delayed sample (intended 300ms ago)
      const s2 = monitor.record(now - 300);
      expect(s2!.lagMs).toBeGreaterThan(100);
    });
  });

  describe('stats aggregation', () => {
    it('should compute correct percentiles', () => {
      const monitor = new EventLoopLagMonitor({ sampleIntervalS: 0.01, windowSize: 10 });
      monitor.start();

      const base = Date.now();
      // Mix of normal and laggy samples
      monitor.record(base);
      monitor.record(base - 50);   // 50ms lag
      monitor.record(base - 200);  // 200ms lag
      monitor.record(base);
      monitor.record(base - 10);

      const stats = monitor.getStats();
      expect(stats.count).toBe(5);
      expect(stats.maxMs).toBeGreaterThanOrEqual(200);
      expect(stats.minMs).toBeLessThanOrEqual(10);
      expect(stats.avgMs).toBeGreaterThan(0);
    });
  });

  describe('degradation alerts', () => {
    it('should fire warning callback after consecutive degraded samples', () => {
      const alerts: Array<{ level: string; stats: LagStats }> = [];

      const monitor = new EventLoopLagMonitor(
        {
          sampleIntervalS: 0.01,
          alertThresholdMs: 20,
          maxConsecutiveDegraded: 2,
        },
        {
          onWarning: (stats) => alerts.push({ level: 'warning', stats }),
          onCritical: (stats) => alerts.push({ level: 'critical', stats }),
          onSaturation: (stats) => alerts.push({ level: 'saturation', stats }),
        }
      );
      monitor.start();

      // Normal sample
      monitor.record();

      // Two laggy samples
      const base = Date.now();
      monitor.record(base - 100);
      expect(monitor.isDegraded).toBe(false);

      monitor.record(base - 100);
      expect(monitor.isDegraded).toBe(true);
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(alerts[0].level).toBe('warning');
    });

    it('should fire critical callback for high lag', () => {
      const alerts: string[] = [];
      const monitor = new EventLoopLagMonitor(
        {
          alertThresholdMs: 10,
          criticalThresholdMs: 50,
          maxConsecutiveDegraded: 2,
        },
        {
          onCritical: () => alerts.push('critical'),
        }
      );
      monitor.start();
      monitor.record(); // normal
      const base = Date.now();
      monitor.record(base - 100); // 100ms lag
      monitor.record(base - 100); // 100ms lag
      expect(alerts).toContain('critical');
    });

    it('should fire saturation callback for extreme lag', () => {
      const alerts: string[] = [];
      const monitor = new EventLoopLagMonitor(
        {
          alertThresholdMs: 10,
          criticalThresholdMs: 50,
          saturationThresholdMs: 100,
          maxConsecutiveDegraded: 2,
        },
        {
          onSaturation: () => alerts.push('saturation'),
        }
      );
      monitor.start();
      monitor.record();
      const base = Date.now();
      monitor.record(base - 200); // 200ms lag > saturation
      monitor.record(base - 200);
      expect(alerts).toContain('saturation');
    });
  });

  describe('reset', () => {
    it('should clear samples and degradation state', () => {
      const monitor = new EventLoopLagMonitor({ maxConsecutiveDegraded: 1, alertThresholdMs: 5 });
      monitor.start();
      const base = Date.now();
      monitor.record(base - 50);
      monitor.record(base - 50);
      expect(monitor.sampleCount).toBeGreaterThan(0);
      expect(monitor.isDegraded).toBe(true);

      monitor.reset();
      expect(monitor.sampleCount).toBe(0);
      expect(monitor.isDegraded).toBe(false);
    });
  });

  describe('SampleProfile defaults', () => {
    it('should have reasonable defaults', () => {
      expect(DEFAULT_PROFILE.windowSize).toBe(100);
      expect(DEFAULT_PROFILE.alertThresholdMs).toBe(100);
      expect(DEFAULT_PROFILE.criticalThresholdMs).toBe(500);
      expect(DEFAULT_PROFILE.saturationThresholdMs).toBe(1000);
    });

    it('should allow partial overrides', () => {
      const monitor = new EventLoopLagMonitor({ alertThresholdMs: 50 });
      monitor.start();
      expect(monitor).toBeDefined();
    });
  });
});
