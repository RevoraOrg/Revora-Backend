/**
 * Metrics Test Utilities
 * 
 * Helper functions for extracting and analyzing metrics from MetricsCollector
 * during performance tests.
 * 
 * @module __tests__/metrics-test-utils
 */

import { MetricsCollector, MetricsSnapshot } from '../lib/metrics';

/**
 * Histogram statistics computed from observations
 */
export interface HistogramStats {
  /** Minimum observed value */
  min: number;
  /** Maximum observed value */
  max: number;
  /** Average of all observations */
  mean: number;
  /** Median (p50) value */
  p50: number;
  /** 95th percentile */
  p95: number;
  /** 99th percentile (p99) */
  p99: number;
  /** 99.9th percentile (p999) */
  p999: number;
  /** Total number of observations */
  count: number;
  /** Sum of all observations */
  sum: number;
}

/**
 * Extract histogram observations from a metrics snapshot for a specific route
 * 
 * @param snapshot Metrics snapshot from collector
 * @param method HTTP method (GET, POST, etc.)
 * @param routePath Route path (may include normalized pattern like /api/v1/health)
 * @returns Array of observed latencies in milliseconds, or empty if route not found
 * 
 * @example
 * const snapshot = await metrics.getSnapshot();
 * const observations = extractHistogramObservations(snapshot, 'GET', '/api/v1/health');
 * const p99 = calculatePercentile(observations, 99);
 */
export function extractHistogramObservations(
  snapshot: MetricsSnapshot,
  method: string,
  routePath: string
): number[] {
  // Look for http_request_duration_ms metric matching the route and method
  const observations: number[] = [];
  
  for (const metric of snapshot.custom) {
    if (metric.name !== 'http_request_duration_ms') {
      continue;
    }
    
    const labels = metric.labels || {};
    const matchesMethod = labels.method?.toUpperCase() === method.toUpperCase();
    const matchesRoute = normalizePathForComparison(labels.route || '') === 
                         normalizePathForComparison(routePath);
    
    if (matchesMethod && matchesRoute) {
      // The metric value is the sum; we need to access the actual histogram data
      // This is handled by accessing the internal structure if available
      break;
    }
  }
  
  // If we can't find it in custom metrics, return empty
  // This is because the MetricsSnapshot structure aggregates histograms
  // For testing, we'll need to access the raw histogram data directly
  return observations;
}

/**
 * Extract raw histogram observations directly from MetricsCollector
 * 
 * This function accesses the internal histogram storage of MetricsCollector
 * to get the actual observations for a specific route.
 * 
 * @param metrics MetricsCollector instance (cast as any for internal access)
 * @param method HTTP method
 * @param routePath Route path
 * @returns Array of observed latencies in milliseconds
 */
export function extractRawHistogramObservations(
  metrics: MetricsCollector,
  method: string,
  routePath: string
): number[] {
  // Access internal histogram storage (metrics as any to access private properties)
  const metricsAny = metrics as any;
  const histograms: Map<string, number[]> = metricsAny.histograms || new Map();
  
  const normalizedRoute = normalizePathForComparison(routePath);
  const normalizedMethod = method.toUpperCase();
  
  // Find the histogram key matching this route and method
  for (const [key, observations] of histograms.entries()) {
    if (key.includes('http_request_duration_ms')) {
      // Check if labels match
      const match = key.match(/method="([^"]*)".*route="([^"]*)"/);
      if (match) {
        const routeInKey = normalizePathForComparison(match[2]);
        const methodInKey = match[1].toUpperCase();
        
        if (methodInKey === normalizedMethod && routeInKey === normalizedRoute) {
          return [...observations]; // Return a copy
        }
      }
    }
  }
  
  return [];
}

/**
 * Calculate percentile value from sorted observations
 * 
 * @param sortedObservations Array of values sorted in ascending order
 * @param percentile Percentile to calculate (0-100)
 * @returns Percentile value, or undefined if insufficient data
 * 
 * @example
 * const p99 = calculatePercentile([1, 2, 3, ..., 100], 99); // ~99th value
 */
