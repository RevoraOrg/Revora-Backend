/**
 * Interfaces and implementations for publishing audit log integrity roots to
 * a public witness.
 */

import crypto from 'crypto';
import { safeFetch, SafeFetchInit, SafeFetchResponse } from '../lib/ssrfProtection';

export interface WitnessReceipt {
  /** The root hash that was published. */
  rootHash: string;
  /** The type of witness (e.g., 'rekor', 'stellar', 'mock'). */
  witnessType: string;
  /** Timestamp of when it was published. */
  publishedAt: Date;
  /** Arbitrary receipt data from the witness service (e.g., transaction ID, log index). */
  receiptData: Record<string, unknown>;
}

export interface WitnessClient {
  /**
   * Publish a root hash to the public witness.
   * @param rootHash The hash to publish.
   * @returns A promise that resolves to the receipt.
   * @throws Error if publishing fails.
   */
  publish(rootHash: string): Promise<WitnessReceipt>;
}

/**
 * A mock witness client for testing and development.
 */
export class MockWitnessClient implements WitnessClient {
  private publishAttempts = 0;
  public simulateFailureAttempts = 0;

  async publish(rootHash: string): Promise<WitnessReceipt> {
    this.publishAttempts++;
    if (this.simulateFailureAttempts > 0) {
      this.simulateFailureAttempts--;
      throw new Error('Mock witness publish failed');
    }

    return {
      rootHash,
      witnessType: 'mock',
      publishedAt: new Date(),
      receiptData: {
        attempt: this.publishAttempts,
        txId: `mock-tx-${Date.now()}`,
      },
    };
  }
}

/** @notice Fetch signature used by RekorWitnessClient; injectable for deterministic tests. */
export type RekorFetch = (url: string, init: SafeFetchInit) => Promise<SafeFetchResponse>;

export interface RekorWitnessClientOptions {
  /** Base URL or full entries endpoint of the Rekor transparency log. */
  url: string;
  /** Outbound fetch implementation. Defaults to the SSRF-protected safeFetch. */
  fetch?: RekorFetch;
  /** Per-attempt timeout in milliseconds. Default: 10000. */
  timeoutMs?: number;
  /** Number of retries after the first attempt. Default: 3. */
  maxRetries?: number;
  /** Exponential backoff base in milliseconds. Default: 250. */
  baseBackoffMs?: number;
}

/**
 * @notice Error thrown by {@link RekorWitnessClient} on an invalid request or response.
 * @dev `retryable` lets {@link AuditWitnessPublisher} distinguish permanent
 *      rejections from transient upstream failures. 4xx and malformed 2xx
 *      responses are not retryable; 5xx, timeouts, and network errors are.
 */
