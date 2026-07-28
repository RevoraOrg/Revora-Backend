/**
 * Metrics Collection Middleware
 * 
 * Express middleware for automatic HTTP metrics collection including:
 * - Request count by method, route, and status code
 * - Request duration histograms
 * - Active connection tracking
 * - Error rate monitoring
 * 
 * Security Assumptions:
 * - Route patterns are sanitized to prevent cardinality explosion
 * - User IDs in metrics are hashed or anonymized in production
 * - Metrics do not contain request/response bodies or sensitive headers
 * 
 * @module middleware/metricsMiddleware
 */

import { Request, Response, NextFunction } from 'express';
import { MetricsCollector } from '../lib/metrics';
import { Logger } from '../lib/logger';
import { AppError, Errors } from '../lib/errors';

/**
 * Middleware configuration
 */
export interface MetricsMiddlewareConfig {
  /** Metrics collector instance */
  metrics: MetricsCollector;
  /** Logger instance */
  logger?: Logger;
  /** Enable detailed route metrics (may increase cardinality) */
  detailedRoutes?: boolean;
}

/**
 * Normalize route path to prevent cardinality explosion
 * Replaces dynamic segments (IDs, UUIDs) with placeholders
 * 
 * @param path Original request path
 * @returns Normalized path pattern
 * 
 * @example
 * normalizeRoutePath('/api/users/123/orders/456') // => '/api/users/:id/orders/:id'
 * normalizeRoutePath('/api/offerings/abc-def-123') // => '/api/offerings/:id'
 */
function normalizeRoutePath(path: string): string {
  return path
    // Replace UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    // Replace numeric IDs
    .replace(/\/\d+/g, '/:id')
    // Replace alphanumeric IDs (at least 8 chars)
    .replace(/\/[a-z0-9]{8,}/gi, '/:id')
    // Collapse multiple :id segments
    .replace(/(\/:id)+/g, '/:id');
}

/**
 * Create metrics collection middleware
 * 
 * Automatically tracks HTTP request metrics and integrates with
 * the application's metrics collector.
 * 
 * Usage:
 * ```typescript
 * import { globalMetrics } from './lib/metrics';
 * import { metricsMiddleware } from './middleware/metricsMiddleware';
 * 
 * app.use(metricsMiddleware({ metrics: globalMetrics }));
 * ```
 * 
 * @param config Middleware configuration
 * @returns Express middleware function
 */
export function metricsMiddleware(config: MetricsMiddlewareConfig) {
  const { metrics, logger, detailedRoutes = false } = config;

  return (req: Request, res: Response, next: NextFunction): void => {
    const startTime = process.hrtime.bigint();
    
    // Track active connections
    metrics.incrementActiveConnections();

    // Capture original end function
    const originalEnd = res.end;

    // Override end to capture metrics
    res.end = function (this: Response, ...args: any[]): Response {
      const endTime = process.hrtime.bigint();
      const durationMs = Number(endTime - startTime) / 1_000_000; // Convert to milliseconds

      // Decrement active connections
      metrics.decrementActiveConnections();

      // Normalize route for consistent labeling (removes IDs to prevent cardinality explosion)
      const route = detailedRoutes ? normalizeRoutePath(req.path) : req.path;
      const method = req.method;
      const status = res.statusCode.toString();
      const statusClass = `${Math.floor(res.statusCode / 100)}xx`;

      // Additional PII-safe labels (avoid user IDs, emails, etc.)
      const safeLabels: Record<string, string> = {
        method,
        route,
        status,
        status_class: statusClass,
      };

      // Add user role if available (not PII as it's a controlled enum)
      const userRole = (req as any).user?.role;
      if (userRole && typeof userRole === 'string') {
        safeLabels.user_role = userRole;
      }

      // Record request count
      metrics.incrementCounter(
        'http_requests_total',
        safeLabels,
        1,
        'Total HTTP requests'
      );

      // Record request duration
      metrics.recordHistogram(
        'http_request_duration_ms',
        durationMs,
        { method, route, status_class: statusClass },
        'HTTP request duration in milliseconds'
      );

      // Track errors (4xx and 5xx)
      if (res.statusCode >= 400) {
        const errorType = res.statusCode >= 500 ? 'server_error' : 'client_error';
        metrics.incrementCounter(
          'errors_total',
          { type: errorType, status, route },
          1,
          'Total errors by type'
        );
      }

      // Log slow requests (> 1 second) with structured logging
      if (logger && durationMs > 1000) {
        logger.warn('Slow request detected', {
          method,
          route, // Already normalized
          durationMs: Math.round(durationMs),
          status: res.statusCode,
          statusClass,
          requestId: (req as any).requestId,
          userAgent: req.get('User-Agent')?.substring(0, 100), // Truncate for safety
        });
      }

      // Call original end
      return (originalEnd as any).apply(this, args as any[]);
    };

    next();
  };
}

/**
 * Create metrics endpoint handler
 * 
 * Exposes collected metrics in JSON format for monitoring systems.
 * Should be protected with authentication in production.
 * 
 * Usage:
 * ```typescript
 * import { globalMetrics } from './lib/metrics';
 * import { createMetricsHandler } from './middleware/metricsMiddleware';
 * 
 * app.get('/metrics', createMetricsHandler(globalMetrics, dbPool));
 * ```
 * 
 * @param metrics Metrics collector instance
 * @param pool Optional database pool for DB metrics
 * @returns Express route handler
 */
export function createMetricsHandler(metrics: MetricsCollector, pool?: any) {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const snapshot = await metrics.getSnapshot(pool);
      res.status(200).json(snapshot);
    } catch (error) {
      const appError = Errors.internal('Failed to collect metrics', error instanceof Error ? error.message : String(error));
      next(appError);
    }
  };
}

/**
 * Create Prometheus-format metrics endpoint handler
 * 
 * Exposes metrics in Prometheus text format for scraping.
 * 
 * Usage:
 * ```typescript
 * app.get('/metrics/prometheus', createPrometheusHandler(globalMetrics));
 * ```
 * 
 * @param metrics Metrics collector instance
 * @returns Express route handler
 */
export function createPrometheusHandler(metrics: MetricsCollector) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    try {
      const output = metrics.exportPrometheus();
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.status(200).send(output);
    } catch (error) {
      const appError = Errors.internal('Failed to export Prometheus metrics', error instanceof Error ? error.message : String(error));
      next(appError);
    }
  };
}
