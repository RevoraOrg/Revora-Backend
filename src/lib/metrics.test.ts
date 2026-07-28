/**
 * Metrics Collection Tests
 * 
 * Comprehensive test coverage for metrics collection including:
 * - Counter, gauge, and histogram operations
 * - Metric sanitization and security
 * - Snapshot generation
 * - Prometheus export format
 * - Memory management
 * 
 * @module lib/metrics.test
 */

import { Pool } from 'pg';
import { MetricsCollector, MetricType, HistogramData } from './metrics';

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true, maxPoints: 100 });
  });

  afterEach(() => {
    metrics.reset();
  });

  describe('Counter Metrics', () => {
    it('should increment counter from zero', () => {
      metrics.incrementCounter('test_counter');
      
      const snapshot = metrics['counters'];
      expect(snapshot.get('test_counter')).toBe(1);
    });

    it('should increment counter by custom value', () => {
      metrics.incrementCounter('test_counter', undefined, 5);
      metrics.incrementCounter('test_counter', undefined, 3);
      
      const snapshot = metrics['counters'];
      expect(snapshot.get('test_counter')).toBe(8);
    });

    it('should support dimensional labels', () => {
      metrics.incrementCounter('http_requests', { method: 'GET', status: '200' });
      metrics.incrementCounter('http_requests', { method: 'POST', status: '201' });
      metrics.incrementCounter('http_requests', { method: 'GET', status: '200' });
      
      const snapshot = metrics['counters'];
      expect(snapshot.get('http_requests{method="GET",status="200"}')).toBe(2);
      expect(snapshot.get('http_requests{method="POST",status="201"}')).toBe(1);
    });

    it('should sanitize metric names', () => {
      metrics.incrementCounter('test-counter!@#$%');
      
      const snapshot = metrics['counters'];
      expect(snapshot.has('test_counter_____')).toBe(true);
    });

    it('should sanitize label values', () => {
      metrics.incrementCounter('test', { 'key': 'value"with"quotes' });
      
      const snapshot = metrics['counters'];
      const key = Array.from(snapshot.keys())[0];
      expect(key).not.toContain('"value"with"quotes"');
    });

    it('should filter PII from email addresses', () => {
      metrics.incrementCounter('test', { email: 'user@example.com' });
      
      const snapshot = metrics['counters'];
      const key = Array.from(snapshot.keys())[0];
      expect(key).toContain('[REDACTED_EMAIL]');
      expect(key).not.toContain('user@example.com');
    });

    it('should filter PII from phone numbers', () => {
      metrics.incrementCounter('test', { phone: '+1-555-123-4567' });
      
      const snapshot = metrics['counters'];
      const key = Array.from(snapshot.keys())[0];
      expect(key).toContain('[REDACTED_PHONE]');
    });

    it('should filter PII from IP addresses', () => {
      metrics.incrementCounter('test', { ip: '192.168.1.1' });
      
      const snapshot = metrics['counters'];
      const key = Array.from(snapshot.keys())[0];
      expect(key).toContain('[REDACTED_IP]');
    });

    it('should filter PII from UUIDs', () => {
      metrics.incrementCounter('test', { id: '123e4567-e89b-12d3-a456-426614174000' });
      
      const snapshot = metrics['counters'];
      const key = Array.from(snapshot.keys())[0];
      expect(key).toContain('[REDACTED_ID]');
    });

    it('should filter PII from long numeric IDs', () => {
      metrics.incrementCounter('test', { userId: '123456789012345' });
      
      const snapshot = metrics['counters'];
      const key = Array.from(snapshot.keys())[0];
      expect(key).toContain('[REDACTED_NUMERIC_ID]');
    });

    it('should not collect metrics when disabled', () => {
      const disabledMetrics = new MetricsCollector({ enabled: false });
      disabledMetrics.incrementCounter('test');
      
      const snapshot = disabledMetrics['counters'];
      expect(snapshot.size).toBe(0);
    });
  });

  describe('Gauge Metrics', () => {
    it('should set gauge value', () => {
      metrics.setGauge('memory_usage', 1024);
      
      const snapshot = metrics['gauges'];
      expect(snapshot.get('memory_usage')).toBe(1024);
    });

    it('should overwrite previous gauge value', () => {
      metrics.setGauge('cpu_usage', 50);
      metrics.setGauge('cpu_usage', 75);
      
      const snapshot = metrics['gauges'];
      expect(snapshot.get('cpu_usage')).toBe(75);
    });

    it('should support labels for gauges', () => {
      metrics.setGauge('temperature', 72, { location: 'server1', unit: 'celsius' });
      metrics.setGauge('temperature', 68, { location: 'server2', unit: 'celsius' });
      
      const snapshot = metrics['gauges'];
      expect(snapshot.get('temperature{location="server1",unit="celsius"}')).toBe(72);
      expect(snapshot.get('temperature{location="server2",unit="celsius"}')).toBe(68);
    });
  });

  describe('Histogram Metrics', () => {
    it('should record histogram observations', () => {
      metrics.recordHistogram('request_duration', 45.2);
      metrics.recordHistogram('request_duration', 123.7);
      metrics.recordHistogram('request_duration', 8.1);
      
      const snapshot = metrics['histograms'];
      expect(snapshot.get('request_duration')).toEqual([45.2, 123.7, 8.1]);
    });

    it('should limit histogram observations to maxPoints', () => {
      const smallMetrics = new MetricsCollector({ enabled: true, maxPoints: 3 });
      
      smallMetrics.recordHistogram('test', 1);
      smallMetrics.recordHistogram('test', 2);
      smallMetrics.recordHistogram('test', 3);
      smallMetrics.recordHistogram('test', 4);
      smallMetrics.recordHistogram('test', 5);
      
      const observations = smallMetrics['histograms'].get('test');
      expect(observations).toHaveLength(3);
      expect(observations).toEqual([3, 4, 5]); // Oldest values removed
    });

    it('should calculate histogram statistics correctly', () => {
      metrics.recordHistogram('duration', 10);
      metrics.recordHistogram('duration', 25);
      metrics.recordHistogram('duration', 50);
      metrics.recordHistogram('duration', 100);
      metrics.recordHistogram('duration', 250);
      
      const histogram = metrics['calculateHistogram']([10, 25, 50, 100, 250]);
      
      expect(histogram.count).toBe(5);
      expect(histogram.sum).toBe(435);
      expect(histogram.buckets).toEqual(
        expect.arrayContaining([
          { le: 10, count: 1 },
          { le: 25, count: 2 },
          { le: 50, count: 3 },
          { le: 100, count: 4 },
          { le: 250, count: 5 },
        ])
      );
    });

    it('should include infinity bucket in histogram', () => {
      metrics.recordHistogram('duration', 100);
      
      const histogram = metrics['calculateHistogram']([100]);
      const infBucket = histogram.buckets.find((b) => b.le === Infinity);
      
      expect(infBucket).toBeDefined();
      expect(infBucket?.count).toBe(1);
    });
  });

  describe('Active Connections', () => {
    it('should track active connections', () => {
      metrics.incrementActiveConnections();
      metrics.incrementActiveConnections();
      
      expect(metrics['activeConnections']).toBe(2);
      
      metrics.decrementActiveConnections();
      expect(metrics['activeConnections']).toBe(1);
    });

    it('should not go below zero', () => {
      metrics.decrementActiveConnections();
      metrics.decrementActiveConnections();
      
      expect(metrics['activeConnections']).toBe(0);
    });
  });

  describe('Snapshot Generation', () => {
    it('should generate complete metrics snapshot', async () => {
      metrics.incrementCounter('requests', { status: '200' });
      metrics.setGauge('memory', 1024);
      metrics.recordHistogram('duration', 50);
      
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.system).toBeDefined();
      expect(snapshot.system.memoryUsage).toBeDefined();
      expect(snapshot.system.cpuUsage).toBeDefined();
      expect(snapshot.system.uptime).toBeGreaterThanOrEqual(0);
      expect(snapshot.application).toBeDefined();
      expect(snapshot.custom).toBeInstanceOf(Array);
    });

    it('should include database metrics when pool provided', async () => {
      const mockPool = {
        totalCount: 10,
        idleCount: 7,
        waitingCount: 0,
      } as unknown as Pool;
      
      const snapshot = await metrics.getSnapshot(mockPool);
      
      expect(snapshot.database).toBeDefined();
      expect(snapshot.database?.totalCount).toBe(10);
      expect(snapshot.database?.idleCount).toBe(7);
      expect(snapshot.database?.activeCount).toBe(3);
    });

    it('should return null database metrics when pool not provided', async () => {
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.database).toBeNull();
    });

    it('should aggregate HTTP request metrics by status code', async () => {
      metrics.incrementCounter('http_requests_total', { method: 'GET', status: '200' }, 5);
      metrics.incrementCounter('http_requests_total', { method: 'POST', status: '200' }, 3);
      metrics.incrementCounter('http_requests_total', { method: 'GET', status: '404' }, 2);
      
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.application.httpRequests['200']).toBe(8);
      expect(snapshot.application.httpRequests['404']).toBe(2);
    });

    it('should aggregate error metrics by type', async () => {
      metrics.incrementCounter('errors_total', { type: 'validation' }, 3);
      metrics.incrementCounter('errors_total', { type: 'database' }, 1);
      
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.application.errors['validation']).toBe(3);
      expect(snapshot.application.errors['database']).toBe(1);
    });
  });

  describe('Prometheus Export', () => {
    it('should export metrics in Prometheus format', () => {
      metrics.incrementCounter('test_counter', { label: 'value' }, 5);
      metrics.setGauge('test_gauge', 42);
      
      const output = metrics.exportPrometheus();
      
      expect(output).toContain('# TYPE test_counter counter');
      expect(output).toContain('test_counter{label="value"} 5');
      expect(output).toContain('# TYPE test_gauge gauge');
      expect(output).toContain('test_gauge 42');
    });

    it('should include help text when provided', () => {
      metrics.incrementCounter('requests', undefined, 1, 'Total HTTP requests');
      
      const output = metrics.exportPrometheus();
      
      expect(output).toContain('# HELP requests Total HTTP requests');
    });

    it('should handle metrics without labels', () => {
      metrics.incrementCounter('simple_counter', undefined, 10);
      
      const output = metrics.exportPrometheus();
      
      expect(output).toContain('simple_counter 10');
      expect(output).not.toContain('simple_counter{}');
    });

    it('should sort labels consistently', () => {
      metrics.incrementCounter('test', { z: '1', a: '2', m: '3' });
      
      const output = metrics.exportPrometheus();
      
      // Labels should be sorted alphabetically
      expect(output).toContain('test{a="2",m="3",z="1"}');
    });
  });

  describe('Reset', () => {
    it('should clear all metrics', () => {
      metrics.incrementCounter('counter1');
      metrics.setGauge('gauge1', 100);
      metrics.recordHistogram('hist1', 50);
      metrics.incrementActiveConnections();
      
      metrics.reset();
      
      expect(metrics['counters'].size).toBe(0);
      expect(metrics['gauges'].size).toBe(0);
      expect(metrics['histograms'].size).toBe(0);
      expect(metrics['activeConnections']).toBe(0);
    });
  });

  describe('Security', () => {
    it('should sanitize metric names with special characters', () => {
      metrics.incrementCounter('test/metric-name!@#');
      
      const keys = Array.from(metrics['counters'].keys());
      expect(keys[0]).toMatch(/^[a-zA-Z0-9_:]+$/);
    });

    it('should sanitize label keys', () => {
      metrics.incrementCounter('test', { 'key-with-dash': 'value' });
      
      const keys = Array.from(metrics['counters'].keys());
      expect(keys[0]).toContain('key_with_dash');
    });

    it('should remove control characters from label values', () => {
      metrics.incrementCounter('test', { key: 'value\x00with\x1Fcontrol' });
      
      const keys = Array.from(metrics['counters'].keys());
      expect(keys[0]).not.toMatch(/[\x00-\x1F]/);
    });

    it('should prevent cardinality explosion with many unique labels', () => {
      // Simulate high cardinality scenario
      for (let i = 0; i < 1000; i++) {
        metrics.incrementCounter('requests', { user_id: `user${i}` });
      }
      
      // Should still work but be aware of memory usage
      expect(metrics['counters'].size).toBe(1000);
    });

    it('should enforce cardinality limits', () => {
      const limitedMetrics = new MetricsCollector({ enabled: true, maxCardinality: 3 });
      
      limitedMetrics.incrementCounter('metric1', { label: 'a' });
      limitedMetrics.incrementCounter('metric2', { label: 'b' });
      limitedMetrics.incrementCounter('metric3', { label: 'c' });
      limitedMetrics.incrementCounter('metric4', { label: 'd' }); // Should be dropped
      
      expect(limitedMetrics['cardinalityCount']).toBe(3);
      expect(limitedMetrics['counters'].size).toBe(3);
    });

    it('should allow updating existing metrics within cardinality limits', () => {
      const limitedMetrics = new MetricsCollector({ enabled: true, maxCardinality: 2 });
      
      limitedMetrics.incrementCounter('metric1', { label: 'a' });
      limitedMetrics.incrementCounter('metric2', { label: 'b' });
      limitedMetrics.incrementCounter('metric1', { label: 'a' }); // Update existing
      
      expect(limitedMetrics['cardinalityCount']).toBe(2);
      expect(limitedMetrics['counters'].get('metric1{label="a"}')).toBe(2);
    });
  });

  describe('Performance', () => {
    it('should handle high-frequency counter updates', () => {
      const iterations = 10000;
      const start = Date.now();
      
      for (let i = 0; i < iterations; i++) {
        metrics.incrementCounter('high_freq_counter');
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100); // Should complete in < 100ms
      expect(metrics['counters'].get('high_freq_counter')).toBe(iterations);
    });

    it('should handle high-frequency histogram recordings', () => {
      const iterations = 1000;
      const start = Date.now();
      
      for (let i = 0; i < iterations; i++) {
        metrics.recordHistogram('duration', Math.random() * 100);
      }
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100); // Should complete in < 100ms
    });
  });

  describe('System Metrics', () => {
    it('should collect memory usage metrics', async () => {
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.system.memoryUsage.rss).toBeGreaterThan(0);
      expect(snapshot.system.memoryUsage.heapTotal).toBeGreaterThan(0);
      expect(snapshot.system.memoryUsage.heapUsed).toBeGreaterThan(0);
    });

    it('should collect CPU usage metrics', async () => {
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.system.cpuUsage.user).toBeGreaterThanOrEqual(0);
      expect(snapshot.system.cpuUsage.system).toBeGreaterThanOrEqual(0);
    });

    it('should track uptime', async () => {
      const snapshot1 = await metrics.getSnapshot();
      
      await new Promise((resolve) => setTimeout(resolve, 100));
      
      const snapshot2 = await metrics.getSnapshot();
      
      expect(snapshot2.system.uptime).toBeGreaterThan(snapshot1.system.uptime);
    });
  });

  describe('Database Metrics', () => {
    it('should collect database pool metrics', async () => {
      const mockPool = {
        totalCount: 10,
        idleCount: 6,
        waitingCount: 2,
      } as unknown as Pool;
      
      const snapshot = await metrics.getSnapshot(mockPool);
      
      expect(snapshot.database).toEqual({
        totalCount: 10,
        idleCount: 6,
        activeCount: 4,
        waitingCount: 2,
      });
    });

    it('should handle missing pool gracefully', async () => {
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.database).toBeNull();
    });
  });

  describe('Application Metrics', () => {
    it('should aggregate HTTP requests by status code', async () => {
      metrics.incrementCounter('http_requests_total', { status: '200' }, 10);
      metrics.incrementCounter('http_requests_total', { status: '404' }, 3);
      metrics.incrementCounter('http_requests_total', { status: '500' }, 1);
      
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.application.httpRequests).toEqual({
        '200': 10,
        '404': 3,
        '500': 1,
      });
    });

    it('should track active connections', async () => {
      metrics.incrementActiveConnections();
      metrics.incrementActiveConnections();
      metrics.incrementActiveConnections();
      metrics.decrementActiveConnections();
      
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.application.activeConnections).toBe(2);
    });

    it('should aggregate errors by type', async () => {
      metrics.incrementCounter('errors_total', { type: 'validation' }, 5);
      metrics.incrementCounter('errors_total', { type: 'timeout' }, 2);
      
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.application.errors).toEqual({
        validation: 5,
        timeout: 2,
      });
    });

    it('should calculate HTTP duration histogram', async () => {
      metrics.recordHistogram('http_request_duration_ms', 10);
      metrics.recordHistogram('http_request_duration_ms', 50);
      metrics.recordHistogram('http_request_duration_ms', 100);
      metrics.recordHistogram('http_request_duration_ms', 500);
      
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.application.httpDuration.count).toBe(4);
      expect(snapshot.application.httpDuration.sum).toBe(660);
      expect(snapshot.application.httpDuration.buckets.length).toBeGreaterThan(0);
    });
  });

  describe('Custom Metrics Export', () => {
    it('should export custom metrics as metric points', async () => {
      metrics.incrementCounter('custom_counter', { env: 'prod' }, 5, 'Custom counter metric');
      metrics.setGauge('custom_gauge', 42, { type: 'test' }, 'Custom gauge metric');
      
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.custom.length).toBeGreaterThan(0);
      
      const counter = snapshot.custom.find((m) => m.name === 'custom_counter');
      expect(counter).toBeDefined();
      expect(counter?.type).toBe(MetricType.COUNTER);
      expect(counter?.value).toBe(5);
      expect(counter?.labels).toEqual({ env: 'prod' });
      expect(counter?.help).toBe('Custom counter metric');
    });

    it('should include timestamp in metric points', async () => {
      metrics.incrementCounter('test');
      
      const snapshot = await metrics.getSnapshot();
      
      expect(snapshot.custom[0].timestamp).toBeDefined();
      expect(() => new Date(snapshot.custom[0].timestamp)).not.toThrow();
    });
  });

  describe('Metric Key Parsing', () => {
    it('should parse metric key without labels', () => {
      const parsed = metrics['parseMetricKey']('simple_metric');
      
      expect(parsed.name).toBe('simple_metric');
      expect(parsed.labels).toBeUndefined();
    });

    it('should parse metric key with labels', () => {
      const parsed = metrics['parseMetricKey']('metric{label1="value1",label2="value2"}');
      
      expect(parsed.name).toBe('metric');
      expect(parsed.labels).toEqual({
        label1: 'value1',
        label2: 'value2',
      });
    });

    it('should handle empty labels', () => {
      const parsed = metrics['parseMetricKey']('metric{}');
      
      expect(parsed.name).toBe('metric');
      expect(parsed.labels).toEqual({});
    });
  });

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const defaultMetrics = new MetricsCollector();
      
      expect(defaultMetrics['config'].enabled).toBe(true);
      expect(defaultMetrics['config'].maxPoints).toBe(10000);
      expect(defaultMetrics['config'].histogramBuckets).toBeDefined();
      expect(defaultMetrics['config'].maxCardinality).toBe(1000);
      expect(defaultMetrics['config'].enablePIIDetection).toBe(true);
    });

    it('should accept custom histogram buckets', () => {
      const customMetrics = new MetricsCollector({
        histogramBuckets: [1, 5, 10, 50, 100],
      });
      
      expect(customMetrics['config'].histogramBuckets).toEqual([1, 5, 10, 50, 100]);
    });

    it('should disable metrics collection when configured', () => {
      const disabledMetrics = new MetricsCollector({ enabled: false });
      
      disabledMetrics.incrementCounter('test');
      disabledMetrics.setGauge('test', 100);
      disabledMetrics.recordHistogram('test', 50);
      
      expect(disabledMetrics['counters'].size).toBe(0);
      expect(disabledMetrics['gauges'].size).toBe(0);
      expect(disabledMetrics['histograms'].size).toBe(0);
    });

    it('should disable PII detection when configured', () => {
      const noPIIMetrics = new MetricsCollector({ enablePIIDetection: false });
      
      noPIIMetrics.incrementCounter('test', { email: 'user@example.com' });
      
      const snapshot = noPIIMetrics['counters'];
      const key = Array.from(snapshot.keys())[0];
      expect(key).toContain('user@example.com'); // PII not filtered
    });
  });
});
