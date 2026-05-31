/* src/lib/stellarRpcClient.ts */
/**
 * Stellar RPC Client for Soroban Network State Queries with Failover and Circuit Breaker
 *
 * Provides an abstraction layer for querying the Stellar Soroban RPC network
 * to retrieve current ledger information. Implements ordered fallback URLs and a
 * simple per-endpoint circuit breaker to mitigate outage propagation.
 */

import { SorobanRpc } from '@stellar/stellar-sdk';
import { classifyStellarRPCFailure, StellarRPCFailureClass } from './stellarRpcFailure';
import { STELLAR_HORIZON_URLS, STELLAR_HORIZON_URL } from '../config/env';

/**
 * Interface for Stellar RPC client operations.
 */
export interface StellarRpcClient {
  /** Retrieves the latest ledger sequence number from the Stellar network */
  getLatestLedger(): Promise<{ sequence: number }>;
}

/** Configuration options for the Stellar RPC client */
export interface StellarRpcClientConfig {
  /** Ordered list of Horizon URLs to try. If omitted, defaults to env variables */
  serverUrls?: string[];
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Failure threshold before opening circuit (default 5) */
  failureThreshold?: number;
  /** Cooldown period in ms before closing circuit (default 30000) */
  cooldownMs?: number;
}

/** Simple circuit breaker for an endpoint */
class CircuitBreaker {
  private failureCount = 0;
  private openUntil: number | null = null;
  constructor(private readonly threshold: number, private readonly cooldownMs: number) {}

  /** Record a failure and possibly open the circuit */
  public recordFailure(): void {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.openUntil = Date.now() + this.cooldownMs;
    }
  }

  /** Reset on successful request */
  public recordSuccess(): void {
    this.failureCount = 0;
    this.openUntil = null;
  }

  /** Whether the endpoint is currently closed (usable) */
  public isClosed(): boolean {
    if (this.openUntil === null) return true;
    if (Date.now() >= this.openUntil) {
      // cooldown elapsed, reset
      this.failureCount = 0;
      this.openUntil = null;
      return true;
    }
    return false;
  }
}

/** Production implementation of StellarRpcClient */
export class StellarRpcClientImpl implements StellarRpcClient {
  private readonly timeout: number;
  private readonly endpoints: string[];
  private readonly breakers: Map<string, CircuitBreaker>;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(config: StellarRpcClientConfig = {}) {
    this.timeout = config.timeout ?? 5000;
    this.failureThreshold = config.failureThreshold ?? 5;
    this.cooldownMs = config.cooldownMs ?? 30000;
    // Resolve endpoint list: provided list > env list > single env URL > default
    const provided = config.serverUrls;
    if (provided && provided.length > 0) {
      this.endpoints = provided;
    } else if (STELLAR_HORIZON_URLS && STELLAR_HORIZON_URLS.length > 0) {
      this.endpoints = STELLAR_HORIZON_URLS;
    } else if (STELLAR_HORIZON_URL) {
      this.endpoints = [STELLAR_HORIZON_URL];
    } else {
      this.endpoints = ['https://horizon.stellar.org'];
    }
    this.breakers = new Map();
    for (const ep of this.endpoints) {
      this.breakers.set(ep, new CircuitBreaker(this.failureThreshold, this.cooldownMs));
    }
  }

  /** Helper to create a SorobanRpc.Server for a given URL */
  private createServer(url: string): SorobanRpc.Server {
    return new SorobanRpc.Server(url, { allowHttp: url.startsWith('http://') });
  }

  /** Retrieves the latest ledger with failover and circuit breaker */
  async getLatestLedger(): Promise<{ sequence: number }> {
    const attemptContexts: any[] = [];
    for (let i = 0; i < this.endpoints.length; i++) {
      const endpoint = this.endpoints[i];
      const breaker = this.breakers.get(endpoint)!;
      if (!breaker.isClosed()) {
        // skip open circuit
        continue;
      }
      const server = this.createServer(endpoint);
      try {
        const response = await Promise.race([
          server.getLatestLedger(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`RPC request timeout after ${this.timeout}ms`)), this.timeout),
        ]);
        if (!response || typeof response.sequence !== 'number' || response.sequence < 0) {
          throw new Error('Invalid response: missing or invalid sequence number');
        }
        // success -> reset breaker
        breaker.recordSuccess();
        return { sequence: response.sequence };
      } catch (rawError) {
        // Classify failure
        const failure = classifyStellarRPCFailure(rawError, { operation: 'getLatestLedger', attemptCount: i + 1 });
        // Record failure for circuit breaker
        breaker.recordFailure();
        // If not retryable, continue to next endpoint
        if (!failure.shouldRetry) {
          continue;
        }
        // Otherwise, try next endpoint (if any)
        continue;
      }
    }
    // All endpoints exhausted or failed
    throw new Error('All Horizon endpoints are unavailable or circuit broken');
  }
}

/** Factory function */
export function createStellarRpcClient(config?: StellarRpcClientConfig): StellarRpcClient {
  return new StellarRpcClientImpl(config);
}
