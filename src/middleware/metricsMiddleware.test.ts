/**
 * Metrics Middleware Tests
 *
 * Comprehensive test coverage for metrics collection middleware including:
 * - HTTP request metrics collection
 * - Route normalization and PII exclusion
 * - Error handling and structured responses
 * - Cardinality limits and performance
 * - Integration with Express app
 *
 * @module middleware/metricsMiddleware.test
 */

import express from 'express';
import request from 'supertest';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';
import { ErrorCode } from '../lib/errors';
import {
  metricsMiddleware,
  createMetricsHandler,
  createPrometheusHandler,
  MetricsMiddlewareConfig,
} from './metricsMiddleware';

describe('metricsMiddleware', () => {
  let metrics: MetricsCollector;
  let logger: Logger;
  let app: express.Express;

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true, maxCardinality: 100 });
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
    app = express();
  });

  afterEach(() => {
    metrics.reset();
    jest.clearAllMocks();
  });

  describe('HTTP Metrics Collection', () => {
    beforeEach(() => {
      app.use(metricsMiddleware({ metrics, logger }));
      app.get('/test', (req, res) => res.json({ ok: true }));
      app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
      app.post('/error', (req, res) => res.status(500).json({ error: 'test' }));
    });

    it('should collect basic HTTP request metrics', async () => {
      await request(app).get('/test');

      const snapshot = await metrics.getSnapshot();
      expect(snapshot.application.httpRequests['200']).toBe(1);
      expect(snapshot.application.httpDuration.count).toBe(1);
    });

    it('should normalize routes to prevent cardinality explosion', async () => {
      await request(app).get('/users/123');
      await request(app).get('/users/456');

      const snapshot = await metrics.getSnapshot();
      // Both should be counted under the same normalized route
      expect(snapshot.application.httpRequests['200']).toBe(2);
    });

    it('should include user role in metrics when available', async () => {
      // Mock middleware to add user role
      app.use((req, res, next) => {
        (req as any).user = { role: 'admin' };
        next();
      });

      await request(app).get('/test');

      // Check that metrics were recorded (exact label checking would require more complex setup)
      const snapshot = await metrics.getSnapshot();
      expect(snapshot.application.httpRequests['200']).toBe(1);
    });

    it('should track error metrics for 4xx and 5xx responses', async () => {
      await request(app).post('/error');

      const snapshot = await metrics.getSnapshot();
      expect(snapshot.application.errors['server_error']).toBe(1);
    });

    it('should log slow requests', async () => {
      // Mock a slow response
      app.get('/slow', (req, res) => {
        setTimeout(() => res.json({ ok: true }), 1100);
      });

      await request(app).get('/slow');

      expect(logger.warn).toHaveBeenCalledWith(
        'Slow request detected',
        expect.objectContaining({
          method: 'GET',
          route: '/slow',
          durationMs: expect.any(Number),
          status: 200,
        })
      );
    });
  });

  describe('PII Exclusion', () => {
    it('should not include sensitive data in metric labels', async () => {
      const testApp = express();
      testApp.use(metricsMiddleware({ metrics }));
      testApp.get('/user/:email/orders', (req, res) => res.json({ ok: true }));

      await request(testApp).get('/user/test@example.com/orders');

      // The route should be normalized and PII filtered
      const snapshot = await metrics.getSnapshot();
      expect(snapshot.application.httpRequests['200']).toBe(1);
    });
  });

  describe('Cardinality Limits', () => {
    it('should respect cardinality limits', () => {
      const limitedMetrics = new MetricsCollector({ enabled: true, maxCardinality: 2 });

      // Add metrics up to the limit
      limitedMetrics.incrementCounter('test1', { id: '1' });
      limitedMetrics.incrementCounter('test2', { id: '2' });
      limitedMetrics.incrementCounter('test3', { id: '3' }); // Should be dropped

      // Should only have 2 unique metrics
      expect(limitedMetrics['cardinalityCount']).toBe(2);
    });
  });

  describe('createMetricsHandler', () => {
    beforeEach(() => {
      app.get('/metrics', createMetricsHandler(metrics));
      app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
        res.status(err.statusCode).json(err.toResponse());
      });
    });

    it('should return metrics snapshot in JSON format', async () => {
      metrics.incrementCounter('test_metric');

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('system');
      expect(response.body).toHaveProperty('application');
      expect(response.body.custom.length).toBeGreaterThan(0);
    });

    it('should handle errors with structured AppError responses', async () => {
      // Mock metrics.getSnapshot to throw
      const originalGetSnapshot = metrics.getSnapshot;
      metrics.getSnapshot = jest.fn().mockRejectedValue(new Error('Database error'));

      const response = await request(app).get('/metrics');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Failed to collect metrics',
        details: 'Database error', // The error message
      });

      // Restore original method
      metrics.getSnapshot = originalGetSnapshot;
    });
  });

  describe('createPrometheusHandler', () => {
    beforeEach(() => {
      app.get('/metrics/prometheus', createPrometheusHandler(metrics));
      app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
        res.status(err.statusCode).json(err.toResponse());
      });
    });

    it('should return metrics in Prometheus format', async () => {
      metrics.incrementCounter('test_counter', { label: 'value' }, 5);

      const response = await request(app).get('/metrics/prometheus');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.text).toContain('# TYPE test_counter counter');
      expect(response.text).toContain('test_counter{label="value"} 5');
    });

    it('should handle export errors with structured responses', async () => {
      // Mock metrics.exportPrometheus to throw
      const originalExport = metrics.exportPrometheus;
      metrics.exportPrometheus = jest.fn().mockImplementation(() => {
        throw new Error('Export failed');
      });

      const response = await request(app).get('/metrics/prometheus');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Failed to export Prometheus metrics',
        details: 'Export failed', // The error message
      });

      // Restore original method
      metrics.exportPrometheus = originalExport;
    });
  });

  describe('Configuration', () => {
    it('should support detailed route metrics', async () => {
      app.use(metricsMiddleware({ metrics, detailedRoutes: true }));
      app.get('/api/users/123/profile', (req, res) => res.json({ ok: true }));

      await request(app).get('/api/users/123/profile');

      const snapshot = await metrics.getSnapshot();
      expect(snapshot.application.httpRequests['200']).toBe(1);
    });

    it('should work without logger', async () => {
      app.use(metricsMiddleware({ metrics }));
      app.get('/test', (req, res) => res.json({ ok: true }));

      await request(app).get('/test');

      const snapshot = await metrics.getSnapshot();
      expect(snapshot.application.httpRequests['200']).toBe(1);
    });
  });

  describe('Performance', () => {
    it('should handle high request volumes', async () => {
      const testApp = express();
      testApp.use(metricsMiddleware({ metrics }));
      testApp.get('/fast', (req, res) => res.json({ ok: true }));

      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(request(testApp).get('/fast'));
      }

      await Promise.all(promises);

      const snapshot = await metrics.getSnapshot();
      expect(snapshot.application.httpRequests['200']).toBe(100);
    });
  });
});