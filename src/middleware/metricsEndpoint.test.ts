/**
 * @file src/middleware/metricsEndpoint.test.ts
 * @description
 * Test suite for the /metrics endpoint with Prometheus format export.
 * 
 * Coverage:
 * - Bearer token authentication in production
 * - Development/test environment access without auth
 * - Prometheus text format compliance
 * - PII filtering in metric labels
 * - Cardinality limit enforcement
 * - Empty registry handling
 * - Timing-safe token comparison
 */

import request from 'supertest';
import express from 'express';
import { MetricsCollector } from '../lib/metrics';
import { createPrometheusHandler } from './metricsMiddleware';

describe('Metrics Endpoint', () => {
  let app: express.Express;
  let metrics: MetricsCollector;
  const originalEnv = process.env.NODE_ENV;
  const originalToken = process.env.METRICS_TOKEN;

  beforeEach(() => {
    metrics = new MetricsCollector({
      enabled: true,
      maxCardinality: 1000,
      enablePIIDetection: true,
    });
    
    app = express();
    
    // Middleware to secure metrics endpoint
    app.get('/metrics', (req, res, next) => {
      const metricsToken = process.env.METRICS_TOKEN;
      const nodeEnv = process.env.NODE_ENV;

      // In development/test, allow access without token
      if (nodeEnv === 'development' || nodeEnv === 'test') {
        next();
        return;
      }

      // In production, require METRICS_TOKEN
      if (!metricsToken) {
        res.status(503).json({
          error: 'Metrics endpoint not configured',
          message: 'METRICS_TOKEN environment variable must be set',
        });
        return;
      }

      // Extract bearer token
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Bearer token required',
        });
        return;
      }

      const token = authHeader.substring(7);

      // Timing-safe comparison
      const crypto = require('crypto');
      try {
        if (token.length !== metricsToken.length || 
            !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(metricsToken))) {
          res.status(401).json({
            error: 'Unauthorized',
            message: 'Invalid token',
          });
          return;
        }
      } catch {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid token',
        });
        return;
      }

      next();
    }, createPrometheusHandler(metrics));
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    process.env.METRICS_TOKEN = originalToken;
    metrics.reset();
  });

  describe('Authentication', () => {
    it('allows access without token in test environment', async () => {
      process.env.NODE_ENV = 'test';
      delete process.env.METRICS_TOKEN;

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
    });

    it('allows access without token in development environment', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.METRICS_TOKEN;

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
    });

    it('returns 503 when METRICS_TOKEN not set in production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.METRICS_TOKEN;

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: 'Metrics endpoint not configured',
        message: 'METRICS_TOKEN environment variable must be set',
      });
    });

    it('returns 401 when no Authorization header in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.METRICS_TOKEN = 'test-token-12345';

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: 'Unauthorized',
        message: 'Bearer token required',
      });
    });

    it('returns 401 when Authorization header is not Bearer', async () => {
      process.env.NODE_ENV = 'production';
      process.env.METRICS_TOKEN = 'test-token-12345';

      const response = await request(app)
        .get('/metrics')
        .set('Authorization', 'Basic dXNlcjpwYXNz');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: 'Unauthorized',
        message: 'Bearer token required',
      });
    });

    it('returns 401 when token is invalid', async () => {
      process.env.NODE_ENV = 'production';
      process.env.METRICS_TOKEN = 'correct-token-12345';

      const response = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token-12345');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({
        error: 'Unauthorized',
        message: 'Invalid token',
      });
    });

    it('allows access with valid token in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.METRICS_TOKEN = 'correct-token-12345';

      const response = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer correct-token-12345');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
    });

    it('uses timing-safe comparison for token validation', async () => {
      process.env.NODE_ENV = 'production';
      process.env.METRICS_TOKEN = 'a'.repeat(32);

      // Try with token of different length (should fail)
      const response1 = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer ' + 'b'.repeat(16));

      expect(response1.status).toBe(401);

      // Try with token of same length but different content (should fail)
      const response2 = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer ' + 'b'.repeat(32));

      expect(response2.status).toBe(401);

      // Try with correct token (should succeed)
      const response3 = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer ' + 'a'.repeat(32));

      expect(response3.status).toBe(200);
    });
  });

  describe('Prometheus Format', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('returns metrics in Prometheus text format', async () => {
      metrics.incrementCounter('test_counter', { label: 'value' }, 5);
      metrics.setGauge('test_gauge', 42, { status: 'active' });

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain; version=0.0.4');
      expect(response.text).toContain('# TYPE test_counter counter');
      expect(response.text).toContain('test_counter{label="value"} 5');
      expect(response.text).toContain('# TYPE test_gauge gauge');
      expect(response.text).toContain('test_gauge{status="active"} 42');
    });

    it('includes HELP comments when provided', async () => {
      metrics.incrementCounter(
        'http_requests_total',
        { method: 'GET', status: '200' },
        1,
        'Total HTTP requests'
      );

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).toContain('# HELP http_requests_total Total HTTP requests');
      expect(response.text).toContain('# TYPE http_requests_total counter');
    });

    it('handles empty metrics registry', async () => {
      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain; version=0.0.4');
      expect(response.text).toBe('\n'); // Empty output with trailing newline
    });

    it('formats labels correctly', async () => {
      metrics.incrementCounter('test_metric', {
        method: 'GET',
        route: '/api/users',
        status: '200',
      });

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).toContain('test_metric{method="GET",route="/api/users",status="200"}');
    });

    it('includes timestamps', async () => {
      metrics.incrementCounter('test_counter', {}, 1);

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      // Timestamp should be present (13-digit Unix timestamp in milliseconds)
      expect(response.text).toMatch(/test_counter \d+ \d{13}/);
    });
  });

  describe('PII Filtering', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('redacts email addresses in labels', async () => {
      metrics.incrementCounter('user_actions', { user: 'test@example.com' });

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).not.toContain('test@example.com');
      expect(response.text).toContain('[REDACTED_EMAIL]');
    });

    it('redacts phone numbers in labels', async () => {
      metrics.incrementCounter('user_actions', { phone: '+1-555-0123' });

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).not.toContain('+1-555-0123');
      expect(response.text).toContain('[REDACTED_PHONE]');
    });

    it('redacts IP addresses in labels', async () => {
      metrics.incrementCounter('requests', { ip: '192.168.1.1' });

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).not.toContain('192.168.1.1');
      expect(response.text).toContain('[REDACTED_IP]');
    });

    it('redacts UUIDs in labels', async () => {
      metrics.incrementCounter('operations', {
        id: '550e8400-e29b-41d4-a716-446655440000',
      });

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).not.toContain('550e8400-e29b-41d4-a716-446655440000');
      expect(response.text).toContain('[REDACTED_ID]');
    });

    it('redacts long numeric IDs in labels', async () => {
      metrics.incrementCounter('transactions', { account: '1234567890123' });

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).not.toContain('1234567890123');
      expect(response.text).toContain('[REDACTED_NUMERIC_ID]');
    });

    it('preserves safe label values', async () => {
      metrics.incrementCounter('http_requests', {
        method: 'GET',
        route: '/api/users',
        status: '200',
      });

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).toContain('method="GET"');
      expect(response.text).toContain('route="/api/users"');
      expect(response.text).toContain('status="200"');
    });
  });

  describe('Cardinality Limits', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('enforces maximum cardinality limit', async () => {
      const smallMetrics = new MetricsCollector({
        enabled: true,
        maxCardinality: 5,
        enablePIIDetection: false,
      });

      const smallApp = express();
      smallApp.get('/metrics', createPrometheusHandler(smallMetrics));

      // Add metrics up to the limit
      for (let i = 0; i < 5; i++) {
        smallMetrics.incrementCounter('test_counter', { id: `${i}` });
      }

      // Try to add one more (should be silently dropped)
      smallMetrics.incrementCounter('test_counter', { id: '5' });

      const response = await request(smallApp).get('/metrics');

      expect(response.status).toBe(200);
      // Should only have 5 metrics, not 6
      const lines = response.text.split('\n').filter(line => 
        line.startsWith('test_counter') && !line.startsWith('#')
      );
      expect(lines.length).toBe(5);
    });

    it('counts unique metric combinations correctly', async () => {
      const smallMetrics = new MetricsCollector({
        enabled: true,
        maxCardinality: 3,
        enablePIIDetection: false,
      });

      const smallApp = express();
      smallApp.get('/metrics', createPrometheusHandler(smallMetrics));

      // Same metric name, different labels = different combinations
      smallMetrics.incrementCounter('requests', { method: 'GET' });
      smallMetrics.incrementCounter('requests', { method: 'POST' });
      smallMetrics.incrementCounter('requests', { method: 'PUT' });

      // This should be dropped (exceeds cardinality)
      smallMetrics.incrementCounter('requests', { method: 'DELETE' });

      const response = await request(smallApp).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).toContain('method="GET"');
      expect(response.text).toContain('method="POST"');
      expect(response.text).toContain('method="PUT"');
      expect(response.text).not.toContain('method="DELETE"');
    });
  });

  describe('Multiple Metric Types', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('exports counters and gauges together', async () => {
      metrics.incrementCounter('http_requests_total', { status: '200' }, 100);
      metrics.setGauge('active_connections', 42);
      metrics.incrementCounter('errors_total', { type: 'timeout' }, 5);

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).toContain('# TYPE http_requests_total counter');
      expect(response.text).toContain('http_requests_total{status="200"} 100');
      expect(response.text).toContain('# TYPE active_connections gauge');
      expect(response.text).toContain('active_connections 42');
      expect(response.text).toContain('# TYPE errors_total counter');
      expect(response.text).toContain('errors_total{type="timeout"} 5');
    });

    it('handles metrics without labels', async () => {
      metrics.incrementCounter('total_requests', undefined, 1523);
      metrics.setGauge('uptime_seconds', 3600);

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).toContain('total_requests 1523');
      expect(response.text).toContain('uptime_seconds 3600');
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('handles metrics collection errors gracefully', async () => {
      // Create a metrics instance that might throw
      const faultyMetrics = new MetricsCollector({ enabled: true });
      
      // Override exportPrometheus to throw
      faultyMetrics.exportPrometheus = () => {
        throw new Error('Metrics export failed');
      };

      const faultyApp = express();
      faultyApp.get('/metrics', createPrometheusHandler(faultyMetrics));
      faultyApp.use((err: any, req: any, res: any, next: any) => {
        res.status(500).json({ error: err.message });
      });

      const response = await request(faultyApp).get('/metrics');

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error');
    });
  });

  describe('Integration', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'test';
    });

    it('exports real HTTP metrics after requests', async () => {
      // Create a full app with metrics middleware
      const testApp = express();
      const testMetrics = new MetricsCollector({ enabled: true });

      // Add metrics middleware
      testApp.use((req, res, next) => {
        const start = process.hrtime.bigint();
        testMetrics.incrementActiveConnections();

        res.on('finish', () => {
          const duration = Number(process.hrtime.bigint() - start) / 1_000_000;
          testMetrics.decrementActiveConnections();
          testMetrics.incrementCounter('http_requests_total', {
            method: req.method,
            status: res.statusCode.toString(),
          });
          testMetrics.recordHistogram('http_request_duration_ms', duration, {
            method: req.method,
          });
        });

        next();
      });

      // Add test routes
      testApp.get('/test', (req, res) => res.json({ ok: true }));
      testApp.get('/metrics', createPrometheusHandler(testMetrics));

      // Make some requests
      await request(testApp).get('/test');
      await request(testApp).get('/test');

      // Check metrics
      const response = await request(testApp).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.text).toContain('http_requests_total');
      expect(response.text).toContain('method="GET"');
      expect(response.text).toContain('status="200"');
    });
  });
});
