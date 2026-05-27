import { NextFunction, Request, Response, Router } from 'express';
import { Pool } from 'pg';
import { AppError, Errors } from '../lib/errors';
import { MetricsCollector } from '../lib/metrics';
import {
  classifyStellarRPCFailure,
  StellarRPCFailureClass,
} from "../lib/stellarRpcFailure";
import { DbHealthResult, PoolMetrics } from "../db/client";

export type HealthDependency = "database" | "stellar-horizon" | "db-pool";

export type DependencyStatus = "up" | "down" | "degraded" | "unknown";

export interface DependencyHealth {
  name: HealthDependency;
  status: DependencyStatus;
  latencyMs: number;
  healthy: boolean;
  dependsOn?: HealthDependency[];
  details?: Record<string, unknown>;
  error?: string;
}

export interface HealthDependencyGraph {
  status: "healthy" | "degraded" | "unhealthy";
  service: string;
  version: string;
  timestamp: string;
  uptime: number;
  checks: DependencyHealth[];
  requestId?: string;
}

interface QueryableDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

interface DbHealthChecker {
  (): Promise<DbHealthResult>;
}

const HORIZON_TIMEOUT_MS = 5000;
const POOL_HEALTHY_THRESHOLD = 0.8;
const POOL_DEGRADED_THRESHOLD = 0.9;

function getServiceVersion(): string {
  return process.env.npm_package_version ?? "0.1.0";
}

function getUptimeSeconds(): number {
  return Math.floor(process.uptime());
}

function calculatePoolUtilization(pool: PoolMetrics | undefined): number {
  if (!pool || pool.maxConnections === 0) return 0;
  return pool.totalCount / pool.maxConnections;
}

function classifyPoolStatus(pool: PoolMetrics | undefined): DependencyStatus {
  if (!pool) return "unknown";
  const utilization = calculatePoolUtilization(pool);
  if (utilization >= POOL_DEGRADED_THRESHOLD) return "degraded";
  if (utilization >= POOL_HEALTHY_THRESHOLD) return "up";
  return "up";
}

function logHealthCheck(
  level: "info" | "warn" | "error",
  message: string,
  data: Record<string, unknown>,
): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    component: "health",
    message,
    ...data,
  };
  console.log(JSON.stringify(logEntry));
}

/**
 * Indexer process startup timestamp.
 * 
 * This constant records the exact moment when the indexer process started.
 * It is initialized once at module load time and remains constant throughout
 * the process lifetime. Used to calculate uptime_seconds in health checks.
 * 
 * For multi-instance deployments, each instance tracks its own uptime independently.
 * 
 * @example
 * // Process started at 2024-01-15T10:00:00Z
 * INDEXER_START_TIME
 * // Returns: Date object representing startup time
 */
export const INDEXER_START_TIME = new Date();

/**
 * Returns the indexer process startup timestamp.
 * 
 * This function provides access to the module-level INDEXER_START_TIME constant,
 * enabling deterministic testing through dependency injection while maintaining
 * a simple implementation for production use.
 * 
 * @returns Date object representing when the indexer process started
 * 
 * @example
 * // Get startup time
 * const startTime = getIndexerStartTime();
 * // Returns: Date object (e.g., 2024-01-15T10:00:00Z)
 */
export function getIndexerStartTime(): Date {
  return INDEXER_START_TIME;
}

/**
 * Calculates the uptime of the indexer process in seconds.
 * 
 * This function computes the duration between the indexer startup time and
 * the current time, returning the result as a non-negative integer representing
 * seconds. The calculation uses floor division to ensure consistent integer results.
 * 
 * @param startTime - The timestamp when the indexer process started
 * @returns Uptime in seconds (non-negative integer)
 * 
 * @example
 * // Process started 5 minutes ago
 * const startTime = new Date(Date.now() - 5 * 60 * 1000);
 * calculateUptimeSeconds(startTime)
 * // Returns: 300
 * 
 * @example
 * // Process just started
 * const startTime = new Date();
 * calculateUptimeSeconds(startTime)
 * // Returns: 0
 */
export function calculateUptimeSeconds(startTime: Date): number {
  const now = new Date();
  const uptimeMs = now.getTime() - startTime.getTime();
  return Math.floor(uptimeMs / 1000);
}