export class RekorWitnessError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'RekorWitnessError';
    Object.setPrototypeOf(this, RekorWitnessError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 250;
const REKOR_ENTRIES_PATH = '/api/v1/log/entries';
const SHA256_HEX = /^[a-f0-9]{64}$/i;

/**
 * @notice Publishes audit root hashes to a Rekor v1 transparency log.
 * @dev Security assumptions:
 *      - Only HTTPS endpoints without embedded credentials are accepted;
 *        all network calls go through SSRF-protected safeFetch in production.
 *      - Each submission is a `rekord` entry whose data bytes are the UTF-8
 *        root hash. A fresh P-256 keypair signs those bytes solely to satisfy
 *        Rekor's signed-entry schema; the ephemeral public key is published
 *        with the entry. It does *not* assert Revora identity or authorship.
 *        The tamper-evidence guarantee comes from Rekor's public, append-only
 *        timestamped record of the hash.
 *      - Root hashes must be lower/upper-case SHA-256 hex, preventing arbitrary
 *        attacker-controlled content from being submitted as an audit root.
 *      - Timeouts abort the in-flight request. HTTP 5xx, timeouts, and network
 *        errors are retried with exponential backoff; 4xx responses fail fast.
 */
export class RekorWitnessClient implements WitnessClient {
  private readonly endpoint: string;
  private readonly fetch: RekorFetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;

  constructor(options: RekorWitnessClientOptions) {
    const parsed = new URL(options.url);
    if (parsed.protocol !== 'https:') {
      throw new RekorWitnessError('WITNESS_REKOR_URL must use HTTPS', false);
    }
    if (parsed.username || parsed.password) {
      throw new RekorWitnessError('WITNESS_REKOR_URL must not contain credentials', false);
    }

    const normalized = parsed.pathname.endsWith(REKOR_ENTRIES_PATH)
      ? parsed.toString()
      : `${parsed.toString().replace(/\/$/, '')}${REKOR_ENTRIES_PATH}`;
    this.endpoint = new URL(normalized).toString();
    this.fetch = options.fetch ?? safeFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  }

  /** @inheritdoc WitnessClient.publish */
  async publish(rootHash: string): Promise<WitnessReceipt> {
    if (typeof rootHash !== 'string' || !SHA256_HEX.test(rootHash)) {
      throw new RekorWitnessError('Invalid root hash: expected 64-character SHA-256 hex string', false);
    }

    const body = this.buildProposedEntry(rootHash);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body,
          signal: controller.signal,
          redirect: 'error',
        });

        if (!response.ok) {
          const error = new RekorWitnessError(
            `Rekor witness request failed with HTTP ${response.status}`,
            isRetryableStatus(response.status),
            response.status,
          );
          if (!error.retryable) throw error;
          lastError = error;
        } else {
          return await this.toReceipt(rootHash, response);
        }
      } catch (error) {
        if (error instanceof RekorWitnessError && !error.retryable) throw error;
        lastError = controller.signal.aborted
          ? new RekorWitnessError('Rekor witness request timed out', true)
          : error;
      } finally {
        clearTimeout(timeout);
      }

      if (attempt < this.maxRetries) {
        await this.backoff(attempt);
      }
    }

    if (lastError instanceof RekorWitnessError) throw lastError;
    throw new RekorWitnessError(
      `Rekor witness publish failed after ${this.maxRetries + 1} attempts: ${errorMessage(lastError)}`,
      true,
    );
  }

  /**
   * @notice Builds a signed Rekor v1 `rekord` proposed entry.
   * @dev The keypair is generated per submission and discarded afterwards. It
   *      only makes the entry verifiable by Rekor; no long-lived signing key
   *      is stored or exposed by this service.
   */
  private buildProposedEntry(rootHash: string): string {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    const data = Buffer.from(rootHash, 'utf8');
    const signingKey = crypto.createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' });
    const signature = crypto.sign('sha256', data, signingKey);

    return JSON.stringify({
      apiVersion: '0.0.1',
      kind: 'rekord',
      spec: {
        data: { content: data.toString('base64') },
        signature: {
          format: 'x509',
          content: signature.toString('base64'),
          publicKey: { content: publicKey.toString('base64') },
        },
      },
    });
  }

  /** @notice Maps Rekor's UUID-keyed response object to a WitnessReceipt. */
  private async toReceipt(rootHash: string, response: SafeFetchResponse): Promise<WitnessReceipt> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RekorWitnessError('Rekor response was not valid JSON', false);
    }

    if (!isRecord(payload)) {
      throw new RekorWitnessError('Rekor response contained no log entries', false);
    }

    const entries = Object.entries(payload);
    if (entries.length === 0) {
      throw new RekorWitnessError('Rekor response contained no log entries', false);
    }

    const headerUuid = parseEtag(response.headers.get('etag'));
    const [firstUuid, firstEntry] = entries[0];
    const uuid = headerUuid && isRecord(payload[headerUuid]) ? headerUuid : firstUuid;
    if (headerUuid && uuid !== headerUuid) {
      throw new RekorWitnessError('Rekor response UUID does not match the log entry', false);
    }
    if (!isRecord(firstEntry)) {
      throw new RekorWitnessError('Rekor log entry was malformed', false);
    }

    const entry = isRecord(payload[uuid]) ? payload[uuid] : firstEntry;
    const { logIndex, integratedTime, logID } = entry;
    if (!Number.isInteger(logIndex) || (logIndex as number) < 0) {
      throw new RekorWitnessError('Rekor response contained an invalid log index', false);
    }
    if (!Number.isInteger(integratedTime) || (integratedTime as number) <= 0) {
      throw new RekorWitnessError('Rekor response contained an invalid integrated time', false);
    }

    const publishedAt = new Date((integratedTime as number) * 1000);
    if (Number.isNaN(publishedAt.getTime())) {
      throw new RekorWitnessError('Rekor response contained an invalid integrated time', false);
    }

    return {
      rootHash,
      witnessType: 'rekor',
      publishedAt,
      receiptData: {
        uuid,
        logIndex: logIndex as number,
        integratedTime: integratedTime as number,
        ...(typeof logID === 'string' ? { logId: logID } : {}),
      },
    };
  }

  private async backoff(attempt: number): Promise<void> {
    if (this.baseBackoffMs <= 0) return;
    const delay = this.baseBackoffMs * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * @notice Chooses the production witness implementation from configuration.
 * @dev An unset URL keeps the mock client so local/test runs never call the
 *      public transparency log by accident.
 */
export function createWitnessClient(url?: string): WitnessClient {
  return url ? new RekorWitnessClient({ url }) : new MockWitnessClient();
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEtag(value: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return normalized || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
