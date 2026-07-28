/**
 * Health endpoint type definitions for the Stellar governance indexer.
 * 
 * This module defines the response structure and dependencies for the enhanced
 * GET /health endpoint that provides comprehensive monitoring metrics including
 * ledger synchronization status, indexed event counts, and degradation detection.
 * 
 * @module types/health
 */

import type { Pool } from 'pg';

/**
 * Health status enum representing the operational state of the indexer.
 * 
 * - "ok": Indexer is operating normally and within acceptable lag thresholds
 * - "degraded": Indexer has fallen behind network tip or encountered errors
 */
export type HealthStatus = "ok" | "degraded";

/**
 * Complete health response structure returned by the GET /health endpoint.
 * 
 * This interface defines all metrics exposed for monitoring indexer operations,
 * including ledger synchronization, event counts, uptime, and error information.
 * 
 * @property status - Current health status ("ok" or "degraded")
 * @property last_indexed_ledger - Most recent ledger sequence successfully processed
 * @property current_ledger - Latest ledger sequence from Stellar network (network tip)
 * @property lag_ledgers - Number of ledgers behind network tip (non-negative)
 * @property lag_seconds - Approximate time behind network tip in seconds (non-negative)
 * @property total_proposals_indexed - Total count of indexed proposal events
 * @property total_votes_indexed - Total count of indexed vote events
 * @property total_delegates_indexed - Total count of indexed delegate events
 * @property uptime_seconds - Duration in seconds since indexer process started
 * @property timestamp - ISO 8601 UTC timestamp when response was generated
 * @property error - Optional error message present only when status is "degraded"
 */
export interface IndexerHealthResponse {
  status: HealthStatus;
  last_indexed_ledger: number;
  current_ledger: number;
  lag_ledgers: number;
  lag_seconds: number;
  total_proposals_indexed: number;
  total_votes_indexed: number;
  total_delegates_indexed: number;
  uptime_seconds: number;
  timestamp: string;
  error?: string;
}

/**
 * Stellar RPC client interface for querying network state.
 * 
 * This abstraction allows for dependency injection and testing without
 * requiring actual network connections to Stellar RPC endpoints.
 */
export interface StellarRpcClient {
  /**
   * Retrieves the latest ledger sequence number from the Stellar network.
   * 
   * @returns Promise resolving to an object containing the current ledger sequence
   * @throws Error if network request fails or times out
   */
  getLatestLedger(): Promise<{ sequence: number }>;
}

/**
 * Dependencies required by the health endpoint handler.
 * 
 * This interface enables dependency injection for testability and allows
 * the handler to access database connections, RPC clients, and configuration.
 * 
 * @property db - PostgreSQL connection pool for querying indexer state and event counts
 * @property rpcClient - Stellar RPC client for retrieving current network ledger
 * @property startTime - Timestamp when the indexer process started (for uptime calculation)
 * @property lagThreshold - Optional maximum acceptable lag in ledgers before status becomes degraded (default: 100)
 */
export interface IndexerHealthDependencies {
  db: Pool;
  rpcClient: StellarRpcClient;
  startTime: Date;
  lagThreshold?: number;
}