/**
 * Stellar ledger close time constant in seconds.
 * 
 * The Stellar network produces a new ledger approximately every 5 seconds.
 * This constant is used to convert ledger count lag into approximate time lag.
 */
const STELLAR_LEDGER_CLOSE_TIME_SECONDS = 5;

/**
 * Calculates indexer lag metrics based on current and last indexed ledger sequences.
 * 
 * This function computes how far behind the indexer is from the network tip,
 * both in ledger count and approximate seconds. Negative lag values are clamped
 * to zero to handle edge cases like clock skew or race conditions where the
 * last indexed ledger might temporarily appear ahead of the current ledger.
 * 
 * @param currentLedger - Latest ledger sequence from Stellar network (network tip)
 * @param lastIndexedLedger - Most recent ledger sequence successfully processed by indexer
 * @returns Object containing lag_ledgers (non-negative) and lag_seconds (non-negative)
 * 
 * @example
 * // Indexer is 50 ledgers behind
 * calculateLag(1000, 950)
 * // Returns: { lagLedgers: 50, lagSeconds: 250 }
 * 
 * @example
 * // Indexer is caught up (or ahead due to race condition)
 * calculateLag(1000, 1000)
 * // Returns: { lagLedgers: 0, lagSeconds: 0 }
 * 
 * @example
 * // Negative lag clamped to zero
 * calculateLag(900, 1000)
 * // Returns: { lagLedgers: 0, lagSeconds: 0 }
 */
export function calculateLag(
  currentLedger: number,
  lastIndexedLedger: number,
): {
  lagLedgers: number;
  lagSeconds: number;
} {
  // Prevent negative lag if clock skew or race conditions occur
  const lagLedgers = Math.max(0, currentLedger - lastIndexedLedger);
  const lagSeconds = lagLedgers * STELLAR_LEDGER_CLOSE_TIME_SECONDS;

  return { lagLedgers, lagSeconds };
}

/**
 * Determines the health status of the indexer based on lag and error conditions.
 * 
 * This function evaluates whether the indexer should be considered "ok" or "degraded"
 * by comparing the current lag against a configurable threshold and checking for
 * error conditions. The threshold is read from the HEALTH_LAG_THRESHOLD environment
 * variable with a default of 100 ledgers.
 * 
 * Status determination logic:
 * - If hasErrors is true, status is always "degraded" regardless of lag
 * - If lagLedgers exceeds threshold, status is "degraded"
 * - Otherwise, status is "ok"
 * 
 * @param lagLedgers - Current lag in ledger count (non-negative)
 * @param threshold - Maximum acceptable lag before degradation (default: 100)
 * @param hasErrors - Whether any errors occurred during health check
 * @returns "ok" if indexer is healthy, "degraded" if behind threshold or has errors
 * 
 * @example
 * // Indexer is within threshold and no errors
 * determineHealthStatus(50, 100, false)
 * // Returns: "ok"
 * 
 * @example
 * // Indexer exceeds threshold
 * determineHealthStatus(150, 100, false)
 * // Returns: "degraded"
 * 
 * @example
 * // Errors present, regardless of lag
 * determineHealthStatus(10, 100, true)
 * // Returns: "degraded"
 */
export function determineHealthStatus(
  lagLedgers: number,
  threshold: number,
  hasErrors: boolean,
): "ok" | "degraded" {
  if (hasErrors) return "degraded";
  return lagLedgers <= threshold ? "ok" : "degraded";
}

/**
 * Reads the health lag threshold from environment variable with fallback to default.
 * 
 * The HEALTH_LAG_THRESHOLD environment variable defines the maximum acceptable
 * lag in ledgers before the indexer status becomes "degraded". If not set or
 * invalid, defaults to 100 ledgers.
 * 
 * @returns Lag threshold in ledgers (positive integer, default: 100)
 * 
 * @example
 * // With HEALTH_LAG_THRESHOLD=200
 * getHealthLagThreshold()
 * // Returns: 200
 * 
 * @example
 * // Without HEALTH_LAG_THRESHOLD set
 * getHealthLagThreshold()
 * // Returns: 100
 */