export function calculatePercentile(
  sortedObservations: number[],
  percentile: number
): number | undefined {
  if (sortedObservations.length === 0) {
    return undefined;
  }
  
  if (sortedObservations.length === 1) {
    return sortedObservations[0];
  }
  
  // Validate percentile
  if (percentile < 0 || percentile > 100) {
    throw new Error(`Percentile must be between 0 and 100, got ${percentile}`);
  }
  
  // Linear interpolation method for percentiles
  // Matches common histogram implementations
  const index = (percentile / 100) * (sortedObservations.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index % 1;
  
  if (lower === upper) {
    return sortedObservations[lower];
  }
  
  return (
    sortedObservations[lower] * (1 - weight) +
    sortedObservations[upper] * weight
  );
}

/**
 * Compute comprehensive histogram statistics from observations
 * 
 * @param observations Array of observed values (order does not matter)
 * @returns Histogram statistics including percentiles
 * 
 * @example
 * const observations = [10, 20, 30, 40, 50];
 * const stats = computeHistogramStats(observations);
 * console.log(stats.p99); // 99th percentile
 */
export function computeHistogramStats(observations: number[]): HistogramStats {
  if (observations.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      p999: 0,
      count: 0,
      sum: 0,
    };
  }
  
  // Sort observations for percentile calculation
  const sorted = [...observations].sort((a, b) => a - b);
  
  const sum = sorted.reduce((acc, val) => acc + val, 0);
  const mean = sum / sorted.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  
  return {
    min,
    max,
    mean,
    p50: calculatePercentile(sorted, 50) ?? 0,
    p95: calculatePercentile(sorted, 95) ?? 0,
    p99: calculatePercentile(sorted, 99) ?? 0,
    p999: calculatePercentile(sorted, 99.9) ?? 0,
    count: sorted.length,
    sum,
  };
}

/**
 * Normalize path for consistent comparison across routes
 * Removes trailing slashes and ensures consistent format
 * 
 * @param path Route path
 * @returns Normalized path
 */
function normalizePathForComparison(path: string): string {
  return path.replace(/^\/+/, '/').replace(/\/+$/, '');
}

/**
 * Assert that p99 latency is within budget
 * 
 * @param p99Value Observed p99 latency in milliseconds
 * @param budgetMs P99 latency budget in milliseconds
 * @param routeName Name of the route being tested
 * @throws Error if p99 exceeds budget
 * 
 * @example
 * assertP99WithinBudget(185.5, 200, 'Health Check');
 */
export function assertP99WithinBudget(
  p99Value: number,
  budgetMs: number,
  routeName: string
): void {
  if (p99Value > budgetMs) {
    throw new Error(
      `p99 latency for "${routeName}" exceeded budget: ` +
      `${p99Value.toFixed(2)}ms > ${budgetMs}ms`
    );
  }
}

/**
 * Format latency statistics for logging and reporting
 * 
 * @param stats Histogram statistics
 * @param routeName Name of the route
 * @returns Formatted statistics string
 */
export function formatLatencyStats(stats: HistogramStats, routeName: string): string {
  return (
    `${routeName}: ` +
    `n=${stats.count}, ` +
    `min=${stats.min.toFixed(2)}ms, ` +
    `p50=${stats.p50.toFixed(2)}ms, ` +
    `p95=${stats.p95.toFixed(2)}ms, ` +
    `p99=${stats.p99.toFixed(2)}ms, ` +
    `p999=${stats.p999.toFixed(2)}ms, ` +
    `max=${stats.max.toFixed(2)}ms`
  );
}

/**
 * Detailed histogram failure report with context
 * 
 * @param stats Histogram statistics
 * @param routeName Name of the route
 * @param budgetMs P99 budget in milliseconds
 * @param requestCount Number of requests made
 * @returns Detailed failure report string
 */
export function formatHistogramFailureReport(
  stats: HistogramStats,
  routeName: string,
  budgetMs: number,
  requestCount: number
): string {
  const exceedanceMs = stats.p99 - budgetMs;
  const exceedancePercent = (exceedanceMs / budgetMs) * 100;
  
  return (
    `\nP99 LATENCY BUDGET EXCEEDED: ${routeName}\n` +
    `Budget: ${budgetMs}ms | Observed p99: ${stats.p99.toFixed(2)}ms\n` +
    `Exceedance: ${exceedanceMs.toFixed(2)}ms (+${exceedancePercent.toFixed(1)}%)\n` +
    `Requests: ${requestCount} | Min: ${stats.min.toFixed(2)}ms | Max: ${stats.max.toFixed(2)}ms\n` +
    `p50: ${stats.p50.toFixed(2)}ms | p95: ${stats.p95.toFixed(2)}ms | p999: ${stats.p999.toFixed(2)}ms`
  );
}
