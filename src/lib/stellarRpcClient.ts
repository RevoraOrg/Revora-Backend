/* src/lib/stellarRpcClient.ts */
/**
 * Stellar RPC Client for Soroban Network State Queries with Failover and Circuit Breaker
 *
 * Provides an abstraction layer for querying the Stellar Soroban RPC network
 * to retrieve current ledger information. Implements ordered fallback URLs and a
 * simple per-endpoint circuit breaker to mitigate outage propagation.
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import { classifyStellarRPCFailure } from './stellarRpcFailure';
import { env } from '../config/env';
import { globalMetrics } from './metrics';

// FIX 1: The original file imported `SorobanRpc` from '@stellar/stellar-sdk' which
//         does not exist as a named export — the project uses `StellarSdk.rpc.*`
//         (as seen in stellarSubmissionService.ts). Changed to `import * as StellarSdk`.
//
// FIX 2: The original file imported `STELLAR_HORIZON_URLS` and `STELLAR_HORIZON_URL`
//         as named exports from '../config/env'. Neither exists — env.ts exports a
//         single `env` object. Changed all references to `env.STELLAR_HORIZON_URL`.
//
// FIX 3: Missing closing ')' on `new Promise<never>` inside Promise.race — caused
//         ts(1135) "Argument expression expected" at line 116.

/**
 * Interface for Stellar RPC client operations.
 */
export interface StellarRpcClient {
  /** Retrieves the latest ledger sequence number from the Stellar network */
  getLatestLedger(): Promise<{ sequence: number }>;
  /** Retrieves events from the Stellar network */
  getEvents(request: StellarSdk.rpc.GetEventsRequest): Promise<StellarSdk.rpc.GetEventsResponse>;
  /** Returns the current state of circuit breakers for endpoints */
  getBreakerStates(): Record<string, 'closed' | 'open' | 'half-open'>;
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
  private halfOpenActive = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
  ) {}

  public recordFailure(): void {
    this.failureCount++;
    if (this.halfOpenActive || this.failureCount >= this.threshold) {
      this.openUntil = Date.now() + this.cooldownMs;
      this.halfOpenActive = false;
    }
  }

  public recordSuccess(): void {
    this.failureCount = 0;
    this.openUntil = null;
    this.halfOpenActive = false;
  }

  public isAllowed(): boolean {
    if (this.openUntil === null) {
      if (this.halfOpenActive) {
        return false; // Probe is already active
      }
      return true;
    }
    
    if (Date.now() >= this.openUntil) {
      this.openUntil = null;
      this.halfOpenActive = true;
      return true; // allow one probe
    }
    
    return false;
  }

  public getState(): 'closed' | 'open' | 'half-open' {
    if (this.halfOpenActive) return 'half-open';
    if (this.openUntil !== null && Date.now() < this.openUntil) return 'open';
    return 'closed';
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

    // Use configured URLs or default array from env
    const provided = config.serverUrls;
    if (provided && provided.length > 0) {
      this.endpoints = provided;
    } else {
      this.endpoints = env.STELLAR_HORIZON_URLS_ARRAY;
    }

    this.breakers = new Map();
    for (const ep of this.endpoints) {
      this.breakers.set(ep, new CircuitBreaker(this.failureThreshold, this.cooldownMs));
    }
  }

  // FIX 1: Use StellarSdk.rpc.Server — matches the pattern in stellarSubmissionService.ts.
  private createServer(url: string): StellarSdk.rpc.Server {
    return new StellarSdk.rpc.Server(url, { allowHttp: url.startsWith('http://') });
  }

  public getBreakerStates(): Record<string, 'closed' | 'open' | 'half-open'> {
    const states: Record<string, 'closed' | 'open' | 'half-open'> = {};
    for (const [url, breaker] of this.breakers.entries()) {
      states[url] = breaker.getState();
    }
    return states;
  }

  async getLatestLedger(): Promise<{ sequence: number }> {
    for (let i = 0; i < this.endpoints.length; i++) {
      const endpoint = this.endpoints[i];
      const breaker = this.breakers.get(endpoint)!;

      if (!breaker.isAllowed()) {
        continue;
      }

      const server = this.createServer(endpoint);

      try {
        // FIX 3: Added missing closing ')' for new Promise<never>(...).
        // Original had: new Promise<never>((_, reject) => setTimeout(...), this.timeout),
        // which left the Promise.race array bracket unclosed → ts(1135).
        const response = await Promise.race([
          server.getLatestLedger(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`RPC request timeout after ${this.timeout}ms`)),
              this.timeout,
            ),
          ),
        ]);

        if (!response || typeof response.sequence !== 'number' || response.sequence < 0 || typeof response.id !== 'string' || typeof response.protocolVersion !== 'string') {
          globalMetrics.incrementCounter('ingest.partial.rejected');
          throw new SyntaxError('Invalid response: missing or invalid sequence number or truncated fields');
        }

        breaker.recordSuccess();
        return { sequence: response.sequence };
      } catch (rawError) {
        const failure = classifyStellarRPCFailure(rawError, {
          operation: 'getLatestLedger',
          attemptCount: i + 1,
        });
        breaker.recordFailure();
        if (!failure.shouldRetry) {
          continue;
        }
        continue;
      }
    }

    throw new Error('All Horizon endpoints are unavailable or circuit broken');
  }

  async getEvents(request: StellarSdk.rpc.GetEventsRequest): Promise<StellarSdk.rpc.GetEventsResponse> {
    for (let i = 0; i < this.endpoints.length; i++) {
      const endpoint = this.endpoints[i];
      const breaker = this.breakers.get(endpoint)!;

      if (!breaker.isAllowed()) {
        continue;
      }

      const server = this.createServer(endpoint);

      try {
        const response = await Promise.race([
          server.getEvents(request),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`RPC request timeout after ${this.timeout}ms`)),
              this.timeout,
            ),
          ),
        ]);

        breaker.recordSuccess();
        return response;
      } catch (rawError) {
        const failure = classifyStellarRPCFailure(rawError, {
          operation: 'getEvents',
          attemptCount: i + 1,
        });
        breaker.recordFailure();
        if (!failure.shouldRetry) {
          throw rawError;
        }
        continue;
      }
    }

    throw new Error('All Horizon endpoints are unavailable or circuit broken');
  }
}

/** Factory function */
export function createStellarRpcClient(config?: StellarRpcClientConfig): StellarRpcClient {
  return new StellarRpcClientImpl(config);
}