export function getHealthLagThreshold(): number {
  const DEFAULT_THRESHOLD = 100;
  const envValue = process.env.HEALTH_LAG_THRESHOLD;
  
  if (!envValue) {
    return DEFAULT_THRESHOLD;
  }
  
  const parsed = parseInt(envValue, 10);
  
  // Return default if parsing fails or value is not positive
  if (isNaN(parsed) || parsed <= 0) {
    return DEFAULT_THRESHOLD;
  }
  
  return parsed;
}

/**
 * Maps dependency failures into a stable, reviewable API error shape.
 * Raw upstream error messages are intentionally not exposed to clients.
 */
export function mapHealthDependencyFailure(
  dependency: HealthDependency,
  cause: unknown,
): AppError {
  const details: Record<string, unknown> = { dependency };

  if (dependency === "stellar-horizon") {
    const failureClass = classifyStellarRPCFailure(cause, {
      operation: "health-check",
    }).class;
    details.failureClass = failureClass;

    if (typeof cause === "object" && cause !== null) {
      const status = (cause as { status?: unknown }).status;
      if (typeof status === "number") {
        details.upstreamStatus = status;
      }
    }
  }

  return Errors.serviceUnavailable("Dependency unavailable", details);
}

async function checkStellarHorizon(): Promise<DependencyHealth> {
  const start = Date.now();
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HORIZON_TIMEOUT_MS);

    const response = await fetch(horizonUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    const latencyMs = Date.now() - start;

    if (!response.ok) {
      const failureClass = classifyStellarRPCFailure(
        {
          status: response.status,
        },
        { operation: "health-check" },
      ).class;
      logHealthCheck("error", "Stellar Horizon health check failed", {
        dependency: "stellar-horizon",
        status: response.status,
        failureClass,
        latencyMs,
      });

      return {
        name: "stellar-horizon",
        status: "down",
        latencyMs,
        healthy: false,
        dependsOn: [],
        details: {
          failureClass,
          upstreamStatus: response.status,
          url: horizonUrl,
        },
      };
    }

    logHealthCheck("info", "Stellar Horizon health check passed", {
      dependency: "stellar-horizon",
      latencyMs,
      status: response.status,
    });

    return {
      name: "stellar-horizon",
      status: "up",
      latencyMs,
      healthy: true,
      dependsOn: [],
      details: {
        url: horizonUrl,
        statusCode: response.status,
      },
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const failureClass = classifyStellarRPCFailure(error, {
      operation: "health-check",
    }).class;

    logHealthCheck("error", "Stellar Horizon health check error", {
      dependency: "stellar-horizon",
      failureClass,
      latencyMs,
      error: error instanceof Error ? error.name : "Unknown",
    });

    return {
      name: "stellar-horizon",
      status: "down",
      latencyMs,
      healthy: false,
      dependsOn: [],
      details: {
        failureClass,
        url: horizonUrl,
      },
      error:
        failureClass === StellarRPCFailureClass.TIMEOUT
          ? "timeout"
          : "connection_error",
    };
  }
}

async function checkDatabase(
  dbHealth: DbHealthChecker,
): Promise<DependencyHealth> {
  const result = await dbHealth();

  if (result.healthy) {
    const poolStatus = classifyPoolStatus(result.pool);
    const utilization = calculatePoolUtilization(result.pool);

    logHealthCheck("info", "Database health check passed", {
      dependency: "database",
      latencyMs: result.latencyMs,
      poolStatus,
      utilization: Math.round(utilization * 100),
    });

    return {
      name: "database",
      status: poolStatus,
      latencyMs: result.latencyMs,
      healthy: poolStatus !== "down",
      dependsOn: result.pool ? ["db-pool"] : [],
      details: result.pool
        ? {
            ...result.pool,
            utilizationPercent: Math.round(utilization * 100),
          }
        : undefined,
    };
  }

  logHealthCheck("error", "Database health check failed", {
    dependency: "database",
    latencyMs: result.latencyMs,
    error: "sanitized-db-error",
  });

  return {
    name: "database",
    status: "down",
    latencyMs: result.latencyMs,
    healthy: false,
    dependsOn: result.pool ? ["db-pool"] : [],
    error: "sanitized-db-error",
  };
}

function evaluateOverallStatus(
  checks: DependencyHealth[],
): "healthy" | "degraded" | "unhealthy" {
  const hasDown = checks.some((c) => c.status === "down");
  const hasDegraded = checks.some((c) => c.status === "degraded");

  if (hasDown) return "unhealthy";
  if (hasDegraded) return "degraded";
  return "healthy";
}

export const healthRootHandler =
  (dbHealth: DbHealthChecker) =>
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.headers["x-request-id"] as string | undefined;

    try {
      const [dbCheck, stellarCheck] = await Promise.all([
        checkDatabase(dbHealth),
        checkStellarHorizon(),
      ]);

      const checks = [dbCheck, stellarCheck];
      const status = evaluateOverallStatus(checks);

      const response: HealthDependencyGraph = {
        status,
        service: "revora-backend",
        version: getServiceVersion(),
        timestamp: new Date().toISOString(),
        uptime: getUptimeSeconds(),
        checks,
        requestId,
      };

      const statusCode = status === "unhealthy" ? 503 : 200;
      res.status(statusCode).json(response);
    } catch (err) {
      logHealthCheck("error", "Health check failed unexpectedly", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(503).json({
        status: "unhealthy",
        service: "revora-backend",
        version: getServiceVersion(),
        timestamp: new Date().toISOString(),
        uptime: getUptimeSeconds(),
        checks: [],
        requestId,
      });
    }
  };

export const healthLiveHandler =
  () =>
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.headers["x-request-id"] as string | undefined;
    res.status(200).json({
      status: "ok",
      alive: true,
      service: "revora-backend",
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      requestId,
    });
  };

export const healthStartupHandler =
  (dbHealth: DbHealthChecker) =>
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.headers["x-request-id"] as string | undefined;
    const result = await dbHealth();

    if (result.healthy) {
      res.status(200).json({
        status: "ok",
        ready: true,
        service: "revora-backend",
        timestamp: new Date().toISOString(),
        requestId,
        check: "database",
      });
    } else {
      res.status(503).json({
        status: "down",
        ready: false,
        service: "revora-backend",
        timestamp: new Date().toISOString(),
        requestId,
        code: "SERVICE_UNAVAILABLE",
        details: { dependency: "database" },
      });
    }
  };

export const healthReadyHandler =
  (db: QueryableDb, metrics?: MetricsCollector) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const startTime = Date.now();
    const requestId = req.headers["x-request-id"] as string | undefined;

    try {
      // 1. Check Database
      try {
        await db.query("SELECT 1");
        metrics?.incrementCounter("health_checks_total", {
          check: "database",
          status: "success",
        });
      } catch (dbError) {
        if (dbError instanceof AppError) {
          throw dbError;
        }
        metrics?.incrementCounter("health_checks_total", {
          check: "database",
          status: "failure",
        });
        throw mapHealthDependencyFailure("database", dbError);
      }

      // 2. Check Stellar Horizon
      const horizonUrl =
        process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          HORIZON_TIMEOUT_MS,
        );
        const response = await fetch(horizonUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
          metrics?.incrementCounter("health_checks_total", {
            check: "stellar-horizon",
            status: "failure",
          });
          throw mapHealthDependencyFailure("stellar-horizon", {
            status: response.status,
          });
        }
        metrics?.incrementCounter("health_checks_total", {
          check: "stellar-horizon",
          status: "success",
        });
      } catch (stellarError) {
        if (stellarError instanceof AppError) {
          throw stellarError;
        }
        metrics?.incrementCounter("health_checks_total", {
          check: "stellar-horizon",
          status: "failure",
        });
        throw mapHealthDependencyFailure("stellar-horizon", stellarError);
      }

      const duration = Date.now() - startTime;
      metrics?.recordHistogram("health_check_duration_ms", duration, {
        endpoint: "ready",
      });

      res.status(200).json({
        status: "ok",
        ready: true,
        service: "revora-backend",
        db: "up",
        stellar: "up",
        timestamp: new Date().toISOString(),
        requestId,
      });
    } catch (error) {
      next(error);
    }
  };

export const createHealthRouter = (
  db: QueryableDb,
  dbHealth: DbHealthChecker,
  metrics?: MetricsCollector,
): Router => {
  const router = Router();
  router.get("/", healthRootHandler(dbHealth));
  router.get("/live", healthLiveHandler());
  router.get("/ready", healthReadyHandler(db, metrics));
  router.get("/startup", healthStartupHandler(dbHealth));
  return router;
};

export default createHealthRouter;
